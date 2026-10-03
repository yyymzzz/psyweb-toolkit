#!/usr/bin/env node
/* ============================================================================
 * psyweb 本地工具 —— 把"一条命令"变成一个别人也会用的入口
 * ----------------------------------------------------------------------------
 * 形态：双击 启动psyweb工具.cmd → 浏览器打开 http://127.0.0.1:<port> →
 *       把整个实验文件夹拖进去 → 点「转换」→ 下载单文件便携包。
 *
 * 为什么必须是"本地服务 + 浏览器界面"而不是纯网页工具：
 *   ① 转换要调用本机的 PsychoPy Python（浏览器做不到）
 *   ② 要读实验文件夹里的图片/音频/条件文件（浏览器只能靠用户逐个选）
 *   ③ 在线版要承担服务器/备案/数据出境 —— 而本工具的全部价值就是"数据不出本机"
 * 为什么不用 Electron：几百 MB 依赖，而这里只需要一个 http 服务和一次 spawn。
 *
 * 零第三方依赖（只用 Node 内置模块 + vendor/ 里的 SheetJS），便于随仓库分发。
 * 用法: node src/tool-server.js [--port 7788] [--no-open]
 *
 * ⚠️ 页面脚本不再内嵌在本文件的模板字符串里（历史事故见 src/tool-page.js 头注）。
 *    本文件只负责**把磁盘上的真实文件整段内联**进页面，并在内联前做危险序列检查；
 *    内联结果的正确性由 spike/m0/src/verify-tool-page.js 逐字符比对 + 强制编译来保证。
 * ========================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '输出');
const MAX_BODY = 400 * 1024 * 1024;      // 转换请求上限（物理兜底，不是筛选手段）
const MAX_TABLES_BODY = 64 * 1024 * 1024; // /api/tables 只传条件表，体积很小

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const PORT = parseInt(arg('port', '7788'), 10);
const NO_OPEN = process.argv.includes('--no-open');

// ---------------------------------------------------------------- 环境检测
function detectPsychoPy() {
  const env = process.env.PSYWEB_PSYCHOPY_PYTHON;
  const cands = [];
  if (env) cands.push(env);
  for (const d of ['C', 'D', 'E', 'F']) {
    cands.push(d + ':\\PsychoPy\\python.exe');
    cands.push(d + ':\\Program Files\\PsychoPy\\python.exe');
  }
  for (const c of cands) {
    if (!c || !fs.existsSync(c)) continue;
    const r = spawnSync(c, ['-c', 'import psychopy,sys;sys.stdout.write(psychopy.__version__)'],
      { encoding: 'utf8', timeout: 120000 });
    if (r.status === 0 && (r.stdout || '').trim()) return { python: c, version: r.stdout.trim() };
  }
  return null;
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// ---------------------------------------------------------------- 页面
/** 读一个要内联进页面的源文件，并挡住会提前截断 <script> 的序列 */
function readInline(name) {
  const p = path.join(__dirname, name);
  if (!fs.existsSync(p)) throw new Error('页面内联源文件缺失: ' + p + '（仓库不完整？）');
  const code = fs.readFileSync(p, 'utf8');
  if (/<\/script/i.test(code)) throw new Error(name + ' 含 "</script" —— 内联到页面会提前截断脚本块');
  if (/<!--/.test(code)) throw new Error(name + ' 含 "<!--" —— HTML 注释序会在脚本块内引起歧义');
  return code;
}

