#!/usr/bin/env node
/* ============================================================================
 * pack-portable —— 把一个"已由 PsychoPy 导出过 HTML"的实验打成**单个 html 便携包**
 * ----------------------------------------------------------------------------
 * 与 M0-P1 的 spike 打包器的区别：这是产品路径的第一版，特点是
 *   ① 面向 psychojs 2026（iife 运行时 / _downloadResources / 资源 status）
 *   ② 资源类型按扩展名分派（图片→HTMLImageElement；条件文件→ArrayBuffer）
 *   ③ 每条补丁必须命中，命中不了就拒绝出包（宁可失败，也不产出坏包）
 *
 * 用法:
 *   node src/pack-portable.js --dir <实验目录> --js <生成的legacy js> --out <输出.html> [--autotest]
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { fixJsCode } = require('./js-codeblock-fix.js');

const ROOT = path.resolve(__dirname, '..');
// 第三方库位置：仓库根 vendor/（由 scripts/fetch-vendor.ps1 按 vendor.lock.json 拉取并校验）。
// 历史坑：这里曾写 spike/m0/vendor —— 目录在"vendor 收敛"时搬到了仓库根，代码没跟着改，
// 于是本地工具一切到"内联素材"就报"缺少第三方库 jquery-3.6.0.min.js"。
// 这条路径有守卫：node src/verify-vendor-refs.js 会扫全仓库，任何指向不存在目录的
// vendor 引用都会让它 exit 1。
const VENDOR = path.join(ROOT, 'vendor');

// 1×1 透明 PNG：用于把"指向远端 URL 的资源"替换掉，保证便携包零网络请求
const PLACEHOLDER_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes('--' + name);

const DIR = arg('dir');
const JS_FILE = arg('js');
const OUT = arg('out', path.join(ROOT, 'spike', 'm0', 'build', 'portable.html'));
if (!DIR || !JS_FILE) {
  console.error('用法: node src/pack-portable.js --dir <实验目录> --js <legacy.js> --out <out.html>');
  process.exit(2);
}
const AUTOTEST = has('autotest');
const TITLE = arg('title', '在线实验');
const EXP_NAME = arg('expname', path.basename(DIR));

const applied = [];
const problems = [];
function must(cond, msg) { if (!cond) { console.error('\n[打包失败] ' + msg + '\n'); process.exit(1); } }
function patch(id, pattern, replacement, { required = true } = {}) {
  const m = js.match(pattern);
  if (!m) {
    if (required) must(false, '补丁未命中: ' + id + ' —— 生成代码结构可能已变化，必须人工确认');
    problems.push(id);
    return false;
  }
  const replacer = (typeof replacement === 'function')
    ? (match, ...rest) => replacement([match, ...rest]) : replacement;
  js = js.replace(pattern, replacer);
  applied.push(id);
  return true;
}

// ---------------------------------------------------------------- 读入生成代码
let js = fs.readFileSync(JS_FILE, 'utf8');
const originalLen = js.length;

// ---------------------------------------------------------------- 1. 代码块修复
const fixed = fixJsCode(js);
js = fixed.code;
const fixSummary = fixed.changes.length ? fixed.changes.map((c) => `#${c.line} ${c.kind}`).join('; ') : '无';

// ---------------------------------------------------------------- 2. 收集资源并内联
const resEntries = [...js.matchAll(/\{\s*'name':\s*'([^']+)',\s*'path':\s*'([^']+)'\s*\}/g)]
  .map((m) => ({ name: m[1], p: m[2] }));
// 允许**零资源**：纯文字 + 按键一类实验（很常见）根本没有图片/音频/条件文件。
// 早期版本 here 写成 must(resEntries.length > 0) 会把这类实验直接判失败
// （被探针用空实验抓到）。真正要校验的是"resources 数组存在"。
must(/resources:\s*\[/.test(js), '在生成代码里找不到 resources 列表');
if (!resEntries.length) console.log('   （该实验没有外部资源：跳过资源内联）');

// 2a. 资源清单补全（实测必需的补丁）
//     官方 CLI 编译器（psyexpCompile）只写 Settings 里**显式声明**的资源；
//     Builder 的 Export HTML 会额外做一次"自动探测"。CLI 编译时工作目录是空的
//     临时目录，探测更是什么都找不到 —— 实测某个真实导出物编译出来的 resources
//     只剩一条远端 URL 占位图。所以缺的资源全靠这里补。
//
//     ⚠️ 历史缺陷（本次修）：旧实现把发现的媒体名当成"与 psyexp 同目录"来找：
//         const dir = path.dirname(path.resolve(PSYEXP));
//         found.add(v) 仅当 fs.existsSync(path.join(dir, v))
//     只要实验把 psyexp 与刺激图分放两个目录（例如 程序/ 与 ../材料/），命中率就是 0 ——
//     即使把几百 MB 全上传，包里也不会有任何刺激图，而且是静默的。
//     现在改用 src/ref-closure.js：从 psyexp 解析代码里的路径表达式
//     （STIM_DIR = os.path.join(_thisDir, os.pardir, '材料') 折叠成 ../材料），
//     引用路径**相对 psyexp 目录**解析，跨目录天然成立。
const PSYEXP = arg('psyexp');
let injected = [];
let refReport = [];
if (PSYEXP && fs.existsSync(PSYEXP)) {
  const RC = require('./ref-closure.js');
  const psyexpText = fs.readFileSync(PSYEXP, 'utf8');

  // 条件表读取（相对 psyexp 目录）：csv/tsv 直接读文本；xlsx/xls 用 SheetJS
  const getTableRows = (rel) => {
    const full = path.join(DIR, rel);
    if (!fs.existsSync(full)) return null;
    const ext = path.extname(full).toLowerCase();
    if (ext === '.csv' || ext === '.tsv') {
      return fs.readFileSync(full, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '')
        .map((l) => l.split(ext === '.tsv' ? '\t' : ','));
    }
    if (ext === '.xlsx' || ext === '.xls') {
      const XLSX = require(path.join(VENDOR, 'xlsx.full.min.js'));
      const wb = XLSX.readFile(full);
      const rows = [];
      wb.SheetNames.forEach((sn) => {
        XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false }).forEach((row) => {
          if (row && row.length) rows.push(row.map((v) => (v == null ? '' : String(v))));
        });
      });
      return rows;
    }
    return null;
  };

  // exists 只认**精确路径**（相对 psyexp 目录）。
  // 不用"同目录兜底"：那会把 os.path.join(PRAC_DIR, image) 与
  // os.path.join(STIM_DIR, image) 两组候选混在一起，凭空多出一倍假引用。
  const res = RC.resolve({
    psyexpRel: path.basename(PSYEXP),
    psyexpText: psyexpText,
    getTableRows: getTableRows,
    exists: (rel) => fs.existsSync(path.join(DIR, rel))
  });

  res.notes.forEach((n) => console.log('   （引用解析）' + n));

  const found = new Set();
  const notFound = [];
  res.refs.forEach((r) => {
    const full = path.join(DIR, r.path);
    if (fs.existsSync(full)) found.add(r.path);
    else notFound.push(r.path);
  });
  // "内容里读到、但磁盘上找不到" 必须**说出来** —— 静默丢弃正是旧实现的病根
  if (notFound.length) {
    console.log('   ⚠️ 有 ' + notFound.length + ' 个引用在磁盘上找不到（不会进包）：'
      + notFound.slice(0, 6).join('、') + (notFound.length > 6 ? ' …' : ''));
    problems.push('unresolved-refs:' + notFound.length);
  }
  if (res.unresolved && res.unresolved.length) {
    console.log('   ⚠️ 有 ' + res.unresolved.length + ' 处动态引用无法静态解析（可能在运行时才确定文件名）：');
    res.unresolved.slice(0, 4).forEach((u) => console.log('      - ' + u));
  }
  refReport = res.refs.map((r) => r.path + '  [' + r.role + ' ← ' + r.source + ']');

  injected = [...found].filter((n) => !resEntries.some((e) => e.p === n || e.name === n));
  if (injected.length) {
    patch('inject-resources', /resources:\s*\[/,
      (m) => m[0] + '\n    ' + injected.map((n) => `{'name': '${n}', 'path': '${n}'},`).join('\n    '));
    injected.forEach((n) => resEntries.push({ name: n, p: n }));
  }
}

const inlineMap = {};
const resReport = [];
for (const { name, p } of resEntries) {
  const ext = path.extname(name).toLowerCase();
  const isRemote = /^https?:\/\//i.test(p);
  const local = path.join(DIR, p);

  if (isRemote && !fs.existsSync(local)) {
    inlineMap[name] = { type: 'image', data: PLACEHOLDER_PNG, fallback: null };
    resReport.push(`${name.padEnd(20)} 远端→占位 1×1 PNG（原: ${p.slice(0, 40)}…）`);
    continue;
  }
  if (!fs.existsSync(local)) {
    inlineMap[name] = { type: ext === '.png' || ext === '.jpg' ? 'image' : 'text', data: PLACEHOLDER_PNG, fallback: null };
    resReport.push(`${name.padEnd(20)} ⚠️ 本地缺失 → 占位（原: ${p}）`);
    problems.push('missing-resource:' + name);
    continue;
  }
  const buf = fs.readFileSync(local);
  const b64 = buf.toString('base64');
  const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : ext === '.csv' ? 'text/csv' : 'application/octet-stream';
  // 图片 → HTMLImageElement；条件文件/其他二进制 → ArrayBuffer（psychojs 会 new Uint8Array）
  const type = (ext === '.png' || ext === '.jpg' || ext === '.jpeg') ? 'image' : 'binary';
  inlineMap[name] = { type, data: `data:${mime};base64,${b64}`, fallback: type === 'binary' ? null : PLACEHOLDER_PNG };
  resReport.push(`${name.padEnd(20)} ${type === 'image' ? '图片' : '二进制'} ${(buf.length / 1024).toFixed(1)} KB`);
}

// ---------------------------------------------------------------- 3. 定点补丁
// 3a. 装上内联资源 + 开始页（都在 new PsychoJS 之后、start 之前）
patch('install-inline-resources',
  /(const psychoJS = new PsychoJS\([^)]*\);)/,
  '$1\npsywebInstallInlineResources(psychoJS, PSYWEB_INLINE_RESOURCES);' +
  '\npsywebInstallStartGate(psychoJS, { title: window.PSYWEB_META.title, expName: window.PSYWEB_META.expName });' +
  (AUTOTEST ? '\npsywebAutoDrive(psychoJS);' : ''));

// 3b. 流程门禁：**始终**用"资源就绪 + 被试已点开始"两道门替换被试信息对话框。
//     官方靠对话框阻塞来等资源下载；而 addConditional 是一次性判定，
//     所以必须自己实现每帧 FLIP_REPEAT 的等待任务（M0-P1 实测教训）。
//     被试信息对话框在便携包里由 psyweb 自己的开始页（含知情同意）取代。
patch('start-gate',
  /psychoJS\.schedule\(psychoJS\.gui\.DlgFromDict\(\{[\s\S]*?\}\)\);\s*\n\s*const flowScheduler = new Scheduler\(psychoJS\);\s*\n\s*const dialogCancelScheduler = new Scheduler\(psychoJS\);\s*\n\s*psychoJS\.scheduleCondition\(function\(\)\s*\{\s*return \(psychoJS\.gui\.dialogComponent\.button === 'OK'\);\s*\},?\s*flowScheduler, dialogCancelScheduler\);/,
  `const flowScheduler = new Scheduler(psychoJS);
const dialogCancelScheduler = new Scheduler(psychoJS);
psychoJS.schedule(function psywebGate() {
  var ready = (window.PSYWEB_RESOURCES_READY === true) && (window.PSYWEB_STARTED === true);
  if (ready) { psychoJS.schedule(flowScheduler); return Scheduler.Event.NEXT; }
  return Scheduler.Event.FLIP_REPEAT;
});`);

// 3c. 数据出口：所有退出路径都经过 quitPsychoJS
patch('dump-on-quit',
  /(async\s+)?function quitPsychoJS\(message, isCompleted\)\s*\{/,
  (m) => m[0] + "\n  psywebDump(psychoJS, isCompleted ? 'completed' : 'aborted');");

// 3d. 自测超时兜底：避免无头环境下无限等待
if (AUTOTEST) {
  patch('autotest-timeout',
    /psychoJS\.start\(\{[\s\S]*?\n\}\);/,
    (m) => m[0] + "\nsetTimeout(function () { if (!window.__PSYWEB__) { console.log('[psyweb] autotest 超时兜底导出'); psywebDump(psychoJS, 'timeout-60s'); } }, 60000);");
}

// ---------------------------------------------------------------- 4. 补丁后自检
const MUST = [
  ['资源改道注入', /psywebInstallInlineResources\(psychoJS, PSYWEB_INLINE_RESOURCES\);/],
  ['开始页注入', /psywebInstallStartGate\(psychoJS/],
  ['数据导出注入', /psywebDump\(psychoJS, isCompleted \? 'completed' : 'aborted'\);/],
  ['流程门禁注入', /function psywebGate\(\)/],
  ['实验起始调用', /psychoJS\.start\(\{/]
];
if (AUTOTEST) MUST.push(['自动驱动注入', /psywebAutoDrive\(psychoJS\);/]);
const missing = MUST.filter(([, re]) => !re.test(js));
must(!missing.length, '补丁后自检失败，缺失: ' + missing.map((m) => m[0]).join('、'));

// ---------------------------------------------------------------- 4b. 语法门禁
// 为什么必须有（实测踩到，而且很典型）：
//   打包全程只做**文本补丁**，从来不编译"生成出来的实验 JS"。于是"连语法都过不了"
//     的包照样能出：只要 psyexp 的**组件参数**里写了 Python 专有表达式，生成物里就会有非法 JS
//   例如 <Param val="$'A' if cond else 'B'" valType="str" name="text"/>
//   官方编译器不会把它翻成 JS，生成物里就躺着 `'A' if cond else 'B'` → 浏览器 SyntaxError、白屏，
//   而工具这边一路"✅ 完成"。
//   宁可拒绝出包，也不产出坏包（本项目红线：不把有问题的产物说成好了）。
{
  const vm = require('vm');
  let syntaxErr = null;
  try { new vm.Script(js, { filename: 'experiment-legacy-browsers.js' }); }
  catch (e) { syntaxErr = e; }
  if (syntaxErr) {
    const lines = js.split('\n');
    const stackMatch = /:(\d+)\b/.exec(String(syntaxErr.stack || ''));
    const ln = syntaxErr.lineNumber || (stackMatch ? Number(stackMatch[1]) : 0);
    console.error('\n[打包失败] 生成的实验 JS 有语法错误，拒绝出包：' + syntaxErr.message);
    if (ln) {
      for (let i = Math.max(0, ln - 4); i < Math.min(lines.length, ln + 3); i++) {
        console.error('  ' + (i + 1 === ln ? '>> ' : '   ') + String(i + 1).padStart(5) + ': ' + lines[i].slice(0, 220));
      }
    }
    console.error('\n  常见原因：Builder 的**组件参数**里写了 Python 专有表达式。');
    console.error('  官方编译器只翻译 CodeComponent 的 Py 槽位，组件参数里的表达式是**原样照抄**的。');
    console.error('  典型写法与改法：');
    console.error("    ×  $'A' if cond else 'B'          →  √  $cond ? 'A' : 'B'   （JS 三元）");
    console.error('    ×  $os.path.join(DIR, name)      →  √  $DIR + name        （或预先把 DIR 定成 JS 字符串）');
    console.error('  改完在 PsychoPy Builder 里重新 Export HTML，或直接改 .psyexp 后重跑本工具。');
    process.exit(1);
  }
  console.log('   JS 语法门禁：通过（' + js.length + ' 字符，vm.Script 强编译）');
}

// ---------------------------------------------------------------- 5. 组装单文件
function readVendor(f) {
  const p = path.join(VENDOR, f);
  must(fs.existsSync(p), `缺少第三方库 ${f}（先运行 scripts/fetch-vendor.ps1）`);
  return fs.readFileSync(p, 'utf8');
}
function readNodeModule(rel) {
  const p = path.join(ROOT, 'node_modules', rel);
  must(fs.existsSync(p), `缺少 npm 依赖 ${rel}（先运行 npm install）`);
  return fs.readFileSync(p, 'utf8');
}
const S = {
  jquery: readVendor('jquery-3.6.0.min.js'),
  jqueryUi: readVendor('jquery-ui-1.12.1.min.js'),
  jqueryUiCss: readVendor('jquery-ui-1.12.1.min.css'),
  preload: readVendor('preloadjs-1.0.1.min.js'),
  psychoJs: readVendor('psychojs-2026.2.3.iife.js'),
  css: readVendor('psychojs-2026.2.3.css'),
  pako: readVendor('pako.min.js'),                    // gzip：二维码载荷压缩（M0-P2 实测压缩率 22%）
  qrcode: readNodeModule('qrcode-generator/dist/qrcode.js'),  // 编码：MIT，纯 JS 单文件
  shim: fs.readFileSync(path.join(__dirname, 'psyweb-shim-2026.js'), 'utf8')
};
// 内联资源要转义成安全的 JS 字面量
const inlineJson = JSON.stringify(inlineMap).replace(/<\//g, '<\\/');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>${path.basename(DIR)} · psyweb 便携实验包</title>
<style>
html,body{margin:0;padding:0;background:#000}
${S.jqueryUiCss}
${S.css}
#psyweb-meta{position:fixed;left:0;bottom:0;font:11px system-ui;color:#888;opacity:.5;padding:2px 6px;z-index:99999;pointer-events:none}
</style>
</head>
<body>
<div id="root"></div>
<div id="psyweb-meta">psyweb 便携包 · 单文件 · 离线可运行</div>

<script>window.PSYWEB_INLINE_RESOURCES = ${inlineJson};</script>
<script>window.PSYWEB_META = ${JSON.stringify({ title: TITLE, expName: EXP_NAME, builtAt: new Date().toISOString() })};</script>
<script>${S.jquery}</script>
<script>${S.jqueryUi}</script>
<script>${S.preload}</script>
<script>${S.pako}</script>
<script>${S.qrcode}</script>
<script>${S.psychoJs}</script>
<script>${S.shim}</script>
<script>
/* 以下为 PsychoPy Builder 生成的实验脚本，psyweb 仅做 ${applied.length} 处定点补丁 + ${fixed.changes.length} 处代码块修复：
   补丁: ${applied.join('、')}
   修复: ${fixSummary}
*/
${js}
</script>
</body>
</html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');

// ---------------------------------------------------------------- 6. 报告
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log('✅ 便携包已生成');
console.log('  输出: ' + OUT);
console.log('  大小: ' + (fs.statSync(OUT).size / 1024 / 1024).toFixed(2) + ' MB');
console.log('  内联: psychojs-2026.2.3.iife(' + kb(S.psychoJs.length) + ') + jquery + jquery-ui + preloadjs + 样式');
console.log('  实验脚本: ' + kb(originalLen) + ' → 修复 ' + fixed.changes.length + ' 处 → 补丁 ' + applied.length + ' 处');
console.log('\n  资源内联:');
resReport.forEach((r) => console.log('    ' + r));
if (fixed.todos.length) {
  console.log('\n  ⚠️ 需人工确认:');
  fixed.todos.forEach((t) => console.log('    - ' + t));
}
if (problems.length) {
  console.log('\n  ⚠️ 打包告警: ' + problems.join(', '));
}
console.log('\n  自测参数: 打开时加 ?autotest=1 可自动驱动按键并导出数据');
