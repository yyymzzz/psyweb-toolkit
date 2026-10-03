/* ============================================================================
 * tool-page —— 本地工具（http://127.0.0.1:7788）页面的浏览器脚本
 * ----------------------------------------------------------------------------
 * 为什么从 tool-server.js 的模板字符串里搬出来（血泪教训）：
 *   这段代码原先内嵌在 tool-server.js 的模板字符串里。模板字符串会**吃掉反斜杠**，
 *   于是一次通过工具参数下发的补丁把
 *       /['"]name['"]\s*:\s*['"]…/   →  /['"]name['"]s*:s*['"]…/
 *       /^(https?:)?\/\//i            →  /^(https?:)?///i
 *   落盘后页面脚本语法错误 → 初始化中断 → 永久卡在「正在检测本机 PsychoPy…」。
 *   更阴的是：某些被吃掉的写法**仍然能通过语法检查**（s* 是合法量词），
 *   所以 node --check 和"能编译"都抓不到语义损坏。
 *
 * 现在的结构（结构性消除这类事故，而不是靠人小心）：
 *   · 本文件是**真实文件** —— node --check 有效，编辑器/工具链都按普通 JS 对待
 *   · tool-server.js 在**发页面时**把它整段内联进 <script>
 *   · spike/m0/src/verify-tool-page.js 从**服务出去的页面**里把这块抽出来，
 *     与磁盘上的本文件做**逐字符比对** + 逐个 new vm.Script 强制编译
 *   —— 内联过程只要篡改一个字符，门禁立刻红。
 *
 * 与 PsywebRefClosure 的分工：
 *   ref-closure.js  纯逻辑（解析 psyexp、算引用闭包），Node 与浏览器共用同一份
 *   本文件          只有 DOM / File / 网络这些浏览器专属的胶水
 *
 * 选择策略（"引用闭包"取代"黑名单"）：
 *   旧：挡掉 data/ 和少数扩展名，其余全收 → 拖进 7 万文件的目录会传 416.7 MB
 *   新：只读 1 个 .psyexp（几十 KB）→ 解析出它引用的条件表 → 读那几张表
 *       → 由 ref-closure 折叠代码里的路径常量 + 条件表列值 → 反推出所需文件
 *       → 只上传这些。全程不靠目录布局，不靠文件名白名单。
 *   兜底：解析不出引用时**退回旧行为**并在日志里明说（绝不静默降级）。
 * ========================================================================== */
