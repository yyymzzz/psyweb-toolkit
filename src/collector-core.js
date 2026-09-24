/* ============================================================================
 * collector-core —— 二维码数据帧的解析 / 分组 / 重组（单一真相源）
 * ----------------------------------------------------------------------------
 * 为什么要有这个文件：同一套逻辑必须同时被
 *   ① 主试端回收器（浏览器，site/collector.html）
 *   ② 自动验证脚本（Node，spike/m0/src/verify-qr-roundtrip.js）
 * 使用 —— 否则"验证通过"和"实际能用"就是两套代码，验证没有意义。
 *
 * 分帧格式：
 *   新版  PSYWEB2:<datasetId>:<i>/<n>:<base64url(gzip(csv))>
 *   旧版  PSYWEB:<i>/<n>:<base64url(gzip(csv))>          （兼容 P2 穿刺产物）
 * 为什么要 datasetId：主试会把**多个被试**的二维码混在一起拖进来，
 *   只靠 i/n 无法区分属于谁的数据集，会把不同人的分片拼在一起
 *   （gzip 有 CRC 会报错，但那是"炸给你看"，不如一开始就不混）。
 *   id 取载荷前 8 个字符 —— 天然唯一、零成本、无需额外哈希。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CollectorCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ⚠️ datasetId 的字符集必须是 **base64url**（A-Za-z0-9-_）。
  // 我第一版写成了 [0-9a-f]（想当然当成十六进制哈希），而 id 实际取自载荷的 base64url 前缀，
  // 于是真实数据里只要出现大写字母或 -/_ 就整条帧解析失败。
  // 更阴的是：自检用的合成 id 'abcd1234' 恰好落在小写十六进制里，自检全绿 —— 合成数据的偏差。
  var FRAME_RE = /^(PSYWEB2?):([A-Za-z0-9_-]{0,24}):?(\d+)\/(\d+):([\s\S]*)$/;

  /** 解析单帧文本；不是本协议的返回 null */
  function parseFrame(text) {
    if (typeof text !== 'string') return null;
    var m = text.match(FRAME_RE);
    if (!m) return null;
    var legacy = (m[1] === 'PSYWEB');
    return {
      version: legacy ? 1 : 2,
      datasetId: legacy ? 'legacy' : (m[2] || 'unknown'),
      index: parseInt(m[3], 10),
      total: parseInt(m[4], 10),
      payload: m[5]
    };
  }

  /** 把一组帧按 datasetId 分组（同 id 的 index 去重，后到者覆盖） */
  function groupFrames(texts) {
    var groups = {};
    var invalid = [];
    (texts || []).forEach(function (t, i) {
      var f = parseFrame(t);
      if (!f) { invalid.push({ at: i, preview: String(t).slice(0, 60) }); return; }
      var g = groups[f.datasetId];
      if (!g) { g = groups[f.datasetId] = { datasetId: f.datasetId, version: f.version, total: f.total, parts: {}, count: 0 }; }
      g.total = Math.max(g.total, f.total);
      if (g.parts[f.index] === undefined) g.count++;
      else g.duplicate = true;
      g.parts[f.index] = f.payload;
    });
    return { groups: groups, invalid: invalid };
  }

  /** 某组是否完整（1..total 全部到齐） */
  function groupStatus(g) {
    var missing = [];
    for (var i = 1; i <= g.total; i++) if (g.parts[i] === undefined) missing.push(i);
    return { complete: missing.length === 0, missing: missing, have: g.count, total: g.total };
  }

  /**
   * 重组一台数据集。
   * @param g 分组对象
   * @param gunzip Uint8Array -> Uint8Array（浏览器传 pako.ungzip，Node 传 zlib.gunzipSync）
   * @param b64ToBytes base64url 字符串 -> Uint8Array
   * @returns {csv}
   */
  function assemble(g, gunzip, b64ToBytes) {
    var st = groupStatus(g);
    if (!st.complete) throw new Error('分片不完整：缺第 ' + st.missing.join(',') + ' 张（共 ' + st.total + ' 张）');
    var parts = [];
    for (var i = 1; i <= g.total; i++) parts.push(g.parts[i]);
    var payload = parts.join('');
    if (payload.indexOf('PSYWEB1:') !== 0) throw new Error('载荷头不合法：' + payload.slice(0, 16));
    var bytes = b64ToBytes(payload.slice('PSYWEB1:'.length));
    var out = gunzip(bytes);
    var csv = (typeof out === 'string') ? out : new TextDecoder('utf-8').decode(out);
    return { csv: csv, payloadBytes: payload.length };
  }

  /** 从 CSV 里取被试标识（用于回收器列表显示 / 合并去重） */
  function peekParticipant(csv) {
    try {
      var lines = csv.split(/\r?\n/);
      var head = lines[0].split(',');
      var idx = head.indexOf('participant');
      if (idx < 0 || lines.length < 2) return '(未知)';
      var row = lines[1].split(',');
      return (row[idx] || '(空)').replace(/^["']|["']$/g, '');
    } catch (e) { return '(未知)'; }
  }

  function countRows(csv) {
    if (!csv) return 0;
    var n = csv.split(/\r?\n/).filter(function (l) { return l.length > 0; }).length;
    return Math.max(0, n - 1);   // 去掉表头
  }

  /** 合并多份 CSV（按表头并集，保持列顺序稳定） */
  function mergeCsvs(csvs) {
    var cols = [], rows = [];
    csvs.forEach(function (csv) {
      var lines = csv.split(/\r?\n/).filter(function (l) { return l.length > 0; });
      if (!lines.length) return;
      var head = lines[0].split(',');
      head.forEach(function (h) { if (cols.indexOf(h) === -1) cols.push(h); });
      for (var i = 1; i < lines.length; i++) rows.push(lines[i]);
    });
    // 注意：这里只做"表头并集"，不做逐字段重排 —— 各被试列序一致时结果正确；
    // 不一致时下方的列数校验会给出告警（宁可提示，也不静默错位）。
    var warn = null;
    csvs.forEach(function (csv, i) {
      var h = (csv.split(/\r?\n/)[0] || '');
      if (h.split(',').length !== cols.length && !warn) {
        warn = '第 ' + (i + 1) + ' 份数据的列序与并集不一致，合并结果可能错位；建议分别导出后手动核对。';
      }
    });
    return { csv: [cols.join(',')].concat(rows).join('\r\n'), columns: cols.length, rows: rows.length, warn: warn };
  }

  return { parseFrame: parseFrame, groupFrames: groupFrames, groupStatus: groupStatus,
           assemble: assemble, peekParticipant: peekParticipant, countRows: countRows, mergeCsvs: mergeCsvs };
});
