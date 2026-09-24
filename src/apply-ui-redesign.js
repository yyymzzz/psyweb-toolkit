// 把 Codex 的设计稿落地成生产页面
// ---------------------------------------------------------------------------
// 设计稿是**展示样稿**：它把"拖拽三态/按钮两态/出错日志/WebGL失败"都做成静态样例，
// 还预填了 12 行假日志。评审时这是优点，直接上线就是骗人 —— 用户还没选文件，
// 页面就写着"共 190 个文件 → 将读取 12 个"。
//
// 本脚本做四件事：
//   ① 保留设计稿的交互机关：分栏拖拽(#splitter) + 预览等比缩放(fitPreview/fitParticipantPage)
//   ② 清掉静态样稿：.drop-state-samples / .interaction-samples / .error-sample / #log 假日志
//   ③ 接上真实逻辑：site/index.html 的 pack-core 调用（原样迁移，只改两处对接点）
//   ④ 自检：假数据串必须消失、真逻辑标记必须存在、原 id 白名单必须完整
//
// 用法: node src/apply-ui-redesign.js [--draft <设计稿.html>] [--dry]
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRAFT = path.resolve(opt('draft', 'C:/Users/admin/Documents/Codex/2026-09-24/text-ui-psyweb-psychopy-3-4/psyweb-redesign.html'));
const SITE = path.join(ROOT, 'site', 'index.html');
const DRY = argv.includes('--dry');

const fails = [];
const log = (s) => console.log(s);

// ============ 1. 从现有站点页取出真实 UI 逻辑 ============
const siteHtml = fs.readFileSync(SITE, 'utf8');
const jsStart = siteHtml.indexOf("(function () {\n  'use strict';\n  var ASSETS = {");
if (jsStart < 0) throw new Error('在 site/index.html 里找不到真实 UI 逻辑（ASSETS 定义）');
const jsEnd = siteHtml.lastIndexOf('})();');
if (jsEnd < 0) throw new Error('找不到 UI 逻辑的结尾 })();');
let uiJs = siteHtml.slice(jsStart, jsEnd + '})();'.length);
log(`[1] 取出现有 UI 逻辑 ${uiJs.length} 字符`);

// 对接点必须是**幂等**的：脚本要能反复重跑（改一次设计就重跑一次），
// 而它的输入 site/index.html 本身就是上一次的输出。
// appliedMarker：只有"已适配"之后才会出现的字符串。默认取 newText；
// 若 newText 把 oldText 整个包在里面（追加式改动），就必须显式给 marker，
// 否则每跑一次都会再追加一遍。
function adapt(text, oldText, newText, label, appliedMarker) {
  const marker = appliedMarker || newText;
  if (text.includes(marker)) { log(`    对接点 ${label}：已是适配后状态，跳过`); return text; }
  if (!text.includes(oldText)) {
    fails.push(`对接点 ${label}：既找不到原实现，也找不到适配后状态 —— 拒绝产出，请人工检查`);
    return text;
  }
  log(`    对接点 ${label}：已适配`);
  return text.replace(oldText, newText);
}

// 对接点 A：日志行要带 .log-line（新设计用 .log-line / .log-line.ok 等选择器）
const oldLog = `function log(s, cls) { var d = $('log'), n = document.createElement('div'); n.className = cls || ''; n.textContent = s; d.appendChild(n); d.scrollTop = d.scrollHeight; }`;
const newLog = `function log(s, cls) { var d = $('log'), n = document.createElement('span'); n.className = ('log-line ' + (cls || '')).trim(); n.textContent = s; d.appendChild(n); d.scrollTop = d.scrollHeight; }`;
uiJs = adapt(uiJs, oldLog, newLog, 'A/log()');

// 对接点 B：完成态改用设计稿的独立成功卡，不再往日志里塞 <a>
const oldDone = `      var blob = new Blob([res.html], { type: 'text/html;charset=utf-8' });
      var name = (res.meta.expName || 'experiment') + '_便携包.html';
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; a.textContent = '⬇ 点击下载 ' + name + '（' + (blob.size / 1048576).toFixed(2) + ' MB）';
      $('log').appendChild(a);
      $('log').appendChild(document.createElement('br'));
      log('✅ 完成。把这个文件发给被试即可。', 'ok');`;
