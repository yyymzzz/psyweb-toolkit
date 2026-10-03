// 单文件工具的构建期硬门禁（静态 + 求值两条独立路径）
// ---------------------------------------------------------------------------
// 背景（实测踩过）：site/pack-core.js 里含有字面量 `</script>`（它要拼出输出 HTML
// 的模板串）。如果把它**原样**内联进 <script>，HTML 分词器会在第一个 `</script>`
// 处提前闭合标签 —— pack-core 被截断，尾部碎片变成第 2 个脚本块，浏览器报
// 2 个 "SyntaxError: Invalid or unexpected token"。
//
// 本脚本做 4 件事，任一失败 exit 1：
//   ① 按 HTML 规则切分 <script> 块，用 vm.Script **强制解析**每个块（懒解析会漏报）
//   ② 检查脚本体内是否残留 `<!--`（会把分词器带入 escaped 状态，进而使
//      `</script>` 失效）或裸 `</script`
//   ③ 求值 window.PSYWEB_ASSETS 块（纯赋值，无需 DOM），逐个素材与 site/assets
//      下的源文件做**逐字符比对** —— 证明转义是取值等价的
//   ④ 必需标记存在性
//
// 用法: node src/verify-single-tool.js dist/psyweb打包工具.html [--site site]
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const argv = process.argv.slice(2);
const htmlPath = argv.find((a) => !a.startsWith('--'));
if (!htmlPath) { console.error('用法: node verify-single-tool.js <html> [--site <dir>]'); process.exit(2); }
const siteIdx = argv.indexOf('--site');
const siteDir = path.resolve(siteIdx >= 0 ? argv[siteIdx + 1] : path.join(path.dirname(htmlPath), '..', 'site'));

const html = fs.readFileSync(htmlPath, 'utf8');
const errors = [];
const notes = [];

console.log('=== 单文件工具门禁 ===');
console.log('产物:', htmlPath);
console.log('大小:', fs.statSync(htmlPath).size, '字节 /', html.length, '字符');
console.log('素材目录:', siteDir);

