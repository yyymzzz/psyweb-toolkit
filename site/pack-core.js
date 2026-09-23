/* ============================================================================
 * pack-core —— 浏览器版打包器（在线工具的核心，纯文本处理，不需要任何服务器）
 * ----------------------------------------------------------------------------
 * 与 src/pack-portable.js（Node 版）的关系：
 *   两者做同一件事（把 PsychoPy 导出的实验打成单文件便携包），差别只在"文件从哪来"：
 *     Node 版：从磁盘读（能顺带调 PsychoPy 编译器处理 .psyexp）
 *     本文件：从浏览器拖入的 File 对象读（因此**不能**编译 .psyexp —— 那需要 Python）
 *   补丁规则、自检清单、内联格式三者必须完全一致；一致性由
 *   spike/m0/src/test-pack-core.js 用真实导出物对拍两个实现来保证。
 *
 * 用法（浏览器）:
 *   const r = await PsywebPack.pack({ files, assets, title, expName });
 *   r.html → 单文件便携包文本； r.log → 逐条日志； r.meta → 自检结果
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PsywebPack = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PLACEHOLDER_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  /* ---------------- ① 代码块修复（与 src/js-codeblock-fix.js 同规则） ---------------- */
  var SHIMS = {
    random: "const random = {\n" +
      "    random: () => Math.random(),\n" +
      "    randomInt: (a, b) => Math.floor(Math.random() * (b - a + 1)) + a,\n" +
      "    randint: (a, b) => Math.floor(Math.random() * (b - a + 1)) + a,\n" +
      "    choice: (arr) => arr[Math.floor(Math.random() * arr.length)],\n" +
      "    uniform: (a, b) => a + Math.random() * (b - a),\n" +
      "    shuffle: (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; },\n" +
      "    sample: (arr, k) => { const c = arr.slice(); const out = []; for (let i = 0; i < Math.min(k, c.length); i++) { out.push(c.splice(Math.floor(Math.random() * c.length), 1)[0]); } return out; }\n" +
      "  };"
  };

  function fixJsCode(src) {
    var changes = [], todos = [];
    var lines = String(src).split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], lineNo = i + 1;
      var m = line.match(/^(\s*)import\s+(?:\*\s+as\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)|\{([^}]*)\})\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/);
      if (m) {
        var indent = m[1], nsName = m[2], defName = m[3], named = m[4], mod = m[5];
        var local = nsName || defName;
        if (SHIMS[mod] && local) {
          out.push(indent + SHIMS[mod]);
          changes.push({ line: lineNo, kind: 'import→内联实现', from: line.trim(), to: 'const ' + local + ' = {…}（' + mod + ' 等价实现）' });
        } else {
          out.push(indent + '/* psyweb: 原语句 `' + line.trim() + '` 引用了裸模块 \'' + mod + '\'，浏览器里无法解析；已注释。若实验确实用到它，请把用到的函数改为内联实现。 */');
          changes.push({ line: lineNo, kind: 'import→注释', from: line.trim(), to: '(已注释，待人工替换为内联实现)' });
          todos.push('第 ' + lineNo + ' 行引用了无法解析的模块 \'' + mod + '\'' + (named ? '（具名导入: ' + named + '）' : '') + '，需人工提供内联实现');
        }
        continue;
      }
      if (/Math\.random\.random\s*\(/.test(line)) {
        changes.push({ line: lineNo, kind: '翻译缺陷修正', from: 'Math.random.random(', to: 'Math.random(' });
        line = line.replace(/Math\.random\.random\s*\(/g, 'Math.random(');
      }
      if (/Math\.random\.randint\s*\(/.test(line)) {
        changes.push({ line: lineNo, kind: '翻译缺陷修正', from: 'Math.random.randint(a,b)', to: '内联 randint(a,b)' });
        line = line.replace(/Math\.random\.randint\s*\(([^)]*)\)/g,
          function (mm, args) { return '(function(a,b){return Math.floor(Math.random()*(b-a+1))+a;})(' + args + ')'; });
      }
      out.push(line);
    }
    return { code: out.join('\n'), changes: changes, todos: todos };
  }

  /* ---------------- ② 从 .psyexp 里发现资源（浏览器里也能做，无需 XML 库） ----------------
   * 为什么需要：Builder 的 Export HTML 会自动探测资源，但探测可能漏（尤其是
   * 图片名写在条件文件里、或资源清单没登记的情况）。把 .psyexp 一起拖进来，
   * 我们就能从组件参数里把资源名读出来补齐 —— 这与 Node 版 pack-portable 的行为一致。
   * 用正则而不是 XML 解析器：.psyexp 的属性顺序不固定（name 在前或在后），
   * 两条正则即可覆盖；对"发现文件名"这个目的足够，且浏览器/Node 都能跑。
   * 局限：只收**字面量**文件名，动态表达式（$var、.format()、thisTrial.x）一律跳过。
   */
  function discoverFromPsyexp(xml) {
    var found = [], seen = {};
    var patterns = [
      /<Param[^>]*\bname="(image|movie|sound|conditionsFile)"[^>]*\bval="([^"]*)"/g,
      /<Param[^>]*\bval="([^"]*)"[^>]*\bname="(image|movie|sound|conditionsFile)"/g
    ];
    patterns.forEach(function (re, idx) {
      var m;
      while ((m = re.exec(xml)) !== null) {
        var v = (idx === 0 ? m[2] : m[1]);
        v = String(v).replace(/^['"]|['"]$/g, '').trim();
        if (!v) continue;
        if (/[$\[\]{}]|\.format\s*\(|thisTrial|\+/.test(v)) continue;   // 动态引用跳过
        if (seen[v]) continue;
        seen[v] = 1; found.push(v);
      }
    });
    return found;
  }

  /* ---------------- ③ 定点补丁引擎（与 Node 版一致） ---------------- */
  function makePatcher(getJs, setJs, applied) {
    return function patch(id, pattern, replacement, opts) {
      var required = !(opts && opts.required === false);
      var js = getJs();
      var m = js.match(pattern);
      if (!m) { if (required) throw new Error('补丁未命中: ' + id); return false; }
      var replacer = (typeof replacement === 'function')
        ? function (match) { return replacement([match].concat(Array.prototype.slice.call(arguments, 1))); }
        : replacement;
      setJs(js.replace(pattern, replacer));
      applied.push(id);
      return true;
    };
  }

  /* ---------------- ③ 主流程 ---------------- */
  /**
   * @param opts.files   [{name, relPath, data:Uint8Array}] 用户拖入的导出文件夹内容
   * @param opts.assets  {psychoJs, jquery, jqueryUi, jqueryUiCss, preload, pako, qrcode, css, shim}（文本）
   * @param opts.title   实验标题
   */
  async function pack(opts) {
    var files = opts.files || [];
    var assets = opts.assets || {};
    var log = [];
    var say = function (s, cls) { log.push({ line: s, cls: cls || '' }); };

    // 找主脚本（legacy 版优先：它是经典脚本，单文件化不需要模块解析）
    var legacy = files.find(function (f) { return /-legacy-browsers\.js$/i.test(f.name); });
    var modern = files.find(function (f) { return /\.js$/i.test(f.name) && !/-legacy-browsers\.js$/i.test(f.name); });
    var main = legacy || modern;
    if (!main) {
      // 拖进来的可能只有 .psyexp（很多人会这么拖）——必须给出**可操作**的指引，
      // 而不是一句"找不到文件"。同时说明为什么这里做不到那一步：
      // 把 .psyexp 编译成 JS 的是 PsychoPy 本体（Python），其导入链上有
      // wx / pyglet / psychtoolbox 等**原生桌面库**（实测 158 个模块），
      // 浏览器里没有 Python 运行时，WASM 也起不来这些库。
      var hasPsyexp = files.some(function (f) { return /\.psyexp$/i.test(f.name); });
      if (hasPsyexp) {
        throw new Error(
          '这个文件夹里只有 .psyexp，还差一步：请在 PsychoPy Builder 里点一次 ' +
          'File → Export HTML…（约 10 秒），然后把生成的文件夹（含 index.html 与 xxx.js）拖进来。' +
          '　—— 为什么不能直接编译：把 .psyexp 变成 JS 的是 PsychoPy 本体（Python 程序），' +
          '它的依赖里有 wx、pyglet 等原生桌面库，浏览器里跑不了。' +
          '想"拖 .psyexp 一步到位"，请用仓库里的本地工具或免安装分发包（它们在你自己电脑上调用 PsychoPy）。'
        );
      }
      throw new Error('没找到实验脚本（*.js）。请确认拖入的是 PsychoPy「Export HTML」生成的整个文件夹。');
    }
    say('主脚本：' + (main.relPath || main.name) + (legacy ? '（legacy 版，兼容性最好）' : '（module 版）'));
    if (!legacy && modern) say('⚠️ 只有 module 版：单文件模式下 ES module 的外部 import 会被浏览器拦截，建议在 Builder 里重新导出（会同时生成 legacy 版）', 'warn');

    var decoder = new TextDecoder('utf-8');
    var js = decoder.decode(main.data);

    // ① 代码块修复
    var fixed = fixJsCode(js);
    js = fixed.code;
    if (fixed.changes.length) say('代码块修复 ' + fixed.changes.length + ' 处：' + fixed.changes.map(function (c) { return '#' + c.line + ' ' + c.kind; }).join('；'));
    fixed.todos.forEach(function (t) { say('  ⚠️ ' + t, 'warn'); });

    // ② 资源清单：JS 里声明的 + 拖进来的（后者兜底，防止导出物漏登记）
    var declared = [];
    var re = /\{\s*'name':\s*'([^']+)',\s*'path':\s*'([^']+)'\s*\}/g, m2;
    while ((m2 = re.exec(js)) !== null) declared.push({ name: m2[1], p: m2[2] });
    if (!/resources:\s*\[/.test(js)) throw new Error('在主脚本里找不到 resources 列表 —— 这不是 PsychoPy 导出的实验脚本？');

    var byName = {};
    files.forEach(function (f) {
      byName[f.name] = f;
      var rp = f.relPath || '';
      byName[rp] = f;
      var base = rp.split('/').pop();
      if (base) byName[base] = f;
    });

    var MEDIA = /\.(png|jpe?g|gif|bmp|webp|mp3|wav|ogg|mp4|mov|avi|xlsx?|csv|tsv|odp)$/i;
    var declaredNames = declared.map(function (d) { return d.name; });

    // 2a. 若拖进来了 .psyexp，用它做一次权威的资源发现（补齐导出物漏声明的）
    var psyexpFile = files.find(function (f) { return /\.psyexp$/i.test(f.name); });
    if (psyexpFile) {
      var names = discoverFromPsyexp(new TextDecoder('utf-8').decode(psyexpFile.data));
      var added = 0;
      names.forEach(function (n) {
        if (declaredNames.indexOf(n) >= 0) return;
        var f = byName[n] || byName[n.split('/').pop()];
        if (!f) return;                                  // 工程里引用了但这个文件夹没带
        declared.push({ name: n, p: n });
        declaredNames.push(n);
        var patcherP = makePatcher(function () { return js; }, function (v) { js = v; }, []);
        patcherP('inject-resources', /resources:\s*\[/,
          function (m) { return m[0] + "\n    {'name': '" + n + "', 'path': '" + n + "'},"; });
        added++;
      });
      say('用 .psyexp 校验资源清单：' + names.length + ' 个引用，补齐 ' + added + ' 个漏登记的');
    }

    // 2b. 兜底：凡是拖进来的、看起来像刺激/条件文件的，都补登记
    var extra = files.filter(function (f) {
      if (!MEDIA.test(f.name)) return false;
      if (declaredNames.indexOf(f.name) >= 0) return false;
      return true;
    });
    extra.forEach(function (f) {
      declared.push({ name: f.name, p: f.name });
      say('补登记资源（导出物未声明）：' + f.name);
    });
    // 补进 JS 的 resources 数组，否则实验运行时取不到
    if (extra.length) {
      var patcher0 = makePatcher(function () { return js; }, function (v) { js = v; }, []);
      patcher0('inject-resources', /resources:\s*\[/,
        function (m) { return m[0] + '\n    ' + extra.map(function (f) { return "{'name': '" + f.name + "', 'path': '" + f.name + "'},"; }).join('\n    '); });
    }

    // 内联资源：图片 → HTMLImageElement 可用的 data URI；条件文件 → ArrayBuffer
    var inlineMap = {};
    var resReport = [];
    function bytesToB64(u8) {
      var CH = 0x8000, s = '';
      for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      return btoa(s);
    }
    declared.forEach(function (d) {
      var ext = (d.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
      var f = byName[d.p] || byName[d.name] || byName[d.p.split('/').pop()];
      var isRemote = /^https?:\/\//i.test(d.p);
      if (!f && isRemote) {
        inlineMap[d.name] = { type: 'image', data: PLACEHOLDER_PNG, fallback: null };
        resReport.push(d.name + '  远端→本地占位 1×1 PNG');
        return;
      }
      if (!f) {
        inlineMap[d.name] = { type: 'image', data: PLACEHOLDER_PNG, fallback: null };
        resReport.push(d.name + '  ⚠️ 未拖入 → 占位（实验可能报 unknown resource）');
        return;
      }
      var isImg = /\.(png|jpe?g|gif|bmp|webp)$/i.test(d.name);
      var mime = isImg ? ('image/' + (ext === '.jpg' ? 'jpeg' : ext.slice(1)))
        : /\.xlsx?$/i.test(d.name) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : /\.csv$/i.test(d.name) ? 'text/csv' : 'application/octet-stream';
      inlineMap[d.name] = {
        type: isImg ? 'image' : 'binary',
        data: 'data:' + mime + ';base64,' + bytesToB64(f.data),
        fallback: isImg ? PLACEHOLDER_PNG : null
      };
      resReport.push(d.name + '  ' + (isImg ? '图片' : '二进制') + '  ' + (f.data.length / 1024).toFixed(1) + ' KB');
    });

    // ③ 定点补丁（与 Node 版同一套规则）
    var applied = [];
    var patch = makePatcher(function () { return js; }, function (v) { js = v; }, applied);

    patch('install-inline-resources', /(const psychoJS = new PsychoJS\([^)]*\);)/,
      '$1\npsywebInstallInlineResources(psychoJS, PSYWEB_INLINE_RESOURCES);' +
      '\npsywebInstallStartGate(psychoJS, { title: window.PSYWEB_META.title, expName: window.PSYWEB_META.expName });' +
      '\npsywebAutoDrive(psychoJS);');

    patch('start-gate',
      /psychoJS\.schedule\(psychoJS\.gui\.DlgFromDict\(\{[\s\S]*?\}\)\);\s*\n\s*const flowScheduler = new Scheduler\(psychoJS\);\s*\n\s*const dialogCancelScheduler = new Scheduler\(psychoJS\);\s*\n\s*psychoJS\.scheduleCondition\(function\(\)\s*\{\s*return \(psychoJS\.gui\.dialogComponent\.button === 'OK'\);\s*\},?\s*flowScheduler, dialogCancelScheduler\);/,
      'const flowScheduler = new Scheduler(psychoJS);\n' +
      'const dialogCancelScheduler = new Scheduler(psychoJS);\n' +
      'psychoJS.schedule(function psywebGate() {\n' +
      '  var ready = (window.PSYWEB_RESOURCES_READY === true) && (window.PSYWEB_STARTED === true);\n' +
      '  if (ready) { psychoJS.schedule(flowScheduler); return Scheduler.Event.NEXT; }\n' +
      '  return Scheduler.Event.FLIP_REPEAT;\n' +
      '});');

    patch('dump-on-quit', /(async\s+)?function quitPsychoJS\(message, isCompleted\)\s*\{/,
      function (m) { return m[0] + "\n  psywebDump(psychoJS, isCompleted ? 'completed' : 'aborted');"; });

    // ④ 补丁后自检
    var MUST = [
      ['资源改道注入', /psywebInstallInlineResources\(psychoJS, PSYWEB_INLINE_RESOURCES\);/],
      ['开始页注入', /psywebInstallStartGate\(psychoJS/],
      ['数据导出注入', /psywebDump\(psychoJS, isCompleted \? 'completed' : 'aborted'\);/],
      ['流程门禁注入', /function psywebGate\(\)/],
      ['实验起始调用', /psychoJS\.start\(\{/]
    ];
    var missing = MUST.filter(function (p) { return !p[1].test(js); }).map(function (p) { return p[0]; });
    if (missing.length) throw new Error('补丁后自检失败，缺少：' + missing.join('、'));

    // ⑤ 组装单文件
    var esc = function (s) { return String(s).replace(/<\//g, '<\\/'); };
    var inlineJson = esc(JSON.stringify(inlineMap));
    var meta = { title: opts.title || '在线实验', expName: opts.expName || 'experiment', builtAt: new Date().toISOString(), builtBy: 'psyweb 在线工具' };
    var html = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">\n' +
      '<title>' + meta.title + '</title>\n<style>\nhtml,body{margin:0;padding:0;background:#000}\n' +
      assets.jqueryUiCss + '\n' + assets.css + '\n' +
      '#psyweb-meta{position:fixed;left:0;bottom:0;font:11px system-ui;color:#888;opacity:.5;padding:2px 6px;z-index:99999;pointer-events:none}\n' +
      '</style>\n</head>\n<body>\n<div id="root"></div>\n' +
      '<div id="psyweb-meta">psyweb 便携包 · 单文件 · 离线可运行</div>\n\n' +
      '<script>window.PSYWEB_INLINE_RESOURCES = ' + inlineJson + ';</script>\n' +
      '<script>window.PSYWEB_META = ' + esc(JSON.stringify(meta)) + ';</script>\n' +
      '<script>' + assets.jquery + '</script>\n' +
      '<script>' + assets.jqueryUi + '</script>\n' +
      '<script>' + assets.preload + '</script>\n' +
      '<script>' + assets.pako + '</script>\n' +
      '<script>' + assets.qrcode + '</script>\n' +
      '<script>' + assets.psychoJs + '</script>\n' +
      '<script>' + assets.shim + '</script>\n' +
      '<script>\n' + js + '\n</script>\n</body>\n</html>\n';

    say('✅ 组装完成：' + (html.length / 1048576).toFixed(2) + ' MB，补丁 ' + applied.length + ' 处，资源 ' + Object.keys(inlineMap).length + ' 个');
    return { html: html, log: log, meta: meta, applied: applied, resources: resReport, changes: fixed.changes, todos: fixed.todos };
  }

  return { pack: pack, fixJsCode: fixJsCode, SHIMS: SHIMS, PLACEHOLDER_PNG: PLACEHOLDER_PNG };
});