const newDone = `      var blob = new Blob([res.html], { type: 'text/html;charset=utf-8' });
      var name = (res.meta.expName || 'experiment') + '_便携包.html';
      // 完成态：用设计稿的 #successResult + #resultLink，比"往日志里塞个链接"清楚得多
      var link = $('resultLink');
      if (link) {
        if (link.dataset.url) { try { URL.revokeObjectURL(link.dataset.url); } catch (e) {} }
        var url = URL.createObjectURL(blob);
        link.dataset.url = url;
        link.href = url;
        link.download = name;
        var label = link.querySelector('span:last-child');
        if (label) label.textContent = '下载 ' + name;
        var sres = $('successResult');
        if (sres) sres.hidden = false;
      }
      log('✅ 完成。把这个文件发给被试即可。', 'ok');`;
uiJs = adapt(uiJs, oldDone, newDone, 'B/完成态');

// 对接点 C：重跑前先收起上一次的成功卡
const oldStart = `  $('go').onclick = async function () {
    var btn = this; btn.disabled = true;`;
const newStart = `  $('go').onclick = async function () {
    var btn = this; btn.disabled = true;
    var sres0 = $('successResult'); if (sres0) sres0.hidden = true;`;
uiJs = adapt(uiJs, oldStart, newStart, 'C/收起成功卡');

// 对接点 D：打包完成后把**真产物**交给右栏预览区
// （预览区自己决定怎么展示：空态 -> 两页轮播。这里只负责通知，不关心它怎么画。）
const doneLog = `      log('✅ 完成。把这个文件发给被试即可。', 'ok');`;
const doneLogHooked = doneLog + `
      // 把真产物交给右栏预览区；预览失败绝不影响下载
      try {
        document.dispatchEvent(new CustomEvent('psyweb:packed', {
          detail: { html: res.html, name: name, bytes: blob.size, resources: Object.keys(res.resources || {}).length }
        }));
      } catch (e) { /* 预览是可选的，出错不打扰主流程 */ }`;
uiJs = adapt(uiJs, doneLog, doneLogHooked, 'D/通知预览区', 'psyweb:packed');

// ============ 2. 从设计稿里摘出交互机关 ============
// 只留**分栏拖拽**。等比缩放那套（fitPreview / fitParticipantPage / ResizeObserver，
// 共 1600 字符）随模拟稿一起删掉 —— 预览改成真产物 iframe 后，iframe 按 CSS 撑满即可，
// transform 缩放只会让画面发虚，属于"优化一个不该存在的东西"。
const draft = fs.readFileSync(DRAFT, 'utf8');
log(`[2] 读入设计稿 ${draft.length} 字符`);

function slice(fromMark, toMark, label) {
  const a = draft.indexOf(fromMark);
  if (a < 0) { fails.push(`摘取失败：找不到起点 ${label}`); return ''; }
  const b = draft.indexOf(toMark, a);
  if (b < 0) { fails.push(`摘取失败：找不到终点 ${label}`); return ''; }
  return draft.slice(a, b);
}
const refs = slice(`const workspace = document.querySelector('.workspace');`, `let selectedFiles = [];`, '分栏依赖的 DOM 引用');
const splitter = slice(`function setSplit(clientX) {`, `function relevantFile(file) {`, '分栏拖拽逻辑');
log(`    机关：分栏引用 ${refs.length} + 分栏逻辑 ${splitter.length} 字符`);
if (!splitter.includes('setSplit') || !splitter.includes('pointerdown')) fails.push('分栏拖拽逻辑摘取不完整');
if (!refs.includes('splitter') || !refs.includes('workspace')) fails.push('分栏依赖引用摘取不完整');
if (splitter.includes('fitPreview') || refs.includes('screenFit')) fails.push('等比缩放机制未被删干净');

