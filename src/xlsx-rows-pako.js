/* ============================================================================
 * xlsx-rows-pako —— 浏览器可用的 xlsx 读取器（只靠 pako，自己解 zip）
 * ----------------------------------------------------------------------------
 * 为什么需要它
 *   Node 侧读条件表用的是 SheetJS（vendor/xlsx.full.min.js，922 KB）。网页版和
 *   离线单文件版跑在浏览器里，**没有 SheetJS**，只有 pako（vendor/pako.min.js，
 *   46 KB，本来就要为二维码/gzip 载荷带进包）。把 SheetJS 塞进单文件版会让产物
 *   再胖近 1 MB，而且离线版是"整段内联"的打包方式，代价直接落在用户手上。
 *   所以这里自己解：xlsx 就是 zip + 几个 XML，需要的那部分并不复杂。
 *
 * 接口契约（与 Node 侧 getTableRows 的 xlsx 分支逐字同口径）
 *   XlsxRows.fromBytes(u8, pako) -> string[][] | null
 *     u8    Uint8Array（或 Buffer / ArrayBuffer）—— xlsx 文件的全部字节
 *     pako  pako 对象（浏览器 window.pako / Node require('pako.min.js')）
 *           只用到 pako.inflateRaw；**不 require，由调用方注入**（零硬依赖）
 *   返回  [[cell, ...], ...]：
 *           · row[0] 是表头；多 sheet 按 xl/workbook.xml 里 <sheet> 的**顺序**拼接
 *           · 空行（整行无单元格）不产出；空 sheet 不产出任何行
 *           · 行尾没有的单元格不补；行中间缺的格子补 ''（靠 r 属性对齐列）
 *           · 每个单元格都是 String，空/缺一律 ''
 *           · 解析不了（不是 zip / 缺 xl/workbook.xml / 一张表都读不出来）返回 null
 *         **任何情况下都不抛异常**（浏览器里炸掉整包比少读一张表严重得多）
 *
 * 与 SheetJS 的一致性由谁保证
 *   spike/m0/src/test-xlsx-rows.js —— 对拍测试：
 *     · 三个真实条件表逐行逐格比对（SheetJS 侧写法与 src/pack-portable.js 完全一致）
 *     · 手工合成的 xlsx（可控 XML）覆盖 inlineStr / 共享串 / 富文本 / 实体 / rPh /
 *       列跳号 / 缺 r 属性 / dimension 语义 / 多 sheet 顺序 / 绝对 target
 *     · 反例（非 zip、空字节）+ 故意改一个字符的**自证伪**
 *   跑法：node spike/m0/src/test-xlsx-rows.js   （退出码 0 = 全绿）
 *
 * 已知局限（不掩盖，测试里用"声明差异清单"逐条打印实测值）
 *   1. 数值单元格返回 <v> 的**原样文本**（如 1.50 就是 "1.50"）；SheetJS 走 SSF
 *      General 重排（"1.5"、1E+15、0.3）。真实条件表里没有数值列，故对拍全绿；
 *      若要 SheetJS 完全一致需连带解析 xl/styles.xml 的 numFmt。
 *   2. 日期单元格同理：不读样式表，返回序列号（43831）而不是 "2015-01-01"。
 *   3. t="e"（错误值）返回 <v> 原文；SheetJS 0.14.2 会把它丢掉。
 *   4. 共享串索引越界时返回 ''（SheetJS 在同样输入下会抛异常）。
 *   5. ZIP64（>4 GB / 带 ZIP64 扩展字段的包）不支持，直接返回 null。
 *   6. XML 一律按 UTF-8 解码（xlsx 事实标准），不认 UTF-16 声明。
 *
 * 注意：本文件会被 tool-server.js 整段内联进页面，文件里不能出现脚本结束标签的
 *   字面写法（HTML 解析器不认 JS 注释，会提前截断脚本块）—— 与 ref-closure.js 同规矩。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PsywebXlsxRows = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ======================================================== 0. 字节小工具 */

  function toBytes(v) {
    if (v == null) return null;
    if (typeof Uint8Array !== 'undefined') {
      if (v instanceof Uint8Array) return v;                       // 含 Buffer
      if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) return new Uint8Array(v);
    }
    if (typeof v.length === 'number') {
      try { return new Uint8Array(v); } catch (e) { return null; }  // 类数组兜底
    }
    return null;
  }
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }
  function slice(b, s, e) {
    return b.subarray ? b.subarray(s, e) : b.slice(s, e);
  }

  /* UTF-8 → 字符串。不用 TextDecoder：Node 与浏览器都要能用，且行为要一致。
     非法续字节直接丢弃（宁可少一个字符，不要抛）。 */
  function decodeUtf8(b, s, e) {
    var out = '', i = s === undefined ? 0 : s;
    var end = e === undefined ? b.length : e;
    if (end - i >= 3 && b[i] === 0xEF && b[i + 1] === 0xBB && b[i + 2] === 0xBF) i += 3;  // BOM
    while (i < end) {
      var c = b[i++];
      if (c < 0x80) { out += String.fromCharCode(c); continue; }
      if (c < 0xC0) continue;                                  // 游离续字节
      var n, cp;
      if (c < 0xE0) { n = 1; cp = c & 0x1F; }
      else if (c < 0xF0) { n = 2; cp = c & 0x0F; }
      else { n = 3; cp = c & 0x07; }
      for (var k = 0; k < n && i < end; k++) {
        var cc = b[i];
        if ((cc & 0xC0) !== 0x80) break;
        cp = (cp << 6) | (cc & 0x3F);
        i++;
      }
      if (cp > 0xFFFF) {
        cp -= 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      } else if (cp > 0) {
        out += String.fromCharCode(cp);
      } else {
        out += '\uFFFD';
      }
    }
    return out;
  }

  /* ======================================================== 1. XML 小工具 */

  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  /* 实体解码走"一趟扫描"，避免 &amp;lt; 被解两次解成 '<'。 */
  function unescapeXml(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, function (m, body) {
      if (body.charAt(0) === '#') {
        var hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
        var code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
        if (!isFinite(code) || code < 0 || code > 0x10FFFF) return m;
        if (code > 0xFFFF) {
          code -= 0x10000;
          return String.fromCharCode(0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF));
        }
        return String.fromCharCode(code);
      }
      return Object.prototype.hasOwnProperty.call(ENT, body) ? ENT[body] : m;
    });
  }

  /* 把一个开标签的属性收成对象：<c r="B2" t="s"> → { r:'B2', t:'s' }
     单双引号都认；属性名允许带命名空间前缀（r:id、mc:Ignorable）。 */
  var ATTR_RE = /([A-Za-z_][A-Za-z0-9_:.\-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  function attrsOf(tag) {
    var out = {}, m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(tag))) {
      out[m[1]] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : '');
    }
    return out;
  }

  /* 取直接子元素文本：childText(body, 'v')。返回 null = 没有这个子元素，
     返回 '' = 有但为空（自闭合或空标签）——两者必须区分。 */
  function childText(body, name) {
    var open = body.indexOf('<' + name);
    while (open >= 0) {
      var after = body.charAt(open + name.length + 1);
      if (after === '>' || after === '/' || after === ' ' || after === '\t' ||
          after === '\r' || after === '\n') {
        var gt = body.indexOf('>', open);
        if (gt < 0) return null;
        if (body.charAt(gt - 1) === '/') return '';             // <v/>
        var close = body.indexOf('</' + name, gt);
        if (close < 0) return null;
        var closeGt = body.indexOf('>', close);
        if (closeGt < 0) return null;
        return body.slice(gt + 1, close);
      }
      open = body.indexOf('<' + name, open + 1);
    }
    return null;
  }

  /* 共享串/内联串的正文：<si> / <is> 里所有 <t> 按顺序拼接（富文本 <r><t> 要拼），
     <rPh>（注音）整段丢掉 —— 它不是单元格内容。 */
  function textOfStrings(body) {
    var s = body
      .replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, '')
      .replace(/<rPh\b[^>]*\/>/g, '');
    var out = '', re = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g, m;
    while ((m = re.exec(s))) out += unescapeXml(m[1] === undefined ? '' : m[1]);
    return out;
  }

  /* ======================================================== 2. 地址换算 */

  function colIndex(letters) {
    var n = 0;
    for (var i = 0; i < letters.length; i++) {
      var c = letters.charCodeAt(i);
      if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
      else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
      else return -1;
    }
    return n - 1;
  }
  /* "B2" → { col:1, row:1 }（都从 0 起）；认 $ 绝对引用 */
  function cellRefIndex(ref) {
    var m = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/.exec(String(ref == null ? '' : ref).trim());
    if (!m) return null;
    var col = colIndex(m[1]);
    var row = parseInt(m[2], 10) - 1;
    if (col < 0 || !(row >= 0)) return null;
    return { col: col, row: row };
  }
  /* "A1:D5" / "A1" → 矩形范围 */
  function rangeRef(str) {
    var s = String(str == null ? '' : str).trim();
    var i = s.indexOf(':');
    if (i < 0) {
      var one = cellRefIndex(s);
      return one ? { r0: one.row, c0: one.col, r1: one.row, c1: one.col } : null;
    }
    var a = cellRefIndex(s.slice(0, i)), b = cellRefIndex(s.slice(i + 1));
    if (!a || !b) return null;
    return {
      r0: Math.min(a.row, b.row), c0: Math.min(a.col, b.col),
      r1: Math.max(a.row, b.row), c1: Math.max(a.col, b.col)
    };
  }

  /* ======================================================== 3. zip 容器 */

  var SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_EOCD = 0x06054b50;

  /* 从文件尾往回找 End of Central Directory（注释最长 65535，故只回扫这段） */
  function findEocd(b) {
    var n = b.length;
    if (n < 22) return -1;
    var low = n - 22 - 65535;
    if (low < 0) low = 0;
    for (var i = n - 22; i >= low; i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) return i;
    }
    return -1;
  }

  /* 中央目录 → { 条目名: {method, csize, offset, flags} }；坏包返回 null */
  function readCentralDirectory(b) {
    var e = findEocd(b);
    if (e < 0) return null;                                  // 不是 zip
    var count = u16(b, e + 10), cdSize = u32(b, e + 12), cdOff = u32(b, e + 16);
    if (count === 0xFFFF || cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) return null;  // ZIP64 不支持
    var files = {}, o = cdOff;
    for (var i = 0; i < count; i++) {
      if (o + 46 > b.length || u32(b, o) !== SIG_CENTRAL) return null;
      var flags = u16(b, o + 8), method = u16(b, o + 10), csize = u32(b, o + 20);
      var nlen = u16(b, o + 28), elen = u16(b, o + 30), clen = u16(b, o + 32);
      var lho = u32(b, o + 42);
      var name = decodeUtf8(b, o + 46, o + 46 + nlen);
      files[name] = { method: method, csize: csize, offset: lho, flags: flags };
      o += 46 + nlen + elen + clen;
    }
    return files;
  }

  /* 读一条目的**解压后字节**。用中央目录里的 csize（本地头在 data descriptor
     模式下尺寸为 0，不能信本地头）。 */
  function readEntry(b, ent, pako) {
    if (!ent) return null;
    if (ent.flags & 0x1) return null;                        // 加密
    if (ent.csize === 0xFFFFFFFF) return null;               // ZIP64 条目
    var o = ent.offset;
    if (o + 30 > b.length || u32(b, o) !== SIG_LOCAL) return null;
    var nlen = u16(b, o + 26), elen = u16(b, o + 28);
    var start = o + 30 + nlen + elen;
    var end = start + ent.csize;
    if (end > b.length) return null;
    var raw = slice(b, start, end);
    if (ent.method === 0) return raw;                        // 存储
    if (ent.method === 8) {                                  // deflate
      if (!pako || typeof pako.inflateRaw !== 'function') return null;
      var out = null;
      try { out = pako.inflateRaw(raw); } catch (e2) { return null; }
      return out && out.length !== undefined ? out : null;
    }
    return null;                                             // 其它压缩法不支持
  }

  function lookupEntry(files, name) {
    if (Object.prototype.hasOwnProperty.call(files, name)) return files[name];
    var lower = name.toLowerCase(), keys = Object.keys(files);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === lower) return files[keys[i]];
    }
    return null;
  }

  /* ======================================================== 4. 部件解析 */

  /* xl/workbook.xml → [{ name, rid }]，**顺序即拼接顺序**（不是文件名序，也不是
     rels 里的出现序：实测三个样本的 rels 是 rId6→rId1 逆序） */
  function parseWorkbookSheets(xml) {
    var box = /<sheets\b[^>]*>([\s\S]*?)<\/sheets>/.exec(xml);
    var scope = box ? box[1] : xml;
    var out = [], re = /<sheet\b[^>]*\/?>/g, m;
    while ((m = re.exec(scope))) {
      var a = attrsOf(m[0]);
      out.push({ name: a.name, rid: a['r:id'] || a.id || null, state: a.state });
    }
    return out;
  }

  function parseRels(xml) {
    var map = {}, re = /<Relationship\b[^>]*\/?>/g, m;
    while ((m = re.exec(xml))) {
      var a = attrsOf(m[0]);
      if (!a.Id) continue;
      if (String(a.TargetMode || '').toLowerCase() === 'external') continue;
      map[a.Id] = a.Target;
    }
    return map;
  }

  function normalizePath(p) {
    var parts = String(p).split('/'), out = [];
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i];
      if (s === '' || s === '.') continue;
      if (s === '..') { if (out.length) out.pop(); continue; }
      out.push(s);
    }
    return out.join('/');
  }
  /* target 相对 xl/ 解析；以 / 开头 = 包根绝对路径，去掉前导斜杠 */
  function resolveTarget(base, target) {
    if (typeof target !== 'string' || target === '') return null;
    var t = target.replace(/\\/g, '/');
    if (t.charAt(0) === '/') return normalizePath(t.slice(1));
    return normalizePath(base + t);
  }

  function parseSharedStrings(xml) {
    var out = [], re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g, m;
    while ((m = re.exec(xml))) out.push(textOfStrings(m[1] === undefined ? '' : m[1]));
    return out;
  }

  /* 单个单元格的**字符串值**；返回 undefined = "这个格子没有值"（SheetJS 同样会
     把它留成空洞，两边最终都变成 ''，但**是否占位**会影响行宽度，必须一致）。 */
  function cellValue(a, body, sst) {
    var t = a.t || '';
    var v = childText(body, 'v');
    var is = childText(body, 'is');
    if (t === 's') {                                          // 共享串
      if (v === null) return is === null ? undefined : textOfStrings(is);
      var idx = parseInt(String(v).trim(), 10);
      if (!(idx >= 0)) return undefined;
      var s = sst[idx];
      return s === undefined || s === null ? '' : String(s);   // 越界：降级空串（见已知局限 4）
    }
    if (t === 'inlineStr') {                                  // 内联串
      if (is !== null) return textOfStrings(is);
      return v === null ? undefined : unescapeXml(v);
    }
    if (t === 'b') {                                          // 布尔：SheetJS 出 TRUE/FALSE
      if (v === null) return undefined;
      return String(v).trim() === '1' ? 'TRUE' : 'FALSE';
    }
    if (t === 'str' || t === 'e' || t === 'd') {              // 公式串 / 错误 / ISO 日期
      return v === null ? (is === null ? undefined : textOfStrings(is)) : unescapeXml(v);
    }
    if (v === null) return is === null ? undefined : textOfStrings(is);
    return unescapeXml(String(v)).trim();                      // 数值：原样文本（已知局限 1）
  }

  /* 一张工作表 → string[][]（与 sheet_to_json({header:1}) 的口径对齐：
     范围由 <dimension> 决定；范围外的格子丢弃；行内缺格留空洞→''；行尾没格不补） */
  function rowsFromSheet(xml, sst) {
    var dimTag = /<dimension\b[^>]*>/.exec(xml);
    var dim = dimTag ? rangeRef(attrsOf(dimTag[0]).ref) : null;

    var cells = {}, minR = Infinity, minC = Infinity, maxR = -1, maxC = -1;
    var rowRe = /<row\b[^>]*>/g, m;
    var prevRow = -1;
    while ((m = rowRe.exec(xml))) {
      var rowTag = m[0], ra = attrsOf(rowTag);
      var rIdx = ra.r !== undefined ? parseInt(ra.r, 10) - 1 : prevRow + 1;
      if (!(rIdx >= 0)) rIdx = prevRow + 1;
      prevRow = rIdx;
      var bodyStart = m.index + rowTag.length, bodyEnd;
      if (/\/\s*>$/.test(rowTag)) {                           // 自闭合 <row/>
        bodyEnd = bodyStart;
      } else {
        var k = xml.indexOf('</row>', bodyStart);
        bodyEnd = k < 0 ? xml.length : k;
      }
      var body = bodyEnd > bodyStart ? xml.slice(bodyStart, bodyEnd) : '';
      rowRe.lastIndex = bodyEnd;                              // 跳过正文，别把里面的东西当行

      var cRe = /<c\b[^>]*>/g, cm, prevCol = -1;
      while ((cm = cRe.exec(body))) {
        var cTag = cm[0], ca = attrsOf(cTag);
        var ref = ca.r ? cellRefIndex(ca.r) : null;
        var cIdx = ref ? ref.col : prevCol + 1;               // 缺 r 属性 → 顺延
        prevCol = cIdx;
        var cStart = cm.index + cTag.length, cEnd;
        if (/\/\s*>$/.test(cTag)) {
          cEnd = cStart;
        } else {
          var kk = body.indexOf('</c>', cStart);
          cEnd = kk < 0 ? body.length : kk;
        }
        var cBody = cEnd > cStart ? body.slice(cStart, cEnd) : '';
        cRe.lastIndex = cEnd;
        var val = cellValue(ca, cBody, sst);
        if (val === undefined) continue;
        cells[rIdx + ',' + cIdx] = val;
        if (rIdx < minR) minR = rIdx;
        if (rIdx > maxR) maxR = rIdx;
        if (cIdx < minC) minC = cIdx;
        if (cIdx > maxC) maxC = cIdx;
      }
    }

    var range = dim || (maxR >= 0 ? { r0: minR, c0: minC, r1: maxR, c1: maxC } : null);
    var rows = [];
    if (!range) return rows;                                  // 空表 → []
    for (var r = range.r0; r <= range.r1; r++) {
      var arr = [], any = false;
      for (var c = range.c0; c <= range.c1; c++) {
        var key = r + ',' + c;
        if (Object.prototype.hasOwnProperty.call(cells, key)) {
          arr[c - range.c0] = cells[key];
          any = true;
        }
      }
      if (!any) continue;                                     // 整行无格 → 不产出（SheetJS 出 [] 后被过滤）
      var out = [];
      for (var i = 0; i < arr.length; i++) out.push(arr[i] === undefined ? '' : String(arr[i]));
      rows.push(out);
    }
    return rows;
  }

  /* ======================================================== 5. 入口 */

  var WB_PATH = 'xl/workbook.xml';
  var WB_RELS_PATH = 'xl/_rels/workbook.xml.rels';
  var SST_PATH = 'xl/sharedStrings.xml';
  var WB_BASE = 'xl/';

  function fromBytes(u8, pako) {
    try {
      var b = toBytes(u8);
      if (!b || b.length < 22) return null;
      var files = readCentralDirectory(b);
      if (!files) return null;

      var wbEnt = lookupEntry(files, WB_PATH);
      if (!wbEnt) return null;                                // 缺 xl/workbook.xml → 不是 xlsx
      var wbBytes = readEntry(b, wbEnt, pako);
      if (!wbBytes) return null;
      var sheets = parseWorkbookSheets(decodeUtf8(wbBytes));
      if (!sheets.length) return [];                          // 合法但一张表都没有

      var rels = {};
      var relEnt = lookupEntry(files, WB_RELS_PATH);
      if (relEnt) {
        var relBytes = readEntry(b, relEnt, pako);
        if (relBytes) rels = parseRels(decodeUtf8(relBytes));
      }

      var sst = [];
      var sstEnt = lookupEntry(files, SST_PATH);
      if (sstEnt) {
        var sstBytes = readEntry(b, sstEnt, pako);
        if (sstBytes) sst = parseSharedStrings(decodeUtf8(sstBytes));
      }

      var rows = [], resolved = 0;
      for (var i = 0; i < sheets.length; i++) {
        var target = sheets[i].rid ? resolveTarget(WB_BASE, rels[sheets[i].rid]) : null;
        if (!target) continue;
        var ent = lookupEntry(files, target);
        if (!ent) continue;
        var bytes = readEntry(b, ent, pako);
        if (!bytes) continue;
        resolved++;
        var sheetRows = rowsFromSheet(decodeUtf8(bytes), sst);
        for (var j = 0; j < sheetRows.length; j++) rows.push(sheetRows[j]);
      }
      if (!resolved) return null;                             // 有 workbook 却一张表都读不出 → 解析不了
      return rows;
    } catch (e) {
      return null;                                            // 契约：永不抛
    }
  }

  return { fromBytes: fromBytes };
});