(function (root) {
  'use strict';

  var RC = root.PsywebRefClosure;

  var picked = [];          // File 对象（向后兼容 / 兜底路径用）
  var index = [];           // [{ rel, name, lower, file?, entry? }] 全量文件索引（惰性）
  var filesInput = null, dirInput = null;

  function log(s, cls) {
    var d = document.getElementById('log');
    var n = document.createElement('div');
    n.className = cls || '';
    n.textContent = s;
    d.appendChild(n);
    d.scrollTop = d.scrollHeight;
  }

  /* base64 必须**分块**转换。
   * 实测事故：btoa(String.fromCharCode.apply(null, u8)) 对 >64KB 的文件会抛
   * RangeError: Maximum call stack size exceeded（apply 传超大数组参数爆栈），
   * 而读取循环当时在 try/catch 之外 —— 异常被静默吞掉，按钮一直灰着、日志停在
   * "读取文件…"，用户看到的就是"点了没反应"。 */
  function toB64(u8) {
    var CH = 0x8000, out = '';
    for (var i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(out);
  }

  /* ---------------------------------------------------------------- 旧行为（兜底用） */
  var KEEP_EXT = /\.(psyexp|png|jpe?g|gif|bmp|webp|mp3|wav|ogg|mp4|mov|avi|xlsx?|csv|tsv|odp|txt)$/i;
  var SKIP_DIR = /(^|\/)(data|__pycache__|node_modules|\.git|实验截图|_调试残留)/i;
  var MAX_FILE = 50 * 1024 * 1024;
  function classify(list) {
    var keep = [], skipDir = 0, skipExt = 0, skipBig = 0;
    list.forEach(function (f) {
      var rel = f.relPath || f.name;
      if (SKIP_DIR.test(rel)) { skipDir++; return; }
      if (!KEEP_EXT.test(f.name)) { skipExt++; return; }
      if (f.size > MAX_FILE) { skipBig++; return; }
      keep.push(f);
    });
    return { keep: keep, skipDir: skipDir, skipExt: skipExt, skipBig: skipBig };
  }

  /* ---------------------------------------------------------------- 全量索引 */
  function markRel(f, rel) { try { Object.defineProperty(f, 'relPath', { value: rel }); } catch (e) {} }

  function indexPush(rel, file, entry) {
    index.push({ rel: rel, name: RC ? RC.baseName(rel) : rel, lower: rel.toLowerCase(), file: file || null, entry: entry || null });
  }

  /** 惰性取 File：拖拽进来的是 FileSystemFileEntry，按下标建索引时**不能**逐个 entry.file()
   *  —— 7 万个文件那样做会先把内存和事件队列压垮。只在真要读内容时才取。 */
  function readItem(it) {
    if (it.file) return Promise.resolve(it.file);
    return new Promise(function (res, rej) { it.entry.file(res, rej); });
  }
  function readItemText(it) {
    return readItem(it).then(function (f) { return f.text(); });
  }
  function readItemB64(it) {
    return readItem(it).then(function (f) {
      return f.arrayBuffer().then(function (buf) { return toB64(new Uint8Array(buf)); });
    });
  }

  function walk(entry, prefix, out) {
    return new Promise(function (resolve) {
      if (entry.isFile) { indexPush(prefix + entry.name, null, entry); return resolve(); }
      if (!entry.isDirectory) return resolve();
      var reader = entry.createReader(), batchAll = [];
      var readMore = function () {
        reader.readEntries(function (batch) {
          if (!batch.length) {
            var files = [], dirs = [];
            batchAll.forEach(function (en) { (en.isFile ? files : dirs).push(en); });
            var t = files.length + dirs.length;
            if (!t) return resolve();
            var done = function () { if (--t === 0) resolve(); };
            files.forEach(function (en) { walk(en, prefix + entry.name + '/', out).then(done); });
            dirs.forEach(function (en) { walk(en, prefix + entry.name + '/', out).then(done); });
            return;
          }
          batchAll = batchAll.concat(batch);
          readMore();
        });
      };
      readMore();
    });
  }

  /* ---------------------------------------------------------------- 路径换算
   * ref-closure 给出的引用是**相对 psyexp 所在目录**的（PsychoPy 运行时的
   * _thisDir 就是脚本目录）。索引里的路径是相对"拖入根"的。这里做换算。 */
  function refToDropped(psyexpRel, ref) {
    return RC ? RC.joinPath(RC.dirName(psyexpRel), ref) : ref;
  }
  var byRel = {}, byBase = {};
  function buildLookup() {
    byRel = {}; byBase = {};
    index.forEach(function (it) {
      if (!byRel[it.lower]) byRel[it.lower] = it;
      var b = (RC ? RC.baseName(it.rel) : it.name).toLowerCase();
      (byBase[b] = byBase[b] || []).push(it);
    });
  }
  function findInIndex(psyexpRel, ref, report) {
    var full = refToDropped(psyexpRel, ref);
    var hit = byRel[full.toLowerCase()];
    if (hit) return hit;
    var b = (RC ? RC.baseName(ref) : ref).toLowerCase();
    var cands = byBase[b];
    if (cands && cands.length) {
      // 同名多份时取"路径最短、再按字典序"的那个 —— 确定性，可复现
      var sorted = cands.slice().sort(function (a, c) {
        return a.rel.length - c.rel.length || (a.rel < c.rel ? -1 : a.rel > c.rel ? 1 : 0);
      });
      if (report) report('   · 「' + ref + '」按代码给出的路径没找到，改用同名文件 ' + sorted[0].rel
        + (sorted.length > 1 ? '（同名共 ' + sorted.length + ' 份）' : ''), 'warn');
      return sorted[0];
    }
    return null;
  }

  /* ---------------------------------------------------------------- 选择 */
  var TABLE_EXT = /\.(xlsx?|csv|tsv|odp)$/i;

  function parseCsvRows(text) {
    return String(text).split(/\r?\n/).filter(function (l) { return l.trim() !== ''; })
      .map(function (l) { return l.split(/[,\t]/); });
  }

  /** 调 /api/tables 让服务端用 SheetJS 把 xlsx 解成二维数组 */
  function fetchXlsxRows(tables) {
    if (!tables.length) return Promise.resolve({});
    return Promise.all(tables.map(function (t) {
      return readItemB64(t.it).then(function (b64) { return { rel: t.ref, b64: b64 }; });
    })).then(function (files) {
      return fetch('/api/tables', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: files })
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok) throw new Error(j.error || '服务端解析条件表失败');
        return j.rows || {};
      });
    });
  }

  function setPicked(files) {
    picked = Array.prototype.slice.call(files);
    index = [];
    picked.forEach(function (f) { indexPush(f.relPath || f.name, f, null); });
    buildLookup();
    renderPicked();
  }

  function renderPicked() {
    var psy = index.filter(function (it) { return /\.psyexp$/i.test(it.name); });
    var el = document.getElementById('picked');
    if (!index.length) { el.textContent = '尚未选择文件'; el.className = 'env'; }
    else if (psy.length) {
      el.textContent = '已索引 ' + index.length + ' 个文件（未读取内容）· 主文件 ' + psy[0].name;
      el.className = 'env';
    } else {
      var c = classify(picked);
      el.textContent = '已索引 ' + index.length + ' 个文件，但没找到 .psyexp —— 请把整个实验文件夹拖进来';
      el.className = 'env bad';
    }
    document.getElementById('mainFile').textContent = psy.length ? psy[0].rel : '（自动识别文件夹里的 .psyexp）';
    document.getElementById('go').disabled = psy.length === 0;
    if (psy.length && !document.getElementById('title').value) {
      document.getElementById('title').value = psy[0].name.replace(/\.psyexp$/i, '');
    }
  }

  /** 精确选择：引用闭包。返回 {items:[indexItem], source, notes, degraded} */
  async function planPrecise(psyItem) {
    var notes = [];
    var say = function (s, cls) { notes.push(s); log(s, cls); };
    var psyText = await readItemText(psyItem);

    // ① 先只解析 psyexp —— 得到它引用的条件表清单（不需要解 xlsx）
    var phase1 = RC.resolve({ psyexpRel: psyItem.rel, psyexpText: psyText, getTableRows: null });
    var tableRefs = (phase1.tables || []).slice();
    say('   · 主文件 ' + psyItem.rel + '（' + (psyText.length / 1024).toFixed(0) + ' KB）');
    (phase1.notes || []).forEach(function (n) { if (/常量/.test(n)) say('   · ' + n); });
    if (!tableRefs.length) say('   · 主文件里没有引用任何条件表', 'warn');

    // ② 在索引里找到这些条件表，读出内容（csv 本地解析；xlsx 交给服务端 SheetJS）
    var rowsCache = {}, xlsxJobs = [];
    tableRefs.forEach(function (ref) {
      var it = findInIndex(psyItem.rel, ref, say);
      if (!it) { say('   · ⚠️ 条件表没找到：' + ref, 'warn'); return; }
      if (/\.(csv|tsv)$/i.test(it.name)) { it._rows = null; it._csv = true; }
      xlsxJobs.push({ ref: ref, it: it });
    });
    var csvItems = xlsxJobs.filter(function (j) { return j.it._csv; });
    var xlsxItems = xlsxJobs.filter(function (j) { return !j.it._csv; });
    for (var i = 0; i < csvItems.length; i++) {
      rowsCache[csvItems[i].ref] = parseCsvRows(await readItemText(csvItems[i].it));
    }
    var xr = await fetchXlsxRows(xlsxItems);
    Object.keys(xr).forEach(function (k) { rowsCache[k] = xr[k]; });

    // ③ 完整解析：exists 用索引精确判定 —— 这一条把"另一个目录同名"的误配挡掉
    var exists = function (ref) { return !!byRel[refToDropped(psyItem.rel, ref).toLowerCase()]; };
    var res = RC.resolve({
      psyexpRel: psyItem.rel,
      psyexpText: psyText,
      getTableRows: function (rel) { return rowsCache[rel] !== undefined ? rowsCache[rel] : null; },
      exists: exists
    });
    (res.notes || []).forEach(function (n) {
      if (/常量/.test(n)) return;                       // 上面已报过
      say('   · ' + n, /⚠️/.test(n) ? 'warn' : '');
    });

    if (res.degraded) return { items: [], source: 'fallback', notes: notes, degraded: true, res: res };

    // ④ 引用 → 索引条目
    var out = [], seen = {}, missing = [];
    res.refs.forEach(function (r) {
      if (r.missing) return;                            // ref-closure 已按 exists 过滤过
      var it = findInIndex(psyItem.rel, r.path, say);
      if (!it) { missing.push(r.path); return; }
      if (seen[it.rel]) return;
      seen[it.rel] = 1;
      out.push(it);
    });
    if (missing.length) say('   · ⚠️ ' + missing.length + ' 个引用的文件在所选目录里不存在：'
      + missing.slice(0, 5).join('、') + (missing.length > 5 ? ' …' : ''), 'warn');

    return { items: out.filter(function (it) { return !/\.psyexp$/i.test(it.name); }), source: 'closure', notes: notes, degraded: false, res: res };
  }

  /* ---------------------------------------------------------------- 转换 */
  function bindDrop() {
    var drop = document.getElementById('drop');
    ['dragenter', 'dragover'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('hot'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('hot'); });
    });
    drop.addEventListener('drop', function (e) {
      var items = e.dataTransfer.items;
      index = [];
      if (items && items.length && items[0].webkitGetAsEntry) {
        var jobs = [];
        for (var i = 0; i < items.length; i++) {
          var entry = items[i].webkitGetAsEntry();
          if (entry) jobs.push(walk(entry, '', null));
        }
        Promise.all(jobs).then(function () { picked = []; buildLookup(); renderPicked(); });
      } else {
        setPicked(e.dataTransfer.files);
      }
    });
  }

  function bindEnv() {
    fetch('/api/env').then(function (r) { return r.json(); }).then(function (e) {
      // 界面不要暴露"某台机器的绝对路径"——分发出去后那是别人的机器。
      document.getElementById('env').innerHTML = e.python
        ? ('已找到本机 <b>PsychoPy ' + e.version + '</b>　·　官方编译器就绪（可直接转换 .psyexp）' +
           '<div style="font-size:12px;opacity:.65;margin-top:3px">' + e.python + '</div>')
        : ('<span class="bad">本机没找到 PsychoPy。</span> 两条路可选：' +
           '<div style="font-size:13px;margin-top:4px">' +
           '① 安装 PsychoPy（<a href="https://www.psychopy.org/download.html" target="_blank">官网下载</a>，standalone 版自带 Python，装完重开本工具）；<br>' +
           '② 不装也行：让对方在 PsychoPy Builder 里点一次 <b>Export HTML</b>，把导出的文件夹拖进来（走兜底路径，不需要 Python）。' +
           '</div>');
    }).catch(function () { document.getElementById('env').textContent = '环境检测失败'; });
  }

  async function run(btn) {
    // 整个流程都包在 try/finally 里：哪怕是读文件阶段出错，也要把错误显示出来
    // 并把按钮恢复——绝不能出现"点了没反应、按钮永远灰着"（实测踩过）。
    try {
      if (!RC) throw new Error('页面缺少引用闭包解析器（ref-closure.js 没被内联进来）');
      var psy = index.filter(function (it) { return /\.psyexp$/i.test(it.name); })[0];
      if (!psy) throw new Error('没找到 .psyexp —— 请把整个实验文件夹拖进来（不是只拖 data 目录）');

      log('① 解析引用闭包（只读 1 个 .psyexp，不看目录布局、不按文件名猜）…');
      var plan = await planPrecise(psy);

      var chosen, source;
      if (plan.source === 'closure') {
        chosen = plan.items;
        source = 'closure';
        log('② 引用闭包给出 ' + chosen.length + ' 个文件需要上传'
          + (plan.res && plan.res.unresolved && plan.res.unresolved.length
            ? '（另有 ' + plan.res.unresolved.length + ' 处动态引用无法静态解析）' : ''), 'ok');
      } else {
        // —— 降级：退回旧的"按扩展名保留"行为。必须**说出来**，不许静默 ——
        log('② ⚠️ 未能解析出引用闭包，改用保守筛选（按扩展名保留）—— 会多传，但不会丢文件', 'warn');
        (plan.notes || []).forEach(function (n) { log('   ' + n, 'warn'); });
        var c = classify(picked.length ? picked : await materializeAll());
        chosen = c.keep.map(function (f) { return { rel: f.relPath || f.name, name: f.name, file: f }; });
        source = 'fallback';
      }

      // psyexp 必须原样带上（它自己就是 entry/file 的持有者）。
      // 坑：这里曾写成 { rel, name, file:null, entry:psy.entry } —— 拖拽路径下
      // entry 有值还好，<input webkitdirectory> 路径下 entry 恒为 null，
      // 于是读主文件时炸 "Cannot read properties of null (reading 'file')"（实测踩过）。
      var all = [psy].concat(chosen);
      var seen = {}, files = [];
      for (var i = 0; i < all.length; i++) {
        var it = all[i];
        if (seen[it.rel]) continue;
        seen[it.rel] = 1;
        files.push(it);
      }

      var payload = { title: document.getElementById('title').value || '在线实验', files: [] };
      var total = 0;
      // 预检必须在**读取之前**：读满几百 MB 再报错等于白读一场，而且那时
      // JSON.stringify 会先抛出看不懂的 "Invalid string length"（V8 单字符串上限 512 MiB）。
      var plannedBytes = 0;
      for (var q = 0; q < files.length; q++) {
        var sz = files[q].file ? files[q].file.size : 0;
        plannedBytes += sz;
      }
      log('③ 读取 ' + files.length + ' 个文件' + (plannedBytes ? '（约 ' + (plannedBytes / 1048576).toFixed(1) + ' MB）' : '') + '…');

      for (var k = 0; k < files.length; k++) {
        var f = files[k];
        var buf = await readItem(f);
        var ab = await buf.arrayBuffer();
        total += ab.byteLength;
        payload.files.push({ name: f.rel, b64: toB64(new Uint8Array(ab)) });
        if ((k + 1) % 10 === 0 || k === files.length - 1) {
          log('   已读取 ' + (k + 1) + '/' + files.length + '（' + (total / 1048576).toFixed(1) + ' MB）');
        }
      }
      var body = JSON.stringify(payload);
      log('④ 已打包 ' + payload.files.length + ' 个文件（原始 ' + (total / 1048576).toFixed(1)
        + ' MB，传输 ' + (body.length / 1048576).toFixed(1) + ' MB），开始转换…');
      if (body.length > 480 * 1048576) {
        throw new Error('上传体积 ' + (body.length / 1048576).toFixed(0) + ' MB 触及浏览器单次上传的物理上限'
          + '（V8 字符串上限约 512 MB）。这通常意味着上一步降级成了保守筛选 —— '
          + '请检查日志里"未能解析出引用闭包"的原因。');
      }

      var r = await fetch('/api/convert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body });
      var j = await r.json();
      (j.log || []).forEach(function (l) { log(l.line, l.cls); });
      if (j.ok) {
        log('✅ 完成：' + j.outName + '（' + (j.size / 1048576).toFixed(2) + ' MB）', 'ok');
        var a = document.createElement('a');
        a.href = j.url; a.download = j.outName; a.textContent = '点这里下载 ' + j.outName;
        document.getElementById('log').appendChild(a);
        log('也可以直接从磁盘取：' + j.outPath, 'ok');
        window.__SITE_TEST__ = { ok: true, source: source, uploaded: payload.files.length, bytes: total, outName: j.outName, size: j.size };
      } else {
        log('❌ 转换失败，请看上面日志', 'bad');
        window.__SITE_TEST__ = { ok: false, source: source, uploaded: payload.files.length };
      }
    } catch (e) {
      var emsg = String((e && (e.message || e.name)) || e);
      if (/Invalid string length/i.test(emsg)) {
        emsg = '内容超出浏览器单次上传上限（V8 字符串上限约 512 MB），已中止。';
      }
      log('❌ 出错：' + emsg, 'bad');
      log('   （把这段错误截图发给开发者即可定位；数据没有被上传到任何地方）', 'warn');
      window.__SITE_TEST__ = { ok: false, error: emsg };
    } finally {
      btn.disabled = false;
    }
  }

  /** 兜底路径用：把惰性索引全部实体化（只在降级时才会走到，代价大但不会静默丢文件） */
  async function materializeAll() {
    var out = [];
    for (var i = 0; i < index.length; i++) {
      var f = await readItem(index[i]);
      markRel(f, index[i].rel);
      out.push(f);
    }
    return out;
  }

  function bindGo() {
    document.getElementById('go').onclick = function () {
      var btn = this;
      btn.disabled = true;
      run(btn);
    };
  }

  /* ---------------------------------------------------------------- 启动 */
  function init() {
    filesInput = document.getElementById('files');
    dirInput = document.getElementById('dir');
    document.getElementById('pickDir').onclick = function () { dirInput.click(); };
    document.getElementById('pickFiles').onclick = function () { filesInput.click(); };
    dirInput.onchange = function (e) {
      var list = Array.prototype.slice.call(e.target.files);
      list.forEach(function (f) { markRel(f, f.webkitRelativePath || f.name); });
      setPicked(list);
    };
    filesInput.onchange = function (e) { setPicked(e.target.files); };
    bindDrop();
    bindEnv();
    bindGo();
  }

  root.__psywebTool = {
    init: init,
    setPicked: setPicked,
    classify: classify,
    toB64: toB64,
    hasRefClosure: function () { return !!RC; },
    run: run,
    stats: function () { return { indexed: index.length, picked: picked.length }; }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof self !== 'undefined' ? self : this);