const mechanicsJs = `(function () {
  'use strict';
  /* 分栏拖拽：**原样取自设计稿**（含键盘左右键 + aria-valuenow），是真机关，不是样稿。
     原设计稿里的"预览等比缩放"已刻意删除：预览改成真产物 iframe 后由 CSS 撑满，
     不需要 transform 缩放（缩放会让画面发虚）。 */
  ${refs}${splitter}})();
`;

// ============ 3. 处理设计稿：删样稿、留结构 ============
let page = draft;

function mustRemove(re, label) {
  const before = page.length;
  const m = page.match(re);
  if (!m) { fails.push(`删除失败（模式未命中）：${label}`); return; }
  page = page.replace(re, '');
  log(`    删除 ${label}（${before - page.length} 字符）`);
}
// 假状态样稿
mustRemove(/<div class="drop-state-samples"[\s\S]*?<\/div>\s*<\/section>/, '拖放区三态样例 .drop-state-samples');
mustRemove(/<div class="interaction-samples"[\s\S]*?<\/div>\n/, '按钮状态样例 .interaction-samples');
mustRemove(/<div class="error-sample"[\s\S]*?<\/div>\n/, '假出错日志 .error-sample');

// #log 清空（预填的 12 行假日志）
const logRe = /(<div id="log"[^>]*>)([\s\S]*?)(<\/div>)/;
const logM = page.match(logRe);
if (!logM) { fails.push('找不到 #log 容器'); }
else {
  const inner = logM[2];
  const fakeCount = (inner.match(/log-line/g) || []).length;
  page = page.replace(logRe, `$1$3`);
  log(`    清空 #log 内预填的 ${fakeCount} 行假日志`);
  if (fakeCount < 10) fails.push(`#log 里只找到 ${fakeCount} 行假日志，与预期(12)不符`);
}

// 离线卡片默认隐藏（单文件工具在 file:// 下没有 offline.html，显示只会 404）
page = page.replace(/(<section[^>]*id="offlineCard"[^>]*?)(>)/, (m, a, b) => {
  if (/style=/.test(a)) return a + b;
  return a + ' style="display:none"' + b;
});
if (!/id="offlineCard"[^>]*style="display:none"/.test(page)) fails.push('#offlineCard 未能设为默认隐藏');

// 日志标题文案：设计稿写的是"示例日志 · 打包后逐行显示…"，但生产页面日志初始为空，
// 说"示例"会让人以为里面有东西 —— 去掉"示例"二字。
const oldLogHeading = '示例日志 · 打包后逐行显示本机处理进度';
if (!page.includes(oldLogHeading)) fails.push('找不到日志标题文案（设计稿可能已改）');
else { page = page.replace(oldLogHeading, '打包后在此逐行显示本机处理进度'); log('    改日志标题文案：去掉"示例"二字'); }

// 页面标题：设计稿写的是"psyweb 在线打包 · 界面设计稿"，生产页面要用真标题
const oldTitle = '<title>psyweb 在线打包 · 界面设计稿</title>';
const newTitle = '<title>psyweb 在线打包 · PsychoPy 实验一键变单文件网页</title>';
if (!page.includes(oldTitle)) fails.push('找不到设计稿的 <title>（设计稿可能已改）');
else { page = page.replace(oldTitle, newTitle); log('    改 <title>：设计稿标题 → 生产标题'); }

// "样例"是评审语境；生产页面上它是"被试会看到的样子"，措辞要改成事实。
// （WebGL 失败态这张卡本身有价值，保留，只改措辞。）
const copyFixes = [
  ['WebGL 不可用时的状态样例', 'WebGL 不可用时被试看到的样子'],
  ['显示引擎 · 检测失败状态样例', '显示引擎 · 检测失败时被试看到的样子'],
];
for (const [a, b] of copyFixes) {
  if (!page.includes(a)) fails.push(`找不到待改文案: "${a}"`);
  else { page = page.replace(a, b); log(`    改文案: "${a}" → "${b}"`); }
}

