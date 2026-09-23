/* ============================================================================
 * psyweb shim · psychojs 2026 版
 * ----------------------------------------------------------------------------
 * 与 2020.2 版的差异（全部来自对本仓库 vendor/psychojs-2026.2.3.iife.js 的实测）：
 *   1. 下载钩子改名为 `_downloadResources(resources)`（2020.2 是 _downloadRegisteredResources）
 *   2. 资源条目多了 `status` 字段：getResource(name, true) 会检查
 *      `resource.status === ResourceStatus.DOWNLOADED`，不设就抛错
 *      （ResourceStatus = {ERROR,REGISTERED,DOWNLOADING,DOWNLOADED}，值是 Symbol.for(...)，
 *        因此无需引用被 minify 的类，用 Symbol.for 重建即可对上）
 *   3. 条件资源会被 `new Uint8Array(resourceValue)` 处理 → 必须给 ArrayBuffer/Uint8Array，给字符串会变空数组
 *   4. 图片资源仍要求 `image instanceof HTMLImageElement` → 用 new Image() + data URI
 *   5. 新增 `waitForResources` 组件（本实验的生成代码没用到，但别的实验可能用）
 * ========================================================================== */
(function (global) {
  'use strict';
  var S = function (k) { return Symbol.for(k); };

  /* ------------------------------------------------------------------ *
   * legacy 全局名补齐（实测发现，2026 导出物的一个真缺口）
   * ------------------------------------------------------------------
   * psychojs-2026.2.3.iife.js 结尾是 `return src_exports; })();` —— 它把
   * core/data/hardware/sound/util/visual 全塞进 `window.PsychoJS` 命名空间，
   * 只额外挂了 `window.Scheduler`，**没有**挂 legacy 脚本裸引用的
   * util / core / visual / sound / data / TrialHandler。
   * 于是官方 index.html 那样直接配对（iife + *-legacy-browsers.js）会在第一行
   * 就 `ReferenceError: util is not defined`（实测：实验脚本第 12 行
   * `let PILOTING = util.getUrlParameters().has('__pilotToken');`）。
   * 这里补上这层胶水 —— 便携包必须自己带。
   * ------------------------------------------------------------------ */
  (function installLegacyGlobals() {
    var P = global.PsychoJS;
    var installed = [], skipped = [];
    if (!P || typeof P !== 'object') {
      console.error('[psyweb] 未找到 PsychoJS 命名空间，legacy 全局无法补齐');
      return;
    }
    // 强制覆盖名单：这些名字浏览器/宿主已经占用，但 legacy 脚本要的是 psychoJS 的实现。
    // 实测踩到 window.Scheduler 是浏览器 Prioritized Task Scheduling API，
    // 它是"不可 new 的接口对象"，导致 `new Scheduler(psychoJS)`
    // 抛 "Failed to construct 'Scheduler': Illegal constructor"。
    var FORCE = ['Scheduler'];

    // 不是打地鼠：把命名空间里**所有**导出名都枚举出来装上。
    // （实测依次缺过 util/core/visual/sound/data → TrialHandler → MultiStairHandler，
    //   逐个补等于反复试错，一次枚举到底。）
    var nsList = ['core', 'data', 'hardware', 'sound', 'util', 'visual'];
    var inventory = {};
    nsList.forEach(function (ns) {
      var obj = P[ns];
      if (!obj || typeof obj !== 'object') return;
      var names = Object.keys(obj);
      inventory[ns] = names.length;
      names.forEach(function (k) {
        if (!/^[A-Za-z_$][\w$]*$/.test(k)) return;          // 跳过非法标识符
        if (k === '__esModule' || k === 'default') return;
        var exists = typeof global[k] !== 'undefined';
        if (!exists || FORCE.indexOf(k) > -1) {
          global[k] = obj[k];
          installed.push(ns + '.' + k + (exists ? '(覆盖)' : ''));
        } else {
          skipped.push(ns + '.' + k);
        }
      });
    });
    // 命名空间本身也要挂（legacy 脚本里可能有 PsychoJS.core.xxx 之类写法）
    nsList.forEach(function (ns) { if (P[ns] && typeof global[ns] === 'undefined') global[ns] = P[ns]; });

    global.__PSYWEB_LEGACY_GLOBALS__ = installed;
    console.log('[psyweb] 命名空间清单: ' + nsList.map(function (n) { return n + '(' + (inventory[n] || 0) + ')'; }).join(' '));
    console.log('[psyweb] 已安装 legacy 全局 ' + installed.length + ' 个: ' + installed.join(', '));
    if (skipped.length) console.log('[psyweb] 跳过（已存在同名全局）: ' + skipped.join(', '));

    // window.PsychoJS 是**命名空间对象**，而 legacy 脚本执行的是 `new PsychoJS({...})`
    // —— 需要的是**构造函数**（实测报错 TypeError: PsychoJS is not a constructor）。
    if (typeof P !== 'function') {
      var candidates = [['core.PsychoJS', P.core && P.core.PsychoJS],
                        ['PsychoJS.PsychoJS', P.PsychoJS],
                        ['util.PsychoJS', P.util && P.util.PsychoJS]];
      var found = candidates.filter(function (c) { return typeof c[1] === 'function'; })[0];
      global.__PSYWEB_PSYCHOJS_NS__ = P;
      if (found) {
        global.PsychoJS = found[1];
        console.log('[psyweb] PsychoJS 构造函数取自: ' + found[0]);
      } else {
        console.error('[psyweb] 找不到 PsychoJS 构造函数，候选: ' +
          candidates.map(function (c) { return c[0] + '=' + typeof c[1]; }).join(', '));
      }
    }
  })();

  function loadImage(uri) {
    return new Promise(function (resolve, reject) {
      var img = new global.Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('图片解码失败')); };
      img.src = uri;
    });
  }
  function loadBinary(uri) { return global.fetch(uri).then(function (r) { return r.arrayBuffer(); }); }
  function loadText(uri) { return global.fetch(uri).then(function (r) { return r.text(); }); }

  /** 按 spec.type 解出 psychojs 认得的数据形态 */
  global.psywebLoadResource = function (name, spec) {
    var p;
    if (spec.type === 'image') p = loadImage(spec.data);
    else if (spec.type === 'binary') p = loadBinary(spec.data);
    else p = loadText(spec.data);
    return p.then(function (data) {
      var info = (data && data.width) ? (' ' + data.width + 'x' + data.height + 'px')
        : (data && data.byteLength) ? (' ' + data.byteLength + ' B') : '';
      console.log('[psyweb] 内联资源解码成功: ' + name + info);
      return data;
    }).catch(function (e) {
      console.error('[psyweb] 内联资源解码失败: ' + name + ' -> ' + (e && e.message));
      return spec.fallback !== undefined ? spec.fallback : null;
    });
  };

  /**
   * 给 psychoJS 实例装上"内联资源"能力。
   * 必须在 new PsychoJS(...) 之后、psychoJS.start(...) 之前调用。
   */
  /* ------------------------------------------------------------------ *
   * M3 加固：① WebGL 探测 ② ▶ 点击开始页（用户手势→全屏 + 知情同意）
   *         ③ 中途关闭/崩溃的自动存盘与恢复
   * ------------------------------------------------------------------ */
  global.psywebHasWebGL = function () {
    try {
      var c = global.document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'));
    } catch (e) { return false; }
  };

  var AUTOSAVE_KEY = 'psyweb.autosave.v1';

  function readAutosave() {
    try {
      var raw = global.localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.rows || !o.rows.length) return null;
      return o;
    } catch (e) { return null; }
  }

  global.psywebInstallStartGate = function (psychoJS, meta) {
    meta = meta || {};
    global.PSYWEB_STARTED = false;

    // ---- 自动存盘：每隔几秒把已产生的数据落到 localStorage ----
    // 便携包没有服务器兜底，被试中途关页面/浏览器崩了，数据就没了。
    global.setInterval(function () {
      try {
        var rows = global.psywebCollectRows(psychoJS);
        if (rows.length) {
          global.localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({
            at: Date.now(), expName: meta.expName || '', rows: rows
          }));
        }
      } catch (e) { /* 隐私模式等场景下 localStorage 不可用，忽略 */ }
    }, 5000);

    var webgl = global.psywebHasWebGL();
    var prev = readAutosave();

    var gate = global.document.createElement('div');
    gate.id = 'psyweb-gate';
    gate.setAttribute('style', [
      'position:fixed;inset:0;z-index:99997;background:#12141a;color:#e8eaef',
      'font:15px/1.7 system-ui,"Microsoft YaHei",sans-serif;overflow:auto',
      'display:flex;align-items:center;justify-content:center;padding:24px'
    ].join(';'));

    var card = '<div style="max-width:620px;width:100%">' +
      '<div style="font-size:24px;font-weight:700;margin-bottom:6px">' + (meta.title || '在线实验') + '</div>' +
      '<div style="color:#9aa3b2;margin-bottom:18px">开始前请确认下面几件事</div>' +

      '<div style="background:#1c1f28;border-radius:12px;padding:16px 18px;margin-bottom:14px">' +
      '<div style="margin-bottom:8px"><b>设备</b>：请用<b>电脑</b>完成（本实验需要键盘/鼠标；手机和平板无法完成）</div>' +
      '<div style="margin-bottom:8px"><b>环境</b>：安静、不被打扰；建议戴上耳机</div>' +
      '<div style="margin-bottom:8px"><b>显示</b>：点击开始后会进入<b>全屏</b>，中途请不要切换窗口</div>' +
      '<div><b>显示引擎</b>：' + (webgl
        ? '<span style="color:#4ade80">已检测到 WebGL，可以开始</span>'
        : '<span style="color:#f87171">未检测到 WebGL，本实验无法运行</span>' +
          '<div style="color:#9aa3b2;font-size:13px;margin-top:4px">' +
          '请换用较新的 Chrome / Edge；若已是最新版本，请在浏览器设置里打开「使用硬件加速」后重启浏览器。</div>') + '</div>' +
      '</div>' +

      '<div style="background:#1c1f28;border-radius:12px;padding:16px 18px;margin-bottom:14px">' +
      '<div style="font-weight:700;margin-bottom:6px">知情同意</div>' +
      '<div style="color:#c3c9d4;font-size:14px">' +
      '本实验仅用于学术研究，<b>不收集姓名等可识别身份的信息</b>；' +
      '你的作答数据会以匿名编号形式记录，仅保存在实验者本地。' +
      '参与完全<b>自愿</b>，你可以在任何时刻关闭页面退出，不会有任何不利后果。' +
      '点击「开始」即表示你已理解并同意参与。</div>' +
      '</div>' +

      (prev ? '<div style="background:#2a2416;border:1px solid #6b5520;border-radius:12px;padding:12px 16px;margin-bottom:14px">' +
        '<div style="color:#fbbf24">发现上次运行留下的数据（' + prev.rows.length + ' 行，' +
        new Date(prev.at).toLocaleString() + '）。</div>' +
        '<div style="color:#c3c9d4;font-size:13px;margin-top:4px">' +
        '如果那次是正常做完并已经导出过的，可以直接忽略；如果中途异常退出（关页面/崩溃），可点下面下载。</div>' +
        '<button id="psyweb-recover" style="margin-top:8px;font:inherit;padding:7px 14px;border:0;border-radius:8px;background:#4b5563;color:#fff;cursor:pointer">下载上次的数据</button>' +
        '</div>' : '') +

      '<button id="psyweb-start" ' + (webgl ? '' : 'disabled ') +
      'style="font:inherit;font-size:17px;padding:13px 34px;border:0;border-radius:10px;' +
      'background:' + (webgl ? '#2f6fed' : '#3a3f4b') + ';color:#fff;cursor:' + (webgl ? 'pointer' : 'not-allowed') + '">▶ 点击开始</button>' +
      '<div style="color:#6b7280;font-size:12px;margin-top:10px">开始后请不要刷新或关闭页面；数据会在结束时自动导出。</div>' +
      '</div>';

    gate.innerHTML = card;
    global.document.body.appendChild(gate);

    if (prev) {
      var rb = global.document.getElementById('psyweb-recover');
      if (rb) rb.onclick = function () {
        global.psywebDownloadCsv(global.psywebToCsv(prev.rows), prev.rows);
      };
    }

    var btn = global.document.getElementById('psyweb-start');
    if (btn && webgl) {
      btn.onclick = function () {
        // 全屏必须在用户手势里发起 —— 这正是"双击打开本地 html"缺失的那一环
        try {
          var el = global.document.documentElement;
          var p = el.requestFullscreen && el.requestFullscreen();
          if (p && p.catch) p.catch(function () { /* 用户或浏览器拒绝，继续跑 */ });
        } catch (e) {}
        try { global.localStorage.removeItem(AUTOSAVE_KEY); } catch (e) {}
        gate.remove();
        global.PSYWEB_STARTED = true;
        console.log('[psyweb] 被试已点击开始（手势已满足，全屏请求已发出）');
      };
    }

    // 自测模式：自动进入，免得无头环境卡在开始页
    if (global.PSYWEB_AUTOTEST && webgl) {
      gate.remove();
      global.PSYWEB_STARTED = true;
      console.log('[psyweb] autotest：跳过开始页');
    }
    return { webgl: webgl, hadRecoverable: !!prev };
  };

  global.psywebInstallInlineResources = function (psychoJS, map) {
    global.__PSYWEB_PJS__ = psychoJS;      // 留一个引用，便于诊断与自动化检查
    var sm = psychoJS.serverManager;
    var ready = Promise.all(Object.keys(map).map(function (name) {
      return global.psywebLoadResource(name, map[name]).then(function (data) {
        return { name: name, data: data };
      });
    }));

    sm._downloadResources = function () {
      var self = this;
      return ready.then(function (loaded) {
        var filled = 0;
        loaded.forEach(function (r) {
          var entry = self._resources.get(r.name);
          if (!entry) { console.warn('[psyweb] 实验未声明该资源，跳过: ' + r.name); return; }
          entry.data = r.data;
          entry.status = S('DOWNLOADED');
          filled++;
        });
        // 兜底：任何仍未标记完成的资源（例如指向远端 URL 的默认图）也标记完成，
        // 否则 waitForResources 门禁会永久挂起。
        self._resources.forEach(function (entry, name) {
          if (entry.status !== S('DOWNLOADED')) {
            console.warn('[psyweb] 资源未内联，标记为空完成: ' + name);
            entry.data = entry.data === undefined ? '' : entry.data;
            entry.status = S('DOWNLOADED');
          }
        });
        try { self.setStatus(S('READY')); } catch (e) { /* 状态枚举不可用时忽略 */ }
        self.emit(S('RESOURCE'), { message: S('DOWNLOAD_COMPLETED') });
        global.PSYWEB_RESOURCES_READY = true;
        console.log('[psyweb] 已跳过网络下载：内联资源 ' + filled + ' 个，全部标记 DOWNLOADED');
        return true;
      }).catch(function (e) {
        console.error('[psyweb] 资源改道异常（已兜底）: ' + (e && e.stack || e));
        try { self.setStatus(S('READY')); } catch (e2) {}
        self.emit(S('RESOURCE'), { message: S('DOWNLOAD_COMPLETED') });
        global.PSYWEB_RESOURCES_READY = true;
        return false;
      });
    };
    return psychoJS;
  };

  /* ---------------- 数据出口（与 2020 版一致的三通道） ---------------- */
  function csvCell(v) {
    if (v === undefined || v === null) return '';
    var s = (typeof v === 'object') ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  global.psywebToCsv = function (rows) {
    if (!rows || !rows.length) return '';
    var cols = [];
    rows.forEach(function (r) { Object.keys(r).forEach(function (k) { if (cols.indexOf(k) === -1) cols.push(k); }); });
    return [cols.join(',')].concat(rows.map(function (r) {
      return cols.map(function (c) { return csvCell(r[c]); }).join(',');
    })).join('\r\n');
  };

  global.psywebCollectRows = function (psychoJS) {
    var ex = psychoJS && psychoJS.experiment;
    if (!ex) return [];
    return ex._trialsData || ex._data || ex.entries || [];
  };

  /* ---------------- 三通道数据出口 ----------------
   * ① 结果摘要（截图友好）② 下载 CSV ③ 数据二维码（截图回传）
   * 二维码生产规则来自 M0-P2 实测矩阵：单片 ≤660 B、纠错 M、版本 ≤20 → 压缩通道全数通过。
   * ------------------------------------------------- */
  global.psywebB64url = function (u8) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  /** CSV → 分帧二维码载荷
   *  格式 PSYWEB2:<datasetId>:<i>/<n>:<payload>
   *  datasetId 取载荷前 8 字符：主试会把多个被试的截图混在一起，
   *  没有 id 就无法区分谁的分片（见 src/collector-core.js 的说明）。 */
  global.psywebBuildQrFrames = function (csv, chunkSize) {
    var CH = chunkSize || 660;
    var bytes = new TextEncoder().encode(csv);
    var gz = global.pako.gzip(bytes, { level: 9 });
    var payload = 'PSYWEB1:' + global.psywebB64url(gz);
    var id = payload.slice('PSYWEB1:'.length, 'PSYWEB1:'.length + 8);
    var chunks = [];
    for (var i = 0; i < payload.length; i += CH) chunks.push(payload.slice(i, i + CH));
    var n = chunks.length;
    return chunks.map(function (c, idx) { return 'PSYWEB2:' + id + ':' + (idx + 1) + '/' + n + ':' + c; });
  };

  function makeQr(text) {
    // qrcode-generator：typeNumber 1..40，自动挑最小的能装下的版本
    for (var t = 1; t <= 40; t++) {
      try {
        var qr = global.qrcode(t, 'M');
        qr.addData(text);
        qr.make();
        return qr;
      } catch (e) { /* 装不下，换大一号 */ }
    }
    return null;
  }

  /** 用 canvas 把二维码画成 PNG data URL。
   *  不用 qrcode-generator 自带的 createDataURL()：它产出的是 **GIF**（实测
   *  `data:image/gif;base64,R0lGOD…`），既不便校验也不便主试端统一按 PNG 处理。 */
  function qrToPngDataUrl(qr, cell, margin) {
    var count = qr.getModuleCount();
    var size = count * cell + margin * 2;
    var cv = global.document.createElement('canvas');
    cv.width = size; cv.height = size;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (var r = 0; r < count; r++) {
      for (var c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(margin + c * cell, margin + r * cell, cell, cell);
      }
    }
    return { url: cv.toDataURL('image/png'), size: size, modules: count };
  }

  global.psywebShowResults = function (psychoJS, reason) {
    var rows = global.psywebCollectRows(psychoJS);
    var csv = global.psywebToCsv(rows);
    // 字段数必须取**所有行的并集**：只数 rows[0] 会把 51 列传成 12 列
    // （真机截图暴露的显示 bug —— 被试/主试会以为字段丢了）。
    var colSet = {};
    rows.forEach(function (r) { Object.keys(r).forEach(function (k) { colSet[k] = 1; }); });
    var colCount = Object.keys(colSet).length;
    var frames = global.psywebBuildQrFrames(csv);
    var qrCount = 0;

    var old = global.document.getElementById('psyweb-results');
    if (old) old.remove();

    var box = global.document.createElement('div');
    box.id = 'psyweb-results';
    box.setAttribute('style', [
      'position:fixed;inset:0;z-index:99998;background:#f4f5f7;color:#1a1a1a',
      'font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;overflow:auto;padding:28px'
    ].join(';'));

    var head = '<div style="max-width:900px;margin:0 auto">' +
      '<div style="font-size:22px;font-weight:700;margin-bottom:4px">实验完成 · 谢谢参与</div>' +
      '<div style="color:#666;margin-bottom:18px">请把下面的内容发给主试（三种方式任选其一即可）</div>' +
      '<div style="background:#fff;border-radius:10px;padding:16px 18px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.08)">' +
      '<div><b>被试编号</b>：' + ((rows[0] && rows[0].participant) || '(未填写)') + '</div>' +
      '<div><b>有效数据行</b>：' + rows.length + ' 行 ／ <b>字段数</b>：' + colCount + '</div>' +
      '<div><b>完成时间</b>：' + new Date().toLocaleString() + '</div>' +
      '<div style="color:#888;font-size:12px;margin-top:6px">结束方式：' + reason + '</div>' +
      '</div>';

    var actions = '<div style="margin-bottom:16px">' +
      '<button id="psyweb-dl" style="font:inherit;padding:10px 18px;border:0;border-radius:8px;background:#2f6fed;color:#fff;cursor:pointer">① 下载数据文件（CSV）</button>' +
      ' <span style="color:#666">下载后直接发微信即可</span></div>';

    var qrNote = '<div style="background:#fff;border-radius:10px;padding:16px 18px;box-shadow:0 1px 3px rgba(0,0,0,.08)">' +
      '<div style="font-weight:700;margin-bottom:6px">② 或者：截图发这 ' + frames.length + ' 张二维码</div>' +
      '<div style="color:#666;font-size:12px;margin-bottom:12px">' +
      '请<b>逐张截图</b>并把 <b>' + frames.length + ' 张图</b>发给主试（微信里请勾选「原图」）。' +
      '这里装的是你的完整原始数据，主试扫码即可还原成 CSV。</div>' +
      '<div id="psyweb-qrs" style="display:flex;flex-wrap:wrap;gap:14px"></div></div>' +
      '</div>';

    box.innerHTML = head + actions + qrNote;
    global.document.body.appendChild(box);

    var grid = global.document.getElementById('psyweb-qrs');
    frames.forEach(function (frame, idx) {
      var qr = makeQr(frame);
      var wrap = global.document.createElement('div');
      wrap.setAttribute('style', 'text-align:center');
      if (qr) {
        var png = qrToPngDataUrl(qr, 6, 12);
        var img = global.document.createElement('img');
        img.src = png.url;
        img.width = 260; img.height = 260;
        img.alt = 'data-qr-' + (idx + 1);
        img.setAttribute('data-frame', String(idx + 1));
        img.setAttribute('data-len', String(frame.length));
        img.setAttribute('data-modules', String(png.modules));
        wrap.appendChild(img);
        qrCount++;
      } else {
        wrap.textContent = '（第 ' + (idx + 1) + ' 张生成失败，请改用 CSV）';
      }
      var cap = global.document.createElement('div');
      cap.setAttribute('style', 'font-size:12px;color:#666;margin-top:4px');
      cap.textContent = (idx + 1) + ' / ' + frames.length;
      wrap.appendChild(cap);
      grid.appendChild(wrap);
    });

    var btn = global.document.getElementById('psyweb-dl');
    if (btn) btn.onclick = function () { global.psywebDownloadCsv(csv, rows); };

    global.__PSYWEB_QR__ = { count: qrCount, frames: frames.length, firstFrame: frames[0] || '' };
    console.log('[psyweb] 结果页已显示：CSV ' + csv.length + ' B → ' + frames.length + ' 张二维码（成功 ' + qrCount + '）');
    return { csv: csv, frames: frames, qrCount: qrCount };
  };

  global.psywebDownloadCsv = function (csv, rows) {
    try {
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'psyweb_' + ((rows && rows[0] && rows[0].participant) || 'p') + '.csv';
      document.body.appendChild(a); a.click();
      return true;
    } catch (e) { console.log('[psyweb] 下载失败: ' + e.message); return false; }
  };

  global.psywebDump = function (psychoJS, reason) {
    var rows = global.psywebCollectRows(psychoJS);
    var csv = global.psywebToCsv(rows);
    // 列数要取**所有行的并集**：只取 rows[0] 会漏报（第一个 routine 的行字段最少，
    // 实测因此把 53 列报成 13 列）。
    var colSet = {};
    rows.forEach(function (r) { Object.keys(r).forEach(function (k) { colSet[k] = 1; }); });
    var cols = Object.keys(colSet);
    global.__PSYWEB__ = {
      reason: reason || 'unknown', nRows: rows.length, nCols: cols.length,
      columns: cols, csv: csv, rows: rows
    };
    console.log('[psyweb] DUMP reason=' + reason + ' rows=' + rows.length + ' cols=' + cols.length + ' csvBytes=' + csv.length);

    var ok = global.psywebDownloadCsv(csv, rows);
    global.__PSYWEB__.downloadTriggered = ok;

    // 正常跑完就把自动存盘清掉。
    // 不清的话，下次打开会继续显示"上次未完成的数据"，而那其实是**已经导出过**
    // 的一次完整数据 —— 用户实测被这句话误导过（以为是新数据 / 以为没导出成功）。
    if (reason === 'completed') {
      try { global.localStorage.removeItem(AUTOSAVE_KEY); } catch (e) {}
    }

    // 出结果页（三通道出口）。失败不能影响数据本身。
    var res = null;
    try { res = global.psywebShowResults(psychoJS, reason); }
    catch (e) { console.error('[psyweb] 结果页渲染失败（数据仍在 __PSYWEB__ 里）: ' + (e && e.message)); }
    global.__PSYWEB__.qr = res ? { count: res.qrCount, frames: res.frames.length } : null;

    document.title = 'PSYWEB_DUMP rows=' + rows.length + ' cols=' + cols.length +
      ' csv=' + csv.length + ' dl=' + (ok ? 'ok' : 'fail') +
      ' qr=' + (res ? res.qrCount + '/' + res.frames.length : 'none');
    return csv;
  };

  /* ---------------- 自测夹具（仅 ?autotest=1 生效） ---------------- */
  global.PSYWEB_AUTOTEST = (function () {
    try { return new URLSearchParams(global.location.search).has('autotest'); } catch (e) { return false; }
  })();

  global.psywebAutoDrive = function (psychoJS) {
    if (!global.PSYWEB_AUTOTEST) return;
    console.log('[psyweb] autotest: 自动按键/点击驱动已启动');
    var seq = [
      { code: 'Space', key: ' ', keyCode: 32 },
      { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37 },
      { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 },
      { code: 'KeyF', key: 'f', keyCode: 70 },
      { code: 'KeyJ', key: 'j', keyCode: 74 }
    ];
    // ---- 鼠标驱动 ----
    // 实测教训（两条，都是"点了没反应"的真因）：
    //  ① 试次靠 `obj.contains(mouse)` 判定有效点击 —— 必须点在刺激的**实际位置**上。
    //     本实验两张图在 ±0.3 height 单位处，而视口正中 (640,400) 恰好是它们之间的空档，
    //     于是 gotValidClick 永远为 false，试次永不结束（卡在 trialRoutineEachFrame）。
    //  ② `mouse.getPos()` 依赖 **mousemove** 事件；只发 pointermove 位置不更新，
    //     命中判定同样失败。
    // 所以：先算画布几何 → 把 0.3 height 单位换算成像素 → 每个位置"移动→按下→抬起"跨帧完成。
    function canvasGeom() {
      var c = global.document.querySelector('canvas');
      var r = c ? c.getBoundingClientRect() : null;
      if (!r || !r.width || !r.height) r = { left: 0, top: 0, width: 1280, height: 800 };
      return r;
    }
    function mouseTargets() {
      var r = canvasGeom();
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var dx = 0.3 * r.height;              // 0.3 height 单位 → 像素
      return [[cx - dx, cy], [cx + dx, cy]];
    }
    function fireMouse(type, x, y, buttons) {
      var targets = [global, global.document, global.document.querySelector('canvas')].filter(Boolean);
      targets.forEach(function (t) {
        try {
          var Ctor = (type.indexOf('pointer') === 0 && typeof PointerEvent !== 'undefined') ? PointerEvent : MouseEvent;
          t.dispatchEvent(new Ctor(type, {
            bubbles: true, cancelable: true, composed: true,
            clientX: x, clientY: y, button: 0, buttons: buttons || 0,
            pointerId: 1, pointerType: 'mouse', isPrimary: true
          }));
        } catch (e) {}
      });
    }

    var i = 0;
    global.setInterval(function () {
      var k = seq[i % seq.length];
      var tick = i; i++;
      ['keydown', 'keyup'].forEach(function (type) {
        var ev = new KeyboardEvent(type, { key: k.key, code: k.code, bubbles: true, cancelable: true });
        try { Object.defineProperty(ev, 'keyCode', { get: function () { return k.keyCode; } }); } catch (e) {}
        global.dispatchEvent(ev);
      });

      // 4 拍一个循环：移动+按下(A) → 抬起 → 移动+按下(B) → 抬起
      var t = mouseTargets();
      var phase = tick % 4;
      var pos = (phase < 2) ? t[0] : t[1];
      if (phase === 0 || phase === 2) {
        fireMouse('mousemove', pos[0], pos[1], 0);       // 先更新位置（getPos 依赖它）
        fireMouse('pointermove', pos[0], pos[1], 0);
        fireMouse('mousedown', pos[0], pos[1], 1);
        fireMouse('pointerdown', pos[0], pos[1], 1);
      } else {
        fireMouse('mouseup', pos[0], pos[1], 0);
        fireMouse('pointerup', pos[0], pos[1], 0);
        fireMouse('click', pos[0], pos[1], 0);
      }
    }, 400);

    // 递归下钻嵌套调度器，找出"到底卡在哪个函数上"。
    // （只打印 scheduler._currentTask 只会得到 "[object Object]" —— 那是个子调度器，
    //   真正阻塞的 leaf task 在更深一层，靠这个函数才能看见。）
    function describeScheduler(s, depth) {
      if (!s || depth > 8) return '(too deep)';
      try {
        var t = s._currentTask;
        var queued = s._taskList ? s._taskList.length : -1;
        if (!t) return 'idle(queued=' + queued + ')';
        if (typeof t === 'function') {
          var src = t.toString().replace(/\s+/g, ' ').trim();
          return src.slice(0, 90) + (src.length > 90 ? '…' : '');
        }
        if (t && (t._currentTask !== undefined || t._taskList)) {
          return 'nested[' + describeScheduler(t, depth + 1) + ']';
        }
        return Object.prototype.toString.call(t) + '(queued=' + queued + ')';
      } catch (e) { return 'ERR:' + e.message; }
    }

    global.setInterval(function () {
      try {
        var sched = psychoJS.scheduler || psychoJS._scheduler;
        var st = {
          rows: global.psywebCollectRows(psychoJS).length,
          stuck: describeScheduler(sched, 0)
        };
        global.__PSYWEB_DBG__ = st;
        console.log('[psyweb][dbg] ' + JSON.stringify(st));
      } catch (e) { console.log('[psyweb][dbg] 失败: ' + (e && e.message)); }
    }, 3000);
  };
})(window);
