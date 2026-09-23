/* ============================================================================
 * collector-page —— 主试端回收器的界面逻辑（浏览器）
 * 依赖（由 build-collector.js 内联）: jsQR（解码）、pako（gunzip）、CollectorCore（解析/重组）
 * ----------------------------------------------------------------------------
 * 关键实现约束（预判并已写进代码）：
 *   在 file:// 下，若直接用 file:// 路径加载图片再画进 canvas，
 *   画布会被标记为跨源，getImageData 会抛安全异常。
 *   因此本页面**只接受 File 对象**（拖拽 / 选择文件 / 剪贴板粘贴），
 *   用 URL.createObjectURL 得到同源 URL —— 画布不会被污染。
 * ========================================================================== */
(function () {
  'use strict';

  var STORE_KEY = 'psyweb.collected.v1';
  var collected = [];          // [{ id, participant, rows, cols, csv, at }]
  var pendingFrames = [];      // 所有已解码帧文本

  var $ = function (sel) { return document.querySelector(sel); };
  var el = function (tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text !== undefined) n.textContent = text;
    return n;
  };

  function log(msg, cls) {
    var line = el('div', { class: 'log ' + (cls || '') }, msg);
    $('#log').appendChild(line);
    $('#log').scrollTop = $('#log').scrollHeight;
  }

  function loadStore() {
    try { collected = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); }
    catch (e) { collected = []; }
  }
  function saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(collected)); }
    catch (e) { log('⚠️ 本地存储不可用（数据仍在内存里，请及时导出）', 'warn'); }
  }

  // ---------------------------------------------------------------- 解码
  function decodeFile(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var cv = document.createElement('canvas');
          cv.width = img.naturalWidth; cv.height = img.naturalHeight;
          var ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0);
          var d = ctx.getImageData(0, 0, cv.width, cv.height);
          var res = window.jsQR(d.data, cv.width, cv.height, { inversionAttempts: 'attemptBoth' });
          resolve({ file: file.name, w: cv.width, h: cv.height, text: res ? res.data : null });
        } catch (e) {
          resolve({ file: file.name, error: e.message });
        } finally { URL.revokeObjectURL(url); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve({ file: file.name, error: '图片无法加载' }); };
      img.src = url;
    });
  }

  async function handleFiles(files) {
    var arr = Array.prototype.slice.call(files).filter(function (f) { return /^image\//.test(f.type); });
    if (!arr.length) { log('⚠️ 没有可识别的图片文件', 'warn'); return; }
    log('开始处理 ' + arr.length + ' 张图片…');
    for (var i = 0; i < arr.length; i++) {
      var r = await decodeFile(arr[i]);
      if (r.error) { log('  ❌ ' + r.file + '：' + r.error, 'bad'); continue; }
      if (!r.text) { log('  ⚠️ ' + r.file + '（' + r.w + '×' + r.h + '）：没扫出二维码（试试原图 / 放大后重截）', 'warn'); continue; }
      var f = window.CollectorCore.parseFrame(r.text);
      if (!f) { log('  ⚠️ ' + r.file + '：扫出的内容不是 psyweb 数据帧，已忽略', 'warn'); continue; }
      pendingFrames.push(r.text);
      log('  ✅ ' + r.file + '：第 ' + f.index + '/' + f.total + ' 张（数据集 ' + f.datasetId + '）', 'ok');
    }
    refreshGroups();
  }

  // ---------------------------------------------------------------- 分组与入库
  function refreshGroups() {
    var g = window.CollectorCore.groupFrames(pendingFrames);
    var box = $('#groups');
    box.innerHTML = '';
    var ids = Object.keys(g.groups);
    if (!ids.length) { box.appendChild(el('div', { class: 'muted' }, '还没有任何分片。')); return; }

    ids.forEach(function (id) {
      var grp = g.groups[id];
      var st = window.CollectorCore.groupStatus(grp);
      var row = el('div', { class: 'group' });
      row.appendChild(el('span', { class: 'badge ' + (st.complete ? 'ok' : 'warn') },
        st.complete ? '完整' : ('缺 ' + st.missing.join(','))));
      row.appendChild(el('span', null, ' 数据集 ' + id + ' · ' + st.have + '/' + st.total + ' 张'));

      if (st.complete) {
        var btn = el('button', null, '入库');
        btn.onclick = function () {
          try {
            var out = window.CollectorCore.assemble(grp,
              function (u8) { return window.pako.ungzip(u8); },
              function (s) { return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), function (c) { return c.charCodeAt(0); }); });
            var pid = window.CollectorCore.peekParticipant(out.csv);
            var rows = window.CollectorCore.countRows(out.csv);
            if (collected.some(function (c) { return c.id === id; })) { log('⚠️ 数据集 ' + id + ' 已在列表中', 'warn'); return; }
            collected.push({ id: id, participant: pid, rows: rows, cols: out.csv.split(/\r?\n/)[0].split(',').length, csv: out.csv, at: new Date().toLocaleString() });
            saveStore(); renderCollected();
            log('✅ 入库：被试 ' + pid + '（' + rows + ' 行）', 'ok');
          } catch (e) { log('❌ 入库失败：' + e.message, 'bad'); }
        };
        row.appendChild(btn);
      }
      box.appendChild(row);
    });

    if (g.invalid.length) box.appendChild(el('div', { class: 'muted' }, '（有 ' + g.invalid.length + ' 个无法识别的帧）'));
  }

  function renderCollected() {
    var tbody = $('#tbody');
    tbody.innerHTML = '';
    collected.forEach(function (c, i) {
      var tr = document.createElement('tr');
      [c.participant, String(c.rows), String(c.cols), c.at, ''].forEach(function (v, k) {
        var td = el('td', null, v);
        if (k === 4) {
          var a = el('a', { href: '#' }, '下载');
          a.onclick = function (e) { e.preventDefault(); download(c.csv, 'psyweb_' + c.participant + '.csv'); };
          td.appendChild(a);
          var d = el('a', { href: '#', style: 'margin-left:8px' }, '删除');
          d.onclick = function (e) { e.preventDefault(); collected.splice(i, 1); saveStore(); renderCollected(); };
          td.appendChild(d);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    $('#count').textContent = collected.length + ' 名被试 / 共 ' + collected.reduce(function (a, c) { return a + c.rows; }, 0) + ' 行';
  }

  function download(text, name) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
  }

  // ---------------------------------------------------------------- 事件绑定
  function init() {
    loadStore(); renderCollected(); refreshGroups();

    var drop = $('#drop');
    ['dragenter', 'dragover'].forEach(function (e) {
      drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.add('hot'); });
    });
    ['dragleave', 'drop'].forEach(function (e) {
      drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.remove('hot'); });
    });
    drop.addEventListener('drop', function (ev) { handleFiles(ev.dataTransfer.files); });

    $('#file').addEventListener('change', function (ev) { handleFiles(ev.target.files); ev.target.value = ''; });

    // 直接粘贴截图（Ctrl+V）—— 主试最顺手的路径
    document.addEventListener('paste', function (ev) {
      var items = (ev.clipboardData && ev.clipboardData.items) || [];
      var files = [];
      for (var i = 0; i < items.length; i++) if (items[i].kind === 'file') files.push(items[i].getAsFile());
      if (files.length) { ev.preventDefault(); handleFiles(files); }
    });

    $('#merge').onclick = function () {
      if (!collected.length) { log('⚠️ 列表为空', 'warn'); return; }
      var m = window.CollectorCore.mergeCsvs(collected.map(function (c) { return c.csv; }));
      if (m.warn) log('⚠️ ' + m.warn, 'warn');
      download(m.csv, 'psyweb_merged_' + collected.length + 'subs.csv');
      log('✅ 已导出合并 CSV：' + collected.length + ' 名被试 / ' + m.rows + ' 行 / ' + m.columns + ' 列', 'ok');
    };
    $('#clear').onclick = function () {
      if (!confirm('清空已入库的 ' + collected.length + ' 名被试数据？（内存与本地存储都会清）')) return;
      collected = []; pendingFrames = []; saveStore(); renderCollected(); refreshGroups();
      log('已清空');
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