// ---------------------------------------------------------------------------
// 【减法】预览区只允许"初始状态"，不允许"条件状态"
// ---------------------------------------------------------------------------
// 用户反馈（2026-09-24）：初始界面不该出现这两块。它们都是**条件状态**，却被设计稿
// 当成静态内容画进了预览：
//   · .recovery-card 只有"上次异常退出、本地还留着数据"时才出现 ——
//     而且设计稿里写死了假数据（11 行、2026/9/24 00:31:08）
//   · .webgl-variant 只有"没检测到 WebGL"时才出现
// 上一轮我按"我注意到的块"清假数据，没按"缺陷类型"收口，所以漏了同类问题。
// 这一轮按类型收口：**凡是条件状态，都不进初始预览**。
mustRemove(/<section class="recovery-card">[\s\S]*?<\/section>[ \t]*\r?\n/, '条件状态：恢复上次数据卡 .recovery-card');
mustRemove(/<aside class="webgl-variant"[\s\S]*?<\/aside>[ \t]*\r?\n/, '条件状态：WebGL 失败参考卡 .webgl-variant');

// 栅格连带修改：模板是 "consent recovery" —— 两张卡**并排各占一半**。
// 只删卡片不改栅格，知情同意卡会被压成半宽、右边空出一块（这个下游影响差点漏掉）。
const oldAreas = '"consent recovery"';
if (!page.includes(oldAreas)) fails.push('找不到 grid-template-areas 里的 "consent recovery"');
else { page = page.replace(oldAreas, '"consent consent"'); log('    连带改栅格："consent recovery" → "consent consent"'); }

// （模拟稿的整族死 CSS 在下面"换骨"一步里统一清理，这里不再重复一遍，
//   否则 deadClasses / dropped / leftoverCss 会在同一作用域里重复声明 → SyntaxError）

// ---------------------------------------------------------------------------
// 【换骨】右栏预览：手抄的模拟稿 → 真产物活预览
// ---------------------------------------------------------------------------
// 用户反馈（2026-09-24）："预览窗口不是应该预览内容的吗？还没有上传转换之前不应该是
// 空白写着预览窗口吗？转换之后应该显示这一页（选择实验）和下一页正式实验的第一页。"
//
// 手抄一份"被试开始页"的做法从根上就会漂移（已被抓到两次：假日志、条件状态）。
// 现在整块换掉：把**真实产物**放进 iframe 里跑。
//   · 空态  = 还没转换，没有任何可预览的内容
//   · 页 ①  = 产物原样加载（真开始页）
//   · 页 ②  = 同一产物自动点一下「▶ 点击开始」（真实验第一屏）
// 顺带删掉整块模拟稿标记与它的 CSS。
const paneHtml = fs.readFileSync(path.join(__dirname, 'preview-pane.html'), 'utf8').trim();
const paneCss = fs.readFileSync(path.join(__dirname, 'preview-pane.css'), 'utf8');
const paneJs = fs.readFileSync(path.join(__dirname, 'preview-pane.js'), 'utf8');

const paneRe = /<aside class="preview-pane"[\s\S]*?<\/aside>/;
if (!paneRe.test(page)) fails.push('找不到设计稿的 <aside class="preview-pane"> 整块');
else {
  const before = page.length;
  page = page.replace(paneRe, paneHtml);
  log(`    换掉右栏模拟稿：整块替换（${before - page.length} 字符差）`);
}
// 替换后的 CSS / JS 注入
if (!page.includes('id="previewEmpty"')) fails.push('右栏替换失败：新标记未出现');
if (!page.includes('</style>')) fails.push('找不到 </style>，无法注入预览区 CSS');
else { page = page.replace('</style>', paneCss + '\n  </style>'); log('    注入预览区 CSS'); }

// 模拟稿留下的死 CSS：整族清掉（Musk 第二步：删不掉的 10% 说明删得不够）
const deadClasses = ['recovery-card', 'recovery-title', 'recovery-help', 'recovery-button',
                     'webgl-variant', 'variant-caption', 'variant-copy', 'variant-help',
                     'screen-fit', 'participant-screen', 'participant-subtitle', 'participant-card',
                     'checks-card', 'check-row', 'check-label', 'check-text', 'consent-card',
                     'start-button', 'participant-actions', 'participant-note', 'ready-text'];