function pageHtml() {
  const refClosureSrc = readInline('ref-closure.js');
  const toolPageSrc = readInline('tool-page.js');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>psyweb 转换工具</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--line:#e3e6ea;--ink:#1a1a1a;--muted:#6b7280;--ok:#0f8a4a;--warn:#b45309;--bad:#c0392b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 system-ui,"Microsoft YaHei",sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:28px}
h1{font-size:22px;margin:0 0 4px}
.sub{color:var(--muted);margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:16px}
#drop{border:2px dashed #c3c9d2;border-radius:12px;padding:34px;text-align:center;color:var(--muted);cursor:pointer;transition:.15s}
#drop.hot{border-color:#2f6fed;background:#eef4ff;color:#2f6fed}
button{font:inherit;padding:10px 20px;border:0;border-radius:9px;background:#2f6fed;color:#fff;cursor:pointer}
button:disabled{background:#a8b6cd;cursor:not-allowed}
button.ghost{background:#e8eaee;color:#333}
input[type=text]{font:inherit;padding:8px 11px;border:1px solid var(--line);border-radius:8px;width:280px}
label{display:inline-block;min-width:78px;color:var(--muted)}
#log{max-height:260px;overflow:auto;background:#fbfbfc;border:1px solid var(--line);border-radius:9px;padding:11px;font:12px/1.7 ui-monospace,Consolas,monospace;margin-top:12px;white-space:pre-wrap}
.ok{color:var(--ok)} .warn{color:var(--warn)} .bad{color:var(--bad)}
.env{font-size:13px;color:var(--muted)}
.env b{color:var(--ink)}
a{color:#2f6fed}
</style></head>
<body><div class="wrap">
  <h1>psyweb 转换工具</h1>
  <div class="sub">把 PsychoPy 实验变成<b>一个 html 文件</b>：被试双击即测，数据用截图或 CSV 发回来。全程本地运行，不上传任何东西。</div>

  <div class="card">
    <div class="env" id="env">正在检测本机 PsychoPy…</div>
  </div>

  <div class="card">
    <div id="drop">把<b>整个实验文件夹</b>拖到这里<br><span style="font-size:13px">（里面应有 .psyexp 和它的图片/音频/条件文件）</span></div>
    <input id="dir" type="file" webkitdirectory multiple style="display:none">
    <input id="files" type="file" multiple style="display:none">
    <div style="margin-top:12px">
      <button class="ghost" id="pickDir">选择文件夹</button>
      <button class="ghost" id="pickFiles">只选 .psyexp（资源已在别处时）</button>
    </div>
    <div id="picked" class="env" style="margin-top:10px">尚未选择文件</div>
  </div>

  <div class="card">
    <div style="margin-bottom:12px"><label>实验标题</label><input id="title" type="text" placeholder="会显示在开始页上"></div>
    <div style="margin-bottom:14px"><label>主文件</label><span id="mainFile" class="env">（自动识别文件夹里的 .psyexp）</span></div>
    <button id="go" disabled>开始转换</button>
    <span class="env" style="margin-left:10px">转换只在本机进行，产物会保存到 <code>psyweb/输出/</code></span>
    <div id="log"></div>
  </div>

  <div class="card">
    <div style="font-weight:700;margin-bottom:6px">做完了怎么用</div>
    <div class="env">① 把生成的 <b>html 文件</b>发给被试（微信/QQ/邮件都行，手机上别点开）<br>
    ② 被试在电脑上双击完成 → 结果页给出「摘要 / 下载 CSV / 数据二维码」<br>
    ③ 对方把截图或 CSV 发回 → 用 <code>site/collector.html</code> 拖进去即可还原成表格</div>
  </div>
</div>
<script>${refClosureSrc}</script>
<script>${toolPageSrc}</script>
</body></html>`;
}

// ---------------------------------------------------------------- 条件表解析
/** 把 xlsx/xls 解成二维数组交给浏览器，让浏览器侧的 ref-closure 拿到"列值"。
 *  为什么放服务端：SheetJS 已经在 vendor/ 里（pack-portable 本来就要用），
 *  浏览器侧就不必再引入解压/解包逻辑 —— 网页版那边再用 pako 补上同一接口。 */
function readXlsxRows(absPath) {
  const XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
  const wb = XLSX.readFile(absPath);
  const out = [];
  wb.SheetNames.forEach((sn) => {
    XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false }).forEach((row) => {
      if (row && row.length) out.push(row.map((v) => (v == null ? '' : String(v))));
    });
  });
  return out;
}

function handleTables(payload) {
  const log = [];
  const rows = {};
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'psyweb-tables-'));
  try {
    for (const f of (payload.files || [])) {
      const rel = String(f.rel || f.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!rel || rel.indexOf('..') >= 0) { log.push({ line: '⚠️ 跳过非法路径: ' + rel, cls: 'warn' }); continue; }
      const abs = path.join(work, rel);
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.from(f.b64, 'base64'));
        rows[rel] = readXlsxRows(abs);
      } catch (e) {
        log.push({ line: '⚠️ 条件表解析失败 ' + rel + '：' + e.message, cls: 'warn' });
        rows[rel] = null;
      }
    }
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {}
  }
  return { ok: true, rows, log };
}

// ---------------------------------------------------------------- 转换
function doConvert(payload) {
  const log = [];
  const say = (line, cls) => log.push({ line, cls: cls || '' });

  // 写入临时目录，保留相对路径
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'psyweb-tool-'));
  let psyexpAbs = null;
  let skipped = 0;
  // 服务端也做一遍过滤（纵深防御）：即使客户端没挡住，历史数据目录也不会落盘
  const SKIP_SERVER = /(^|\/)(data|__pycache__|node_modules|\.git|实验截图|_调试残留)(\/|$)/i;
  for (const f of payload.files) {
    const rel = String(f.name).replace(/\\/g, '/').replace(/^\/+/, '');
    if (rel.indexOf('..') >= 0) continue;                      // 防目录穿越
    if (SKIP_SERVER.test(rel)) { skipped++; continue; }
    const abs = path.join(work, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(f.b64, 'base64'));
    if (/\.psyexp$/i.test(rel) && !psyexpAbs) psyexpAbs = abs;
  }
  if (skipped) say('（服务端跳过 ' + skipped + ' 个历史数据/无关文件）');
  if (!psyexpAbs) return { ok: false, log: [{ line: '❌ 上传的文件里没有 .psyexp', cls: 'bad' }] };
  say('主文件：' + path.relative(work, psyexpAbs));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = path.basename(psyexpAbs, '.psyexp').replace(/[\\/:*?"<>|]/g, '_');
  const outAbs = path.join(OUT_DIR, base + '_便携包.html');

  const r = spawnSync(process.execPath,
    [path.join(__dirname, 'build-portable.js'), '--psyexp', psyexpAbs, '--out', outAbs,
     '--title', payload.title || '在线实验'],
    { encoding: 'utf8', timeout: 600000 });

  const text = ((r.stdout || '') + (r.stderr || '')).trim();
  text.split('\n').forEach((l) => {
    if (!l.trim()) return;
    const cls = /失败|错误|❌|Error/.test(l) ? 'bad' : /⚠️|告警|Alert/.test(l) ? 'warn' : '';
    say(l, cls);
  });

  try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {}
  if (r.status !== 0 || !fs.existsSync(outAbs)) return { ok: false, log };
  return {
    ok: true, log,
    outName: path.basename(outAbs),
    outPath: outAbs,
    size: fs.statSync(outAbs).size,
    url: '/out/' + encodeURIComponent(path.basename(outAbs))
  };
}

// ---------------------------------------------------------------- 请求体
function readBody(req, res, limit, onDone) {
  let body = '', size = 0, killed = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { killed = true; req.destroy(); return; }
    body += c;
  });
  req.on('end', () => { if (!killed) onDone(body); });
}

// ---------------------------------------------------------------- 服务
const server = http.createServer((req, res) => {
  // 只接受本机来源的同源请求。
  // 为什么需要：即使只绑 127.0.0.1，任意网页仍可让浏览器向本机发跨站请求
  // （DNS rebinding / 表单 CSRF 面），触发本机转换并往 输出\ 落盘。
  // 校验 Host + Origin（Origin 缺失视为同源导航，允许）。
  {
    const host = String(req.headers.host || '');
    const origin = String(req.headers.origin || '');
    const allow = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
    const okHost = allow.indexOf(host) >= 0;
    const okOrigin = !origin || allow.some((h) => origin === `http://${h}`);
    if (!okHost || !okOrigin) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('forbidden: 仅允许本机同源访问');
      return;
    }
  }
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    try { return send(res, 200, pageHtml(), 'text/html; charset=utf-8'); }
    catch (e) { return send(res, 500, '页面生成失败: ' + e.message, 'text/plain; charset=utf-8'); }
  }
  if (req.method === 'GET' && req.url === '/api/env') {
    const py = detectPsychoPy();
    return send(res, 200, JSON.stringify(py ? { python: py.python, version: py.version } : { python: null }));
  }
  if (req.method === 'GET' && req.url.startsWith('/out/')) {
    const name = path.basename(decodeURIComponent(req.url.slice(5)));
    const abs = path.join(OUT_DIR, name);
    if (!abs.startsWith(OUT_DIR) || !fs.existsSync(abs)) return send(res, 404, JSON.stringify({ error: 'not found' }));
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + encodeURIComponent(name) + '"'
    });
    return fs.createReadStream(abs).pipe(res);
  }
  if (req.method === 'POST' && req.url === '/api/tables') {
    return readBody(req, res, MAX_TABLES_BODY, (body) => {
      try {
        const payload = JSON.parse(body);
        send(res, 200, JSON.stringify(handleTables(payload)));
      } catch (e) {
        send(res, 500, JSON.stringify({ ok: false, error: '条件表解析失败: ' + e.message }));
      }
    });
  }
  if (req.method === 'POST' && req.url === '/api/convert') {
    return readBody(req, res, MAX_BODY, (body) => {
      try {
        const payload = JSON.parse(body);
        if (!payload.files || !payload.files.length) return send(res, 400, JSON.stringify({ ok: false, log: [{ line: '❌ 没有收到文件', cls: 'bad' }] }));
        const out = doConvert(payload);
        send(res, out.ok ? 200 : 500, JSON.stringify(out));
      } catch (e) {
        send(res, 500, JSON.stringify({ ok: false, log: [{ line: '❌ ' + e.message, cls: 'bad' }] }));
      }
    });
  }
  send(res, 404, JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  const py = detectPsychoPy();
  const url = 'http://127.0.0.1:' + PORT + '/';
  console.log('psyweb 转换工具已启动: ' + url);
  console.log('本机 PsychoPy: ' + (py ? py.python + ' (' + py.version + ')' : '未找到 —— 仍可用「已导出的 js」兜底'));
  console.log('产物输出目录: ' + OUT_DIR);
  console.log('按 Ctrl+C 停止。');
  if (!NO_OPEN) {
    try {
      if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
      else if (process.platform === 'darwin') execFile('open', [url]);
      else execFile('xdg-open', [url]);
    } catch (e) { /* 打不开就让用户手动点 */ }
  }
});