// ---- ① 切块 + 强制解析 ----
const RX = /<script([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const blocks = [];
let m;
while ((m = RX.exec(html)) !== null) {
  blocks.push({ attrs: m[1].trim(), code: m[2], at: m.index, htmlLine: html.slice(0, m.index).split('\n').length });
}
console.log(`\n[①] <script> 块 ${blocks.length} 个，逐个强制解析`);
let assetBlock = -1;
blocks.forEach((b, i) => {
  let ok = true, msg = '';
  try {
    new vm.Script(b.code, { filename: `block${i}.js` });
  } catch (e) { ok = false; msg = e.message; }
  const head = b.code.trim().slice(0, 48).replace(/\n/g, '\\n');
  console.log(`  块${String(i).padStart(2)} html行${String(b.htmlLine).padStart(4)} ${String(b.code.length).padStart(8)}字符 ${ok ? 'OK  ' : 'FAIL'}  ${head}`);
  if (!ok) {
    errors.push(`块${i}（html行${b.htmlLine}）解析失败: ${msg}`);
    const mm = msg.match(/block\d+:(\d+)/);
    if (mm) {
      const lines = b.code.split('\n');
      const idx = Number(mm[1]) - 1;
      for (let k = Math.max(0, idx - 2); k <= Math.min(lines.length - 1, idx + 2); k++) {
        console.log(`      ${k === idx ? '>>' : '  '} ${k + 1}: ${lines[k].slice(0, 160)}`);
      }
    }
  }
  if (/window\.PSYWEB_ASSETS\s*=/.test(b.code)) assetBlock = i;
});

// ---- ② 危险序列 ----
console.log('\n[②] 脚本体内危险序列');
blocks.forEach((b, i) => {
  if (b.code.includes('<!--')) errors.push(`块${i} 体内残留 "<!--"（会把分词器带入 escaped 状态）`);
  if (b.code.includes('</script')) errors.push(`块${i} 体内残留裸 "</script"`);
});
const bad = errors.filter((e) => e.includes('残留'));
console.log(bad.length ? bad.map((e) => '  ❌ ' + e).join('\n') : '  ✅ 所有脚本体内无 "<!--"、无裸 "</script"');

// ---- ③ 素材取值等价（唯一权威判据） ----
const MAP = {
  psychoJs: 'assets/psychojs-2026.2.3.iife.js',
  css: 'assets/psychojs-2026.2.3.css',
  jquery: 'assets/jquery-3.6.0.min.js',
  jqueryUi: 'assets/jquery-ui-1.12.1.min.js',
  jqueryUiCss: 'assets/jquery-ui-1.12.1.min.css',
  preload: 'assets/preloadjs-1.0.1.min.js',
  pako: 'assets/pako.min.js',
  qrcode: 'assets/qrcode.js',
  shim: 'assets/psyweb-shim-2026.js',
};
console.log('\n[③] 内联素材 vs site/assets 源文件（逐字符）');
if (assetBlock < 0) {
  errors.push('找不到 window.PSYWEB_ASSETS 赋值块');
  console.log('  ❌ 找不到 window.PSYWEB_ASSETS 赋值块');
} else {
  const sandbox = { window: {} };
  try {
    vm.createContext(sandbox);
    new vm.Script(blocks[assetBlock].code, { filename: 'assets.js' }).runInContext(sandbox);
  } catch (e) {
    errors.push('求值 PSYWEB_ASSETS 块失败: ' + e.message);
  }
  const got = sandbox.window.PSYWEB_ASSETS || {};
  for (const k of Object.keys(MAP)) {
    const src = path.join(siteDir, MAP[k]);
    if (!fs.existsSync(src)) { errors.push(`缺少源文件 ${MAP[k]}`); console.log(`  ❌ ${k.padEnd(12)} 源文件不存在: ${src}`); continue; }
    const want = fs.readFileSync(src, 'utf8');
    const have = typeof got[k] === 'string' ? got[k] : '';
    if (have === want) {
      console.log(`  ✅ ${k.padEnd(12)} ${have.length} 字符，与 ${MAP[k]} 完全一致`);
    } else {
      const n = Math.min(have.length, want.length);
      let d = -1;
      for (let i = 0; i < n; i++) if (have[i] !== want[i]) { d = i; break; }
      if (d < 0) d = n;
      errors.push(`素材 ${k} 与源文件不一致（长度 ${have.length} vs ${want.length}，首个差异 @${d}）`);
      console.log(`  ❌ ${k.padEnd(12)} ${have.length} vs ${want.length}，首个差异 @${d}`);
      console.log(`      have: ${JSON.stringify(have.slice(Math.max(0, d - 30), d + 30))}`);
      console.log(`      want: ${JSON.stringify(want.slice(Math.max(0, d - 30), d + 30))}`);
    }
  }
  // css 两项：build 里也内联了，一并校验（页面用它设置样式）
  for (const k of ['css', 'jqueryUiCss']) {
    const want = fs.readFileSync(path.join(siteDir, MAP[k]), 'utf8');
    const have = got[k];
    if (have !== want) errors.push(`素材 ${k} 与源文件不一致`);
  }
}

// ---- ③b 内联的 JS 块 vs 源文件（逐字符） ----
// 补一个洞：早先只对 PSYWEB_ASSETS 里的素材做了逐字符比对，pack-core.js 只被
// "强制解析"过。**语法过了不等于内容没被改歪** —— 本项目正是被"能编译但语义已坏"
// 坑过两次（模板字符串吃掉反斜杠，\s→s 之后仍然合法）。
// 这里对三个内联 JS 块做与构建脚本**互逆**的变换后逐字符比对；同时校验
// site/ 下的拷贝与 src/ 下的源文件一致（防止两份实现漂移）。
// ⚠️ marker 不能只用模块名（PsywebPack 这种）：页面主脚本里也会出现
//    `PsywebPack.pack(...)`、`window.PsywebRefClosure` 等字样，于是"含标记的块"会有 2 个。
//    必须用 UMD 包装里**只有模块自己才有**的签名 `root.XxxYyy = factory()`。
const JSBLOCKS = [
  { key: 'pack-core.js', srcs: ['site/pack-core.js'], marker: 'root.PsywebPack = factory()' },
  { key: 'ref-closure.js', srcs: ['site/assets/ref-closure.js', 'src/ref-closure.js'], marker: 'root.PsywebRefClosure = factory()' },
  { key: 'xlsx-rows-pako.js', srcs: ['site/assets/xlsx-rows-pako.js', 'src/xlsx-rows-pako.js'], marker: 'root.PsywebXlsxRows = factory()' },
];
// 与 build-single-tool.ps1 的 Protect-Inline 完全互逆：
//   </      -> <\/         (JS 里 \/ 就是 /)
//   <!--    -> \x3C!--     (JS 里 \x3C 就是 <)
function protectInline(s) {
  return String(s).split('</').join('<\\/').split('<!--').join('\\x3C!--');
}
console.log('\n[③b] 内联 JS 块 vs 源文件（逐字符，构建脚本的逆变换）');
for (const jb of JSBLOCKS) {
  // 先用签名定位（唯一），再用源文件做**互逆变换后逐字符相等**判定
  const found = blocks.filter((b) => b.code.includes(jb.marker));
  if (found.length !== 1) {
    errors.push(`内联块 ${jb.key} 定位失败（含签名 ${jb.marker} 的块有 ${found.length} 个）`);
    console.log(`  ❌ ${jb.key.padEnd(20)} 定位失败（含签名 ${jb.marker} 的块 ${found.length} 个）`);
    continue;
  }
  const have = found[0].code;
  const texts = [];
  let srcOk = true;
  for (const rel of jb.srcs) {
    const p = path.join(siteDir, '..', rel);
    if (!fs.existsSync(p)) {
      // site/ 与 src/ 相对路径不同，分别兜一下
      const p2 = rel.startsWith('site/') ? path.join(siteDir, rel.slice(5)) : p;
      if (!fs.existsSync(p2)) { console.log(`  ⚠️ ${jb.key}: 源文件不存在 ${rel}`); srcOk = false; continue; }
      texts.push({ rel, text: fs.readFileSync(p2, 'utf8') });
      continue;
    }
    texts.push({ rel, text: fs.readFileSync(p, 'utf8') });
  }
  // src/ 与 site/ 两份必须一致（漂移检查）
  if (texts.length === 2 && texts[0].text !== texts[1].text) {
    errors.push(`${jb.key}: ${texts[0].rel} 与 ${texts[1].rel} 不一致（两份实现已漂移）`);
    console.log(`  ❌ ${jb.key.padEnd(20)} 两份源文件不一致：${texts[0].rel} vs ${texts[1].rel}`);
    continue;
  }
  if (!texts.length) { errors.push(`${jb.key}: 找不到任何源文件`); continue; }
  const want = protectInline(texts[0].text);
  if (have === want) {
    console.log(`  ✅ ${jb.key.padEnd(20)} ${have.length} 字符，与 ${texts.map((t) => t.rel).join(' / ')} 逐字符等价`);
  } else {
    let d = -1;
    const n = Math.min(have.length, want.length);
    for (let i = 0; i < n; i++) if (have[i] !== want[i]) { d = i; break; }
    if (d < 0) d = n;
    errors.push(`${jb.key} 内联内容与源文件不等价（长度 ${have.length} vs ${want.length}，首个差异 @${d}）`);
    console.log(`  ❌ ${jb.key.padEnd(20)} ${have.length} vs ${want.length}，首个差异 @${d}`);
    console.log(`      have: ${JSON.stringify(have.slice(Math.max(0, d - 40), d + 40))}`);
    console.log(`      want: ${JSON.stringify(want.slice(Math.max(0, d - 40), d + 40))}`);
  }
  if (!srcOk) console.log(`  ⚠️ ${jb.key}: 有源文件缺失，等价性只覆盖了找到的那些`);
}

// ---- ④ 必需标记 ----
console.log('\n[④] 必需标记');
const MUST = {
  'window.PSYWEB_ASSETS': '内联素材注入点',
  'PsywebPack': '浏览器版打包器（pack-core）',
  'PsywebRefClosure': '引用闭包解析器（与本地工具同一份）',
  'PsywebXlsxRows': '浏览器版 xlsx 读取器（pako）',
  'psyweb': '页面标题/品牌',
};
for (const k of Object.keys(MUST)) {
  const ok = html.includes(k);
  console.log(`  ${ok ? '✅' : '❌'} ${k.padEnd(24)} ${MUST[k]}`);
  if (!ok) errors.push(`缺少必需标记 ${k}（${MUST[k]}）`);
}
for (const m of ['src="./pack-core.js"', 'src="./assets/ref-closure.js"', 'src="./assets/xlsx-rows-pako.js"']) {
  if (html.includes(m)) errors.push(`外链 script 仍存在（内联未生效）：${m}`);
}
notes.push(`产物体积 ${(fs.statSync(htmlPath).size / 1048576).toFixed(2)} MB`);

// ---- 结论 ----
console.log('\n=== 结论 ===');
if (errors.length) {
  console.log(`❌ 门禁未通过，${errors.length} 项：`);
  errors.forEach((e) => console.log('   - ' + e));
  process.exit(1);
}
notes.forEach((n) => console.log('   ' + n));
console.log('✅ 门禁全部通过（解析 / 危险序列 / 素材取值等价 / 必需标记）');