let dropped = 0;
for (const c of deadClasses) {
  const re = new RegExp(`^[ \\t]*\\.${c}[^{}]*\\{[^{}]*\\}[ \\t]*\\r?\\n`, 'gm');
  const before = page.length;
  page = page.replace(re, '');
  if (page.length !== before) dropped++;
}
log(`    清除模拟稿的死 CSS：${dropped}/${deadClasses.length} 个类`);
const leftoverCss = deadClasses.filter((c) => page.includes(c));
if (leftoverCss.length) fails.push('死 CSS 未清干净: ' + leftoverCss.join(', '));

// 移除设计稿的演示脚本
const demoRe = /\n  <script>[\s\S]*?\n  <\/script>\n<\/body>/;
if (!demoRe.test(page)) fails.push('找不到设计稿的演示脚本块');
else { page = page.replace(demoRe, '\n</body>'); log('    移除设计稿的演示脚本（假打包流程）'); }

// ============ 4. 注入真逻辑 ============
const inject = `
<script src="./pack-core.js"></script>
<script>
${mechanicsJs}</script>
<script>
${paneJs}</script>
<script>
${uiJs}
</script>
</body>`;
page = page.replace(/\n<\/body>/, '\n' + inject.trimStart().replace(/^/, '\n'));
// 上面的 replace 只替换第一次出现的 \n</body>
log(`[4] 注入 pack-core.js + 机关 + 真实逻辑`);

// ============ 5. 自检 ============
log('\n[5] 自检');
const FORBID = ['将读取 12 个', '示例日志', '出错：没有可处理的文件', '读取 8 个文件…', '组装完成：3.61 MB', '禁用</span><span class="mini-button ready">', 'demoHtml', '交互演示文件', '界面设计稿', '状态样例',
  // 条件状态不得进初始预览（按缺陷类型收口，不按"我注意到的块"收口）
  '发现上次运行留下的数据', '下载上次的数据', '未检测到 WebGL，本实验无法运行',
  'recovery-card', 'webgl-variant', '"consent recovery"'];
for (const s of FORBID) {
  if (page.includes(s)) { fails.push(`假数据残留: "${s}"`); log(`    ❌ 残留 "${s}"`); }
}
if (!fails.length || !fails.some((f) => f.startsWith('假数据'))) log('    ✅ 假数据/假日志全部清除');

const REQUIRE = ['src="./pack-core.js"', 'window.__psywebSite', 'loadAssets', 'PsywebPack.pack',
  'setSplit', 'successResult', 'resultLink', 'psyweb:packed',
  // 右栏活预览：空态 + 两页轮播 + 两个 iframe + 导航
  'id="previewEmpty"', 'id="previewCarousel"', 'id="pvFrame0"', 'id="pvFrame1"',
  'id="pvPrev"', 'id="pvNext"', '预览窗口', '① 开始页', '② 实验第 1 页'];
for (const s of REQUIRE) {
  if (!page.includes(s)) { fails.push(`缺少必需内容: ${s}`); log(`    ❌ 缺 ${s}`); }
}
log('    ✅ 真实打包逻辑与交互机关均已注入');

const IDS = ['drop', 'dir', 'pickDir', 'picked', 'title', 'go', 'log', 'offlineCard', 'offlineLink'];
const missIds = IDS.filter((i) => !new RegExp(`\\bid="${i}"`).test(page));
if (missIds.length) { fails.push('id 白名单缺失: ' + missIds.join(', ')); log('    ❌ 缺 id: ' + missIds.join(', ')); }
else log('    ✅ id 白名单 9/9 完整');

// ============ 结论 ============
if (fails.length) {
  console.log('\n❌ 合入失败：');
  fails.forEach((f) => console.log('   - ' + f));
  process.exit(1);
}
if (DRY) { console.log('\n（--dry：未写盘）'); process.exit(0); }
fs.writeFileSync(SITE, page, 'utf8');
console.log(`\n✅ 已写出 ${SITE}  (${page.length} 字符, ${Buffer.byteLength(page)} 字节)`);
