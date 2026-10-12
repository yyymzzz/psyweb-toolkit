/* ============================================================================
 * ref-closure —— 引用闭包解析器（通用，不绑任何具体实验）
 * ----------------------------------------------------------------------------
 * 要解决的问题
 *   旧筛选是**黑名单**：挡掉 data/ 和少数扩展名，其余全收。用户拖进一个
 *   7 万文件的实验项目目录时，会把 73,412 个文件 / 416.7 MB 全塞进上传
 *   （实测复现，见 spike/m0/src/recon-exp2.js）。
 *
 * 原理（用户原话）：**从必要的文件出发，解析代码里的路径，反向寻找所需的文件**
 *   入口(psyexp) ──解析代码里的路径──▶ 被引用的文件 ──递归──▶ 不动点
 *   路径有四种形态，全部要能解析：
 *     ① 循环的 conditionsFile —— 直接就是一个路径字面量
 *     ② 组件参数字面量        —— 例如 val="stim_left.png"
 *     ③ 组件参数动态表达式    —— 例如 $os.path.join(STIM_DIR, image)
 *     ④ CodeComponent 里的常量 —— 例如 STIM_DIR = os.path.join(_thisDir, os.pardir, '材料')
 *   ③ 必须靠 ④ 折叠出来的目录 + 条件表的**列值**才能还原成真实路径；
 *   这正是"读内容判断"而不是"看文件名/位置猜"的关键。
 *
 * 为什么自己写 psyexp 扫描器（不复用 psyexp-audit）
 *   psyexp-audit 依赖 fast-xml-parser + fs，只能在 Node 里跑；而网页版/离线版
 *   是纯前端，必须也走同一套解析。**两份实现会漂移** —— site/pack-core.js 与
 *   src/pack-portable.js 已经因为"有意重复的两份实现"吃过亏。所以这里写一份
 *   UMD、零依赖的扫描器，两边共用；正确性由 spike/m0/src/test-ref-closure.js
 *   的 **对拍**（与 psyexp-audit 的真 XML 解析器比对组件/参数清单）钉死。
 *
 * 用法（Node）
 *   const R = require('./ref-closure.js');
 *   const res = R.resolve({ psyexpRel, psyexpText, readText, exists, getTableRows });
 * 用法（浏览器）
 *   用 script 标签引入本文件 → window.PsywebRefClosure
 *   （注意：本文件会被 tool-server.js **整段内联**进页面，所以文件里绝不能出现
 *     结束标签的字面写法——HTML 解析器不认识 JS 注释，照样会提前截断脚本块。
 *     tool-server.js 的 readInline() 会在内联前挡住这种序列。）
 *   getTableRows 换成 pako 版实现（接口一致：relPath → string[][] | null）
 *
 * 返回
 *   {
 *     refs: [{ path, role: 'table'|'media', source, missing? }],  // 相对 psyexp 所在目录
 *     constants: { STIM_DIR: '../材料', ... },
 *     notes: [...],        // 人话说明（降级必须在这里说清楚，不许静默）
 *     degraded: bool,      // true = 静态解析不足以覆盖，调用方应改用保守筛选
 *     unresolved: [...],      // 解析不出的**媒体**引用（人话描述）
 *     unresolvedTables: [...] // 解析不出的**条件表**引用。调用方必须把所选目录里的
 *                             // 条件表一并带上（表以 KB 计），否则实验会跑到一半
 *                             // 报 unknown resource —— 而 refs 非空时 degraded 仍是 false。
 *   }
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PsywebRefClosure = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- 路径工具
   * 不用 Node 的 path —— 浏览器里没有；语义必须与 os.path.join 一致。 */
  function normPath(p) {
    var s = String(p == null ? '' : p).replace(/\\/g, '/');
    var abs = s.charAt(0) === '/';
    var parts = s.split('/'), out = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (out.length && out[out.length - 1] !== '..') out.pop();
        else if (!abs) out.push('..');
        continue;
      }
      out.push(seg);
    }
    return (abs ? '/' : '') + out.join('/');
  }
  function joinPath() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      if (a === '' || a == null) continue;
      parts.push(String(a));
    }
    return normPath(parts.join('/'));
  }
  function dirName(p) {
    var s = String(p == null ? '' : p).replace(/\\/g, '/');
    var i = s.lastIndexOf('/');
    return i < 0 ? '' : s.slice(0, i);
  }
  function baseName(p) {
    var s = String(p == null ? '' : p).replace(/\\/g, '/');
    var i = s.lastIndexOf('/');
    return i < 0 ? s : s.slice(i + 1);
  }

  /* ---------------------------------------------------------------- 实体解码
   * .psyexp 里代码类参数是双重转义的（&amp;#10; → &#10; → 换行）。
   * 少解一次，基于换行/引号的代码检查全部失准 —— 这是 psyexp-audit 踩过的坑，
   * 这里保持同一口径。 */
  var NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function decodeOnce(s) {
    if (typeof s !== 'string' || s.indexOf('&') === -1) return s;
    return s.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, function (m, body) {
      if (body.charAt(0) === '#') {
        var cp = (body.charAt(1) === 'x' || body.charAt(1) === 'X')
          ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return isFinite(cp) ? String.fromCodePoint(cp) : m;
      }
      return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : m;
    });
  }
  function decodeParam(val, valType) {
    var once = decodeOnce(val == null ? '' : String(val));
    return (valType === 'code' || valType === 'extendedCode') ? decodeOnce(once) : once;
  }

  /* ---------------------------------------------------------------- psyexp 扫描
   * 只依赖"元素名 + 属性"这两个稳定事实；属性顺序在文件里**不固定**
   * （name 可能在前也可能在后），所以属性解析用通用正则，不写死顺序。 */
  function parseAttrs(s) {
    var out = {}, re = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g, m;
    while ((m = re.exec(s)) !== null) out[m[1]] = m[2];
    return out;
  }
  function readParams(body) {
    var out = {}, re = /<Param\b([^>]*?)\/?>/g, m;
    while ((m = re.exec(body)) !== null) {
      var a = parseAttrs(m[1]);
      if (a.name === undefined) continue;
      var vt = a.valType || 'str';
      out[a.name] = {
        val: a.val,
        valType: vt,
        updates: a.updates || 'None',
        decoded: decodeParam(a.val, vt)
      };
    }
    return out;
  }

  function scanPsyexp(xml) {
    var text = String(xml == null ? '' : xml);
    var components = [], loops = [], fileParams = [];

    // 组件块：<XxxComponent name="..." ...> … </XxxComponent>
    var compRe = /<([A-Za-z_][\w.-]*Component)\b([^>]*)>([\s\S]*?)<\/\1>/g, cm;
    while ((cm = compRe.exec(text)) !== null) {
      var type = cm[1];
      var openAttrs = parseAttrs(cm[2]);
      var params = readParams(cm[3]);
      var name = openAttrs.name !== undefined ? openAttrs.name : '(未命名)';
      components.push({ type: type, name: name, params: params });
      for (var k in params) {
        if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
        if (String(params[k].valType) === 'file') {
          fileParams.push({ component: name, componentType: type, name: k, val: params[k].decoded, valType: 'file' });
        }
      }
    }

    // 循环：conditionsFile 是**循环**声明的条件表（元素的 loopType 属性是循环类型，
    // Param 里那个同名 loopType 才是抽样方法 —— 两者别混，psyexp-audit 有同样的注记）
    var loopRe = /<LoopInitiator\b([^>]*)>([\s\S]*?)<\/LoopInitiator>/g, lm;
    while ((lm = loopRe.exec(text)) !== null) {
      var la = parseAttrs(lm[1]);
      var lp = readParams(lm[2]);
      loops.push({
        name: la.name || '',
        loopType: la.loopType || 'TrialHandler',
        conditionsFile: lp.conditionsFile ? String(lp.conditionsFile.decoded).trim() : '',
        params: lp
      });
    }

    return { components: components, loops: loops, fileParams: fileParams };
  }

  /* ---------------------------------------------------------------- 参数表达式求值
   * 支持：'字面量' / os.pardir / _thisDir / 已知常量 / 嵌套 os.path.join(...)
   * 返回 null 表示"静态求不出"（调用方据此给降级说明）。 */
  function splitArgs(s) {
    var out = [], depth = 0, cur = '', q = null;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (q) {
        cur += c;
        if (c === q && s.charAt(i - 1) !== '\\') q = null;
        continue;
      }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim() !== '') out.push(cur);
    return out;
  }

  function evalExpr(expr, consts, depth) {
    if (depth > 6) return null;
    var a = String(expr == null ? '' : expr).trim();
    if (a === '') return null;
    var lit = /^['"]([\s\S]*)['"]$/.exec(a);
    if (lit) return lit[1];
    if (a === 'os.pardir' || a === 'os.path.pardir') return '..';
    if (a === '_thisDir' || a === 'thisDir') return '';
    if (Object.prototype.hasOwnProperty.call(consts, a)) return consts[a];
    var j = /^os\.path\.join\(([\s\S]*)\)$/.exec(a);
    if (j) {
      var args = splitArgs(j[1]), vals = [];
      for (var i = 0; i < args.length; i++) {
        var v = evalExpr(args[i], consts, depth + 1);
        if (v === null) return null;
        vals.push(v);
      }
      return joinPath.apply(null, vals);
    }
    return null;
  }

  /** 折叠 CodeComponent 里的 `NAME = os.path.join(...)` 常量（迭代到不动点） */
  function foldConstants(codeTexts) {
    var consts = { _thisDir: '.' };
    var all = (codeTexts || []).join('\n');
    var re = /^[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*(os\.path\.join\([\s\S]*?\))[ \t]*(?:#.*)?$/gm;
    var changed = true, guard = 0;
    while (changed && guard++ < 8) {
      changed = false;
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(all)) !== null) {
        var lhs = m[1];
        if (lhs === 'os' || lhs === '_thisDir') continue;
        var v = evalExpr(m[2], consts, 0);
        if (v === null) continue;
        var norm = normPath(v);
        if (consts[lhs] !== norm) { consts[lhs] = norm; changed = true; }
      }
    }
    return consts;
  }

  /* ---------------------------------------------------------------- 常量表判定 */
  var TABLE_EXT = /\.(xlsx?|csv|tsv|odp|json)$/i;
  var MEDIA_EXT = /\.(png|jpe?g|gif|bmp|webp|svg|mp3|wav|ogg|mp4|mov|avi|webm)$/i;
  var ANY_FILE = /\.(png|jpe?g|gif|bmp|webp|svg|mp3|wav|ogg|mp4|mov|avi|webm|xlsx?|csv|tsv|odp)$/i;
  function looksLikeTable(p) { return TABLE_EXT.test(baseName(p)); }
  function isDynamic(v) { return /[$\[\]{}]|\.format\s*\(|thisTrial|\+/.test(v); }
  function cleanVal(v) {
    return String(v == null ? '' : v).trim().replace(/^['"]|['"]$/g, '').trim();
  }

  /* ---------------------------------------------------------------- 主入口 */
  function resolve(opts) {
    opts = opts || {};
    var notes = [], refs = [], seen = {};
    // 条件表引用里"知道有、但静态解析不出具体文件"的那些（例如
    // conditionsFile="$\"group{}.xlsx\".format(expInfo['group'])"）。
    // ⚠️ 必须与"这个实验没有任何引用"分开：前者宁可多带，后者是正常（纯文字实验）。
    // 曾经混为一谈 → 页面显示"闭包给出 0 个文件"，静默出一个缺条件表的包。
    var unresolvedTables = [];
    var bad = function (msg) { notes.push(msg); };
    var addRef = function (p, role, source) {
      var key = p;
      if (seen[key]) return false;
      seen[key] = true;
      refs.push({ path: p, role: role, source: source });
      return true;
    };
    var exists = typeof opts.exists === 'function' ? opts.exists : null;
    var getTableRows = typeof opts.getTableRows === 'function' ? opts.getTableRows : null;

    // 入口有**两个**：.psyexp（本地工具/带 psyexp 的导出物）与导出脚本 xxx.js
    // （网页版/离线版的输入是"Export HTML 生成的文件夹"，通常**没有 psyexp**）。
    // ⚠️ 曾经写成"没有 psyexp 就直接降级" —— 那会让网页版的精确选择**从来没生效过**
    //    （一路走保守筛选）。两个入口必须都认。
    if (!opts.psyexpText && !opts.jsText) {
      bad('⚠️ 既没有 .psyexp 也没有导出脚本 —— 无法解析引用闭包，改用保守筛选（按扩展名保留）');
      return { refs: [], constants: {}, notes: notes, degraded: true, unresolvedTables: [] };
    }

    var scan;
    try {
      scan = opts.psyexpText ? scanPsyexp(opts.psyexpText) : { components: [], loops: [], fileParams: [] };
    } catch (e) {
      bad('⚠️ .psyexp 解析失败（' + (e && e.message) + '）—— 改用保守筛选');
      return { refs: [], constants: {}, notes: notes, degraded: true, unresolvedTables: [] };
    }
    // Older Builder files label image/sound/movie as str although they are files.
    scan.components.forEach(function (component) {
      ['image', 'sound', 'movie'].forEach(function (name) {
        var param = component.params[name];
        if (param && param.valType !== 'file') scan.fileParams.push({component:component.name, name:name, val:param.decoded});
      });
    });

    // ---- ① 折叠路径常量（CodeComponent 的 code 类参数）----
    var codeTexts = [];
    scan.components.forEach(function (c) {
      for (var k in c.params) {
        if (!Object.prototype.hasOwnProperty.call(c.params, k)) continue;
        var vt = String(c.params[k].valType);
        if (vt === 'code' || vt === 'extendedCode') codeTexts.push(String(c.params[k].decoded || ''));
      }
    });
    var consts = foldConstants(codeTexts);
    var constNames = [];
    for (var ck in consts) { if (Object.prototype.hasOwnProperty.call(consts, ck) && ck !== '_thisDir') constNames.push(ck + '=' + consts[ck]); }
    if (constNames.length) bad('路径常量已折叠：' + constNames.join('、'));

    // ---- ② 条件表：循环声明的 + 文件型参数里的 ----
    /* 动态 conditionsFile 的一线生机：Builder 允许把条件表名写在**循环自己的**
     * 内联 conditions 里，再用 $变量 引用那一列。例如官方 demo faceHouseBlocks：
     *   <Param name="conditions"     val="[{u'condsFile': u'faceTrials.xlsx'}, …]"/>
     *   <Param name="conditionsFile" val="$condsFile"/>
     * 这不是猜目录、也不是猜文件名 —— 值就写在 psyexp 里，属"读内容判断"。
     * 解析出来就按普通条件表进闭包；解析不出才计入 unresolvedTables。 */
    function tablesFromInlineLoop(lp, raw) {
      var bare = String(raw).replace(/^\$/, '').trim();
      if (!/^[A-Za-z_]\w*$/.test(bare)) return [];   // 表达式形态（xxx.format(...)）没有列可查
      var p = lp.params && lp.params.conditions;
      if (!p) return [];
      var txt = String(p.decoded == null ? '' : p.decoded);
      if (!txt) return [];
      var re = new RegExp("['\"]" + bare + "['\"]\\s*:\\s*[uU]?['\"]([^'\"]+)['\"]", 'g');
      var m, out = [];
      while ((m = re.exec(txt)) !== null) {
        var v = m[1].trim();
        if (!v) continue;
        var rel = normPath(v);
        if (out.indexOf(rel) >= 0) continue;
        if (exists && !exists(rel)) continue;        // 值不是真实存在的文件 → 不算解析成功
        out.push(rel);
      }
      return out;
    }

    var tables = [];
    scan.loops.forEach(function (lp) {
      var cf = cleanVal(lp.conditionsFile);
      if (!cf) return;
      if (isDynamic(cf)) {
        var fromInline = tablesFromInlineLoop(lp, cf);
        if (fromInline.length) {
          fromInline.forEach(function (rel) {
            if (addRef(rel, 'table', 'loop:' + lp.name + ' ← 内联 conditions 列')) tables.push(rel);
          });
          bad('循环 ' + lp.name + ' 的 conditionsFile 是动态表达式（' + cf
            + '），已从该循环的内联 conditions 列解析出 ' + fromInline.length + ' 张表：' + fromInline.join('、'));
          return;
        }
        bad('⚠️ 循环 ' + lp.name + ' 的 conditionsFile 是动态表达式（' + cf + '），静态解析不出具体文件');
        unresolvedTables.push('loop:' + lp.name + ' → ' + cf);
        return;
      }
      if (addRef(normPath(cf), 'table', 'loop:' + lp.name)) tables.push(normPath(cf));
    });
    scan.fileParams.forEach(function (fp) {
      if (!/conditions?file/i.test(fp.name)) return;
      var v = cleanVal(fp.val);
      if (!v) return;
      if (isDynamic(v)) {
        bad('⚠️ ' + fp.component + '.' + fp.name + ' 是动态表达式（' + v + '），静态解析不出具体文件');
        unresolvedTables.push('param:' + fp.component + '.' + fp.name + ' → ' + v);
        return;
      }
      if (addRef(normPath(v), 'table', 'param:' + fp.component + '.' + fp.name)) tables.push(normPath(v));
    });

    // ---- ②b 导出脚本的 resources 清单（网页版/离线版的主要入口）----
    // 网页版的输入是"Export HTML 生成的文件夹"，通常**没有 psyexp**，此时
    // 主脚本里那份 resources 清单就是唯一的一手声明。清单不完整（动态引用的
    // 媒体它不写），但凡是它写了的都必须带上 —— 否则运行时 unknown resource。
    if (opts.jsText) {
      var man;
      try { man = scanJsManifest(opts.jsText); }
      catch (e) { bad('⚠️ 主脚本资源结构不可识别：' + e.message); man = []; }
      if (man.length) {
        var remote = 0;
        man.forEach(function (e) {
          var p = e.path || e.name;
          if (!p) return;
          if (isRemotePath(p)) { remote++; return; }
          var np = normPath(p);
          if (looksLikeTable(np)) { if (addRef(np, 'table', 'manifest')) tables.push(np); }
          else addRef(np, 'media', 'manifest');
          // 清单里的 name 与 path 可能不同（例如 name='..\数据\试次表.csv', path='../数据/试次表.csv'）
          var nn = normPath(e.name);
          if (nn && nn !== np && !isRemotePath(e.name)) {
            if (looksLikeTable(nn)) { if (addRef(nn, 'table', 'manifest:name')) tables.push(nn); }
            else addRef(nn, 'media', 'manifest:name');
          }
        });
        bad('主脚本 resources 清单：' + man.length + ' 条' + (remote ? '（其中 ' + remote + ' 条是远端 URL，用占位图替代）' : ''));
      } else {
        bad('⚠️ 主脚本里没有可解析的 resources 清单 —— 只能靠 psyexp/条件表，若两者都没有则退回保守筛选');
      }
    }

    // ---- ③ 读条件表内容 → 建"列名 → 值列表"索引 ----
    // 零引用的动态表先读小条件表，再从列值推媒体；已有引用保持原精度。
    if (!refs.length && unresolvedTables.length && opts.candidateTables) {
      opts.candidateTables.forEach(function (rel) {
        rel = normPath(rel);
        if (looksLikeTable(rel) && addRef(rel, 'table', 'dynamic-table-sweep')) tables.push(rel);
      });
    }
    var columns = {};          // 列名 → [值...]
    var columnsFrom = {};      // 列名 → [来源表...]
    var tableRead = {}, pending = tables.slice(), guard = 0, tableFailures = 0;
    while (pending.length && guard++ < 4) {
      var batch = pending; pending = [];
      batch.forEach(function (rel) {
        if (tableRead[rel]) return;
        tableRead[rel] = true;
        if (!getTableRows) { tableFailures++; bad('没有提供条件表读取器，无法读取 ' + rel + ' 的内容'); return; }
        var rows;
        try { rows = getTableRows(rel); } catch (e) { rows = null; }
        if (!rows || !rows.length) { tableFailures++; bad('条件表读不出来：' + rel + '（实验运行时可能取不到该表）'); return; }
        var header = (rows[0] || []).map(function (h) { return String(h == null ? '' : h).trim(); });
        if (!header.some(function (h) { return h !== ''; })) { bad('条件表 ' + rel + ' 首行不是表头，未纳入列索引'); return; }
        for (var r = 1; r < rows.length; r++) {
          var row = rows[r] || [];
          for (var i = 0; i < header.length; i++) {
            if (!header[i]) continue;
            var v = String(row[i] == null ? '' : row[i]).trim();
            if (v === '') continue;
            if (!columns[header[i]]) { columns[header[i]] = []; columnsFrom[header[i]] = []; }
            if (columns[header[i]].indexOf(v) < 0) columns[header[i]].push(v);
            if (columnsFrom[header[i]].indexOf(rel) < 0) columnsFrom[header[i]].push(rel);
          }
        }
        // 条件表里也可能引用别的条件表（少见，但递归一层不吃亏）
        var flat = rows.map(function (rw) { return (rw || []).join('\t'); }).join('\n');
        scanTokens(flat).forEach(function (tok) {
          if (!looksLikeTable(tok)) return;
          var p = joinPath(dirName(rel), tok);
          if (addRef(p, 'table', 'table:' + rel)) pending.push(p);
        });
      });
    }

    // ---- ④ 组件参数 → 引用 ----
    function resolveDynamic(val) {
      // $os.path.join(CONST, COLUMN) 或 $os.path.join(CONST, '字面量')
      var m = /^os\.path\.join\(\s*([^,]+?)\s*,\s*([^,]+?)\s*\)$/.exec(val);
      if (!m) return null;
      var dirRaw = m[1].trim();
      var dir = evalExpr(dirRaw, consts, 0);
      if (dir === null) {
        // 目录本身是运行期变量（例如 os.path.join(_thisDir, subVar)）→ 静态求不出
        return { unknownDir: dirRaw, tail: m[2].trim() };
      }
      var tail = m[2].trim();
      var litTail = evalExpr(tail, consts, 0);
      if (litTail !== null) return { paths: [joinPath(dir, litTail)] };
      if (!/^[A-Za-z_]\w*$/.test(tail)) return { unknownTail: tail };
      return { dir: dir, column: tail };
    }

    var unresolved = [];
    scan.fileParams.forEach(function (fp) {
      var raw = cleanVal(fp.val);
      if (!raw) return;
      var where = fp.component + '.' + fp.name;
      if (!isDynamic(raw)) {
        addRef(normPath(raw), 'media', 'param:' + where);
        return;
      }
      // 动态表达式先剥掉 "$"（Builder 用 $ 标记"这是表达式"）。
      // 坑：剥完必须**统一用 bare**，否则 "$left_img" 既能通过 isDynamic，
      // 又过不了后面的标识符判定，会被误报成"无法静态解析"（实测踩过）。
      var bare = raw.replace(/^\$/, '').trim();
      var r = resolveDynamic(bare);
      if (r && r.paths) { r.paths.forEach(function (p) { addRef(normPath(p), 'media', 'param:' + where); }); return; }
      if (r && r.dir !== undefined && r.column) {
        var vals = columns[r.column];
        if (!vals) { unresolved.push(where + ' → 列 "' + r.column + '" 在任何条件表里都没找到'); return; }
        vals.forEach(function (v) {
          var p = joinPath(r.dir, v);
          if (exists && !exists(p)) {
            // 值可能已经是相对 psyexp 的完整路径（条件表里写全路径很常见）
            var alt = normPath(v);
            if (exists(alt)) { addRef(alt, 'media', 'param:' + where + ' ← 列 ' + r.column + '(' + columnsFrom[r.column].join(',') + ')'); return; }
            return;   // 该目录下不存在 —— 另一个目录的候选会命中（见下）
          }
          addRef(p, 'media', 'param:' + where + ' ← 列 ' + r.column + '(' + columnsFrom[r.column].join(',') + ')');
        });
        return;
      }
      if (r && r.unknownDir) { unresolved.push(where + ' → 目录变量 ' + r.unknownDir + ' 静态求不出'); return; }
      if (/^[A-Za-z_]\w*$/.test(bare)) {
        var vals2 = columns[bare];
        if (!vals2) { unresolved.push(where + ' → 变量 "' + bare + '" 不是任何条件表的列名'); return; }
        vals2.forEach(function (v) {
          var p = normPath(v);
          if (exists && !exists(p)) return;
          addRef(p, 'media', 'param:' + where + ' ← 列 ' + bare + '(' + columnsFrom[bare].join(',') + ')');
        });
        return;
      }
      unresolved.push(where + ' → 动态表达式无法静态解析：' + raw);
    });

    // ---- ⑤ 内联 conditions 参数里的文件名 ----
    // Builder 允许把试次**直接写在 psyexp 里**而不是放进条件表文件：
    //   <LoopInitiator name="imageLoop">
    //     <Param name="conditions" val="[{'left_img': 'stim_a.png', ...}]"/>
    // 这些文件名同样是"被引用"的，必须收进闭包。
    // 注意**两处**都要看：组件上有（很少见），LoopInitiator 上也有（Builder 常见）。
    function scanInline(params, label) {
      var p = params && params.conditions;
      if (!p) return;
      scanTokens(String(p.decoded || '')).forEach(function (tok) {
        if (looksLikeTable(tok)) addRef(normPath(tok), 'table', label);
        else addRef(normPath(tok), 'media', label);
      });
    }
    scan.components.forEach(function (c) { scanInline(c.params, 'inline:' + c.name); });
    scan.loops.forEach(function (lp) { scanInline(lp.params, 'inline-loop:' + lp.name); });

    // ---- ⑥ 收尾：未能命中"任何目录"的列值，再按 basename 兜一次 ----
    // 场景：条件表某列写了文件名，而代码用的目录常量静态解析失败 —— 这时
    // 至少把"名字"报出去，让调用方能在整个目录树里按文件名找回。
    // 注意：这只对**已被引用**的名字生效，不是把整棵树拉进来。
    if (unresolved.length) {
      bad('⚠️ 有 ' + unresolved.length + ' 处动态引用无法静态解析（' + unresolved.slice(0, 3).join('；') + '）');
    }

    // 标注存在性（供调用方与日志使用）
    if (exists) {
      refs.forEach(function (r) { if (!exists(r.path)) r.missing = true; });
      var miss = refs.filter(function (r) { return r.missing; });
      if (miss.length) bad('⚠️ 有 ' + miss.length + ' 个引用的文件按代码给出的路径没找到：' + miss.slice(0, 5).map(function (r) { return r.path; }).join('、'));
    }

    if (unresolvedTables.length) {
      bad('⚠️ 有 ' + unresolvedTables.length + ' 处条件表引用静态解析不出（'
        + unresolvedTables.slice(0, 3).join('；') + (unresolvedTables.length > 3 ? ' …' : '')
        + '）—— 调用方应把所选目录里的条件表一并带上（表体积以 KB 计）');
    }

    if (!refs.length) {
      // 一个引用都没有 —— 分两种情况，绝不能混：
      //   · 没有 psyexp（纯网页版入口）：主脚本清单也空 => 我们**根本不知道**要哪些文件，
      //     必须降级（静默传空集会让用户在"打包成功"的假象里丢资源）。
      //   · 有 psyexp：纯文字/纯代码实验本来就零资源，属正常，不是降级。
      //     ⚠️ 但"解析不出条件表"不算零资源 —— 那种情况必须降级，见下面的 unresolvedTables。
      if (!opts.psyexpText) {
        bad('⚠️ 主脚本里没有可用的 resources 清单，且没带 .psyexp —— 无法确定需要哪些文件，改用保守筛选（按扩展名保留）');
        return { refs: [], constants: consts, notes: notes, degraded: true, unresolved: unresolved, unresolvedTables: unresolvedTables };
      }
      if (!unresolved.length && !unresolvedTables.length) {
        bad('该 psyexp 没有任何文件型引用（纯文字/纯代码实验属正常）。');
      } else {
        bad('⚠️ 所有文件型引用都解析不出来 —— 改用保守筛选（按扩展名保留）');
        return { refs: [], constants: consts, notes: notes, degraded: true, unresolved: unresolved, unresolvedTables: unresolvedTables };
      }
    }

    return {
      refs: refs,
      constants: consts,
      notes: notes,
      // 已解析出的表/媒体不能证明另一处动态媒体引用是安全的。
      // 只要仍有媒体引用未解析，就交给调用方的保守筛选；表列可解析时
      // unresolved 为空，仍保留条件表反推媒体的精确闭包。
      degraded: unresolved.length > 0 || (tableFailures > 0 && refs.some(function (r) { return r.source === 'dynamic-table-sweep'; })),
      unresolved: unresolved,
      unresolvedTables: unresolvedTables,
      tables: Object.keys(tableRead)
    };
  }

  /* ---------------------------------------------------------------- 导出脚本的清单
   * 官方导出器（Builder → Export HTML / Pavlovia 同步）会在主脚本里写：
   *   psychoJS: { …, resources: [ {'name': 'cond.xlsx', 'path': 'cond.xlsx'}, … ] }
   * 属性顺序因导出版本而异（name 在前或 path 在前），两种都收。
   * ⚠️ 必须知道的局限：**动态引用的媒体不在清单里**（例如 image 参数写 $left_img）。
   *    官方 CLI 编译时工作目录是空临时目录，资源自动探测什么都找不到 ——
   *    实测某个真实导出物编译后的清单只剩一条远端 URL 占位图。所以清单只能当"入口之一"，
   *    完整性靠"条件表内容反查 + 路径常量折叠"，这正是 ref-closure 存在的理由。
   */
  function scanJsManifest(jsText) {
    return inspectStart(String(jsText || '')).entries;
  }

  // Small lexical reader: literals/comments/regexes cannot masquerade as start calls.
  function jsTokens(src) {
    var out = [], i = 0, operand = true, parens = [];
    function push(v, start, kind) { out.push({v:v, start:start, end:i, kind:kind}); }
    while (i < src.length) {
      var c = src[i], start = i;
      if (/\s/.test(c)) { i++; continue; }
      if (src.slice(i, i+2) === '//') { i = src.indexOf('\n', i); if(i < 0) break; continue; }
      if (src.slice(i, i+2) === '/*') { var e = src.indexOf('*/', i+2); if(e < 0) throw Error('Unclosed comment'); i=e+2; continue; }
      if (c === '"' || c === "'" || c === '`') {
        var quote = c; i++; var value = '', closed = false;
        while(i < src.length) {
          c=src[i++]; if(c === quote) {closed=true; break;}
          if(c === '\\') {
            var esc=src[i++], codes={n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v','0':'\0'};
            if(esc==='u' || esc==='x') {var n=esc==='u'?4:2, hex=src.slice(i,i+n); if(!new RegExp('^[0-9a-f]{'+n+'}$','i').test(hex)) throw Error('Unsupported string escape'); value+=String.fromCharCode(parseInt(hex,16)); i+=n;}
            else if(esc==='\n') {} else if(esc==='\r') {if(src[i]==='\n') i++;}
            else value+=Object.prototype.hasOwnProperty.call(codes,esc)?codes[esc]:esc;
          } else value+=c;
        }
        if(!closed) throw Error('Unclosed literal');
        push(value,start,quote==='`'?'template':'string'); operand=false; continue;
      }
      if(c==='/' && operand) {
        i++; var bracket=false, done=false;
        while(i<src.length) {c=src[i++]; if(c==='\\') {i++; continue;} if(c==='[') bracket=true; if(c===']') bracket=false; if(c==='/'&&!bracket) {done=true; break;} }
        if(!done) throw Error('Unclosed regex'); while(/[a-z]/i.test(src[i]||'') && i<src.length) i++;
        push('regex',start,'regex'); operand=false; continue;
      }
      var word=/^[A-Za-z_$][\w$]*|^\d+(?:\.\d+)?/.exec(src.slice(i));
      if(word) {i+=word[0].length; push(word[0],start,'word'); operand=/^(return|throw|case|delete|void|typeof|new|in|of|yield|await)$/.test(word[0]); continue;}
      var previous=out[out.length-1];
      if(c==='(') parens.push(!!(previous && /^(if|while|for|with|switch|catch)$/.test(previous.v)));
      i++; push(c,start,'punct'); operand=c===')' ? !!parens.pop() : !/[\]}]/.test(c) && c!=='.';
    }
    return out;
  }
  function inspectStart(src) {
    var t=jsTokens(src), matches=[];
    function is(k,v) {return t[k] && t[k].kind!=='string' && t[k].kind!=='template' && t[k].v===v;}
    for(var k=0;k<t.length;k++) if(is(k,'psychoJS')&&is(k+1,'.')&&is(k+2,'start')&&is(k+3,'(')) {
      if(is(k-1,'.')||is(k-1,'new')) throw Error('Expected direct psychoJS.start');
      matches.push(k+4);
    }
    if(matches.length!==1) throw Error('Expected one direct psychoJS.start call; found '+matches.length);
    var p=matches[0], fields={}, entries=[], arrayStart=null, arrayEnd=null;
    function need(v) {if(!is(p,v)) throw Error('Unsupported psychoJS.start structure: expected '+v); return t[p++];}
    need('{');
    while(!is(p,'}')) {
      var key=t[p++]; if(!key || !/^(expName|expInfo|resources)$/.test(key.v)||fields[key.v]) throw Error('Unknown or duplicate start field');
      fields[key.v]=true; need(':');
      if(key.v!=='resources') {need(key.v);}
      else {
        arrayStart=need('[').start;
        while(!is(p,']')) {
          need('{'); var item={};
          while(!is(p,'}')) {
            var prop=t[p++]; if(!prop||!/^(name|path)$/.test(prop.v)||Object.prototype.hasOwnProperty.call(item,prop.v)) throw Error('Unsupported resource field');
            need(':'); var val=t[p++]; if(!val||val.kind!=='string') throw Error('Resource name/path must be string literals'); item[prop.v]=val.v;
            if(is(p,',')) p++; else if(!is(p,'}')) throw Error('Unsupported resource object');
          }
          need('}'); if(typeof item.name!=='string'||typeof item.path!=='string') throw Error('Resource needs name and path'); entries.push(item);
          if(is(p,',')) p++; else if(!is(p,']')) throw Error('Unsupported resource array');
        }
        arrayEnd=need(']').end;
      }
      if(is(p,',')) p++; else if(!is(p,'}')) throw Error('Unsupported start object');
    }
    var close=need('}'); need(')');
    if(!fields.expName||!fields.expInfo) throw Error('Missing expName/expInfo');
    return {entries:entries, arrayStart:arrayStart, arrayEnd:arrayEnd, close:close.start};
  }
  function ensureResources(src) {
    var found=inspectStart(src);
    if(found.arrayStart!==null) return src;
    var prefix=src.slice(0,found.close), last=jsTokens(prefix).slice(-1)[0];
    return prefix+(last.v===','?'':',')+' resources: []'+src.slice(found.close);
  }
  function compilerDefaults(src) {
    var t=jsTokens(src);
    for(var i=0;i<t.length-7;i++) {
      if(t[i].v!=='new'||t[i+1].v!=='visual'||t[i+2].v!=='.'||t[i+3].v!=='ImageStim'||t[i+4].v!=='('||t[i+5].v!=='{') continue;
      var depth=1;
      for(var j=i+6;j<t.length&&depth;j++) {
        if(t[j].v==='{'&&t[j].kind==='punct')depth++;
        if(t[j].v==='}'&&t[j].kind==='punct')depth--;
        if(depth===1&&t[j].v==='image'&&t[j+1]?.v===':'&&t[j+2]?.kind==='string'&&t[j+2].v==='default.png') {
          return [{name:'default.png',path:'https://pavlovia.org/assets/default/default.png'}];
        }
      }
    }
    return [];
  }
  function repairTrialListFormat(src) {
    var t=jsTokens(src), replacements=[];
    for(var i=2;i<t.length-3;i++) {
      if(t[i].kind!=='string'||t[i-1].v!==':'||t[i-2].v!=='trialList'
          ||t[i+1].v!=='.'||t[i+2].v!=='format'||t[i+3].v!=='('||t[i].v.indexOf('{}')<0) continue;
      if(t[i].v!=='group{}.xlsx'||t[i+4]?.v!=='expInfo'||t[i+5]?.v!=='['
          ||t[i+6]?.kind!=='string'||t[i+6].v!=='group'||t[i+7]?.v!==']'||t[i+8]?.v!==')') {
        throw Error('Unsupported automatic trialList format expression');
      }
      var value='group{0}.xlsx';
      replacements.push({start:t[i].start,end:t[i].end,value:JSON.stringify(value).split('<').join('\\u003c')});
    }
    for(var j=replacements.length-1;j>=0;j--) {
      var r=replacements[j];src=src.slice(0,r.start)+r.value+src.slice(r.end);
    }
    return src;
  }
  function injectResources(src, entries) {
    src=ensureResources(src); var found=inspectStart(src);
    var names=Object.create(null); found.entries.forEach(function(e){names[e.name]=e.path;});
    entries=entries.filter(function(e){ var name=String(e.name), path=String(e.path); if(Object.prototype.hasOwnProperty.call(names,name)){if(names[name]!==path) throw Error('Conflicting resource name');return false;} names[name]=path;return true;});
    if(!entries.length) return src;
    var old=src.slice(found.arrayStart+1,found.arrayEnd-1), values=entries.map(function(e){return JSON.stringify({name:String(e.name),path:String(e.path)}).split('<').join('\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');}).join(',');
    return src.slice(0,found.arrayStart+1)+values+(values&&old.trim()?',':'')+old+src.slice(found.arrayEnd-1);
  }
  function isRemotePath(p) { return /^(https?:)?\/\//i.test(String(p == null ? '' : p)); }

  /** 从任意文本里扫出"像文件名"的 token（用于内联 conditions 参数与条件表内容） */
  function scanTokens(text) {
    var out = [], seen = {};
    var re = /[^\s,'"\[\]{}()<>|:*?]+\.(?:png|jpe?g|gif|bmp|webp|svg|mp3|wav|ogg|mp4|mov|avi|webm|xlsx?|csv|tsv|odp)/gi;
    var m;
    while ((m = re.exec(String(text == null ? '' : text))) !== null) {
      var t = m[0].replace(/^[\\/]+/, '');
      if (t === '' || seen[t]) continue;
      seen[t] = true;
      out.push(t);
    }
    return out;
  }

  return {
    resolve: resolve,
    scanPsyexp: scanPsyexp,
    scanJsManifest: scanJsManifest,
    inspectStart: inspectStart,
    ensureResources: ensureResources,
    injectResources: injectResources,
    compilerDefaults: compilerDefaults,
    repairTrialListFormat: repairTrialListFormat,
    isRemotePath: isRemotePath,
    foldConstants: foldConstants,
    evalExpr: evalExpr,
    scanTokens: scanTokens,
    normPath: normPath,
    joinPath: joinPath,
    dirName: dirName,
    baseName: baseName,
    TABLE_EXT: TABLE_EXT,
    MEDIA_EXT: MEDIA_EXT
  };
});
