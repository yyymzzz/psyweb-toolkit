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
 * 零第三方依赖（只用 Node 内置模块），便于随仓库分发。
 * 用法: node src/tool-server.js [--port 7788] [--no-open]
 * ========================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '输出');
const MAX_BODY = 400 * 1024 * 1024;      // 400 MB 上限（实验资源一般几 MB~几十 MB）

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
function pageHtml() {
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
<script>
var picked = [];
function log(s, cls){ var d=document.getElementById('log'); var n=document.createElement('div'); n.className=cls||''; n.textContent=s; d.appendChild(n); d.scrollTop=d.scrollHeight; }

// base64 必须**分块**转换。
// 实测事故：btoa(String.fromCharCode.apply(null, u8)) 对 >64KB 的文件会抛
// RangeError: Maximum call stack size exceeded（apply 传超大数组参数爆栈），
// 而读取循环当时在 try/catch 之外 —— 异常被静默吞掉，按钮一直灰着、日志停在
// "读取文件…"，用户看到的就是"点了没反应"。
function toB64(u8){
  var CH = 0x8000, out = '';
  for (var i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(out);
}
// 只收"实验真正需要"的文件；把历史数据/截图目录/超大文件挡在门外
// 注意：本段代码位于模板字符串内部，正则里的反斜杠必须**双写**（\\. 与 \\/），
// 否则模板字符串会把反斜杠吃掉，生成出 /(^|/ 这种截断的正则 →
// 整页脚本 SyntaxError、所有函数都没定义（实测被探针抓到）。
var KEEP_EXT = /\\.(psyexp|png|jpe?g|gif|bmp|webp|mp3|wav|ogg|mp4|mov|avi|xlsx?|csv|tsv|odp|txt)$/i;
var SKIP_DIR = /(^|\\/)(data|__pycache__|node_modules|\\.git|实验截图|_调试残留)/i;
var MAX_FILE = 50 * 1024 * 1024;
function classify(list){
  var keep = [], skipDir = 0, skipExt = 0, skipBig = 0;
  list.forEach(function(f){
    var rel = f.relPath || f.name;
    if (SKIP_DIR.test(rel)) { skipDir++; return; }
    if (!KEEP_EXT.test(f.name)) { skipExt++; return; }
    if (f.size > MAX_FILE) { skipBig++; return; }
    keep.push(f);
  });
  return { keep: keep, skipDir: skipDir, skipExt: skipExt, skipBig: skipBig };
}
function setPicked(files){
  picked = Array.prototype.slice.call(files);
  var c = classify(picked);
  var psy = c.keep.filter(function(f){ return /\\.psyexp$/i.test(f.name); });
  var mb = c.keep.reduce(function(a,f){ return a + (f.size||0); }, 0) / 1048576;
  document.getElementById('picked').textContent = picked.length
    ? ('共选 ' + picked.length + ' 个文件 → 需要上传 ' + c.keep.length + ' 个（' + mb.toFixed(1) + ' MB）'
       + '，已跳过 ' + (c.skipDir + c.skipExt + c.skipBig) + ' 个'
       + '（data 等目录 ' + c.skipDir + ' / 非实验文件 ' + c.skipExt + ' / 超大 ' + c.skipBig + '）')
    : '尚未选择文件';
  document.getElementById('mainFile').textContent = psy.length ? psy[0].name : '（没找到 .psyexp —— 请把实验文件夹整个拖进来）';
  document.getElementById('go').disabled = psy.length === 0;
  if (psy.length && !document.getElementById('title').value) {
    document.getElementById('title').value = psy[0].name.replace(/\\.psyexp$/i,'');
  }
}
fetch('/api/env').then(function(r){return r.json();}).then(function(e){
  // 界面不要暴露"某台机器的绝对路径"——分发出去后那是别人的机器。
  // 只报"找到没有 + 版本"，路径折进小字里供排查。
  document.getElementById('env').innerHTML = e.python
    ? ('已找到本机 <b>PsychoPy ' + e.version + '</b>　·　官方编译器就绪（可直接转换 .psyexp）' +
       '<div style="font-size:12px;opacity:.65;margin-top:3px">' + e.python + '</div>')
    : ('<span class="bad">本机没找到 PsychoPy。</span> 两条路可选：' +
       '<div style="font-size:13px;margin-top:4px">' +
       '① 安装 PsychoPy（<a href="https://www.psychopy.org/download.html" target="_blank">官网下载</a>，standalone 版自带 Python，装完重开本工具）；<br>' +
       '② 不装也行：让对方在 PsychoPy Builder 里点一次 <b>Export HTML</b>，把导出的文件夹拖进来（走兜底路径，不需要 Python）。' +
       '</div>');
}).catch(function(){ document.getElementById('env').textContent = '环境检测失败'; });

var drop = document.getElementById('drop');
['dragenter','dragover'].forEach(function(t){ drop.addEventListener(t, function(e){ e.preventDefault(); drop.classList.add('hot'); }); });
['dragleave','drop'].forEach(function(t){ drop.addEventListener(t, function(e){ e.preventDefault(); drop.classList.remove('hot'); }); });
drop.addEventListener('drop', function(e){
  var items = e.dataTransfer.items, out = [], pending = 0;
  // 支持"拖文件夹"：用 webkitGetAsEntry 递归取文件并保留相对路径
  if (items && items.length && items[0].webkitGetAsEntry) {
    for (var i=0;i<items.length;i++){
      var entry = items[i].webkitGetAsEntry();
      if (!entry) continue;
      pending++;
      (function(ent){ walk(ent, '', function(list){ out = out.concat(list); if(--pending===0) setPicked(out); }); })(entry);
    }
  } else { setPicked(e.dataTransfer.files); }
});
function walk(entry, prefix, done){
  if (entry.isFile) {
    entry.file(function(f){ try { Object.defineProperty(f, 'relPath', { value: prefix + f.name }); } catch(e){} done([f]); });
  } else if (entry.isDirectory) {
    var reader = entry.createReader(), all = [];
    var read = function(){ reader.readEntries(function(batch){
      if (!batch.length) { var i=0; (function next(){ if(i>=all.length) return done([]); walk(all[i++], prefix + entry.name + '/', function(l){ all.lists = (all.lists||[]).concat(l); next(); }); })(); return; }
      all = all.concat(batch); read();
    }); };
    // 简化：一次性收集目录项后逐个走
    reader.readEntries(function first(batch){
      if (!batch.length) return done([]);
      var files = [], dirs = [], todo = batch.length, more = true;
      var collect = function(list){ list.forEach(function(en){ (en.isFile?files:dirs).push(en); }); if(--todo===0){ if(more) readMore(); else finish(); } };
      var readMore = function(){ reader.readEntries(function(b){ if(!b.length){ more=false; finish(); return; } todo=b.length; b.forEach(collect); }); };
      var finish = function(){
        var out = [], t = files.length + dirs.length;
        if (!t) return done([]);
        files.forEach(function(en){ walk(en, prefix + entry.name + '/', function(l){ out = out.concat(l); if(--t===0) done(out); }); });
        dirs.forEach(function(en){ walk(en, prefix + entry.name + '/', function(l){ out = out.concat(l); if(--t===0) done(out); }); });
      };
      batch.forEach(collect);
    });
  } else done([]);
}
document.getElementById('pickDir').onclick = function(){ document.getElementById('dir').click(); };
document.getElementById('pickFiles').onclick = function(){ document.getElementById('files').click(); };
document.getElementById('dir').onchange = function(e){
  var fs2 = Array.prototype.slice.call(e.target.files);
  fs2.forEach(function(f){ try { Object.defineProperty(f,'relPath',{value: f.webkitRelativePath || f.name}); } catch(err){} });
  setPicked(fs2);
};
document.getElementById('files').onchange = function(e){ setPicked(e.target.files); };

document.getElementById('go').onclick = async function(){
  var btn = this; btn.disabled = true;
  // 整个流程都包在 try/finally 里：哪怕是读文件阶段出错，也要把错误显示出来
  // 并把按钮恢复——绝不能出现"点了没反应、按钮永远灰着"（实测踩过）。
  try {
    var c = classify(picked);
    var skipped = c.skipDir + c.skipExt + c.skipBig;
    log('读取 ' + c.keep.length + ' 个文件' + (skipped ? ('（已跳过 ' + skipped + ' 个无关文件：data 等目录 ' + c.skipDir + ' / 非实验文件 ' + c.skipExt + ' / 超大 ' + c.skipBig + '）') : '') + '…');
    if (!c.keep.length) throw new Error('没有可上传的文件（是不是只选了 data 目录？请把整个实验文件夹拖进来）');

    var payload = { title: document.getElementById('title').value || '在线实验', files: [] };
    var total = 0;
    for (var i = 0; i < c.keep.length; i++) {
      var f = c.keep[i];
      var buf = await f.arrayBuffer();
      total += buf.byteLength;
      payload.files.push({ name: f.relPath || f.name, b64: toB64(new Uint8Array(buf)) });
      if ((i + 1) % 10 === 0 || i === c.keep.length - 1) {
        log('  已读取 ' + (i + 1) + '/' + c.keep.length + '（' + (total / 1048576).toFixed(1) + ' MB）');
      }
    }
    var body = JSON.stringify(payload);
    log('已打包 ' + payload.files.length + ' 个文件（原始 ' + (total / 1048576).toFixed(1) + ' MB，传输 ' + (body.length / 1048576).toFixed(1) + ' MB），开始转换…');
    if (body.length > 300 * 1048576) throw new Error('上传体积过大，请只选择实验真正需要的文件');

    var r = await fetch('/api/convert', { method:'POST', headers:{'Content-Type':'application/json'}, body: body });
    var j = await r.json();
    (j.log || []).forEach(function(l){ log(l.line, l.cls); });
    if (j.ok) {
      log('✅ 完成：' + j.outName + '（' + (j.size/1048576).toFixed(2) + ' MB）', 'ok');
      var a = document.createElement('a'); a.href = j.url; a.download = j.outName; a.textContent = '点这里下载 ' + j.outName;
      document.getElementById('log').appendChild(a);
      log('也可以直接从磁盘取：' + j.outPath, 'ok');
    } else { log('❌ 转换失败，请看上面日志', 'bad'); }
  } catch(e) {
    log('❌ 出错：' + (e && (e.message || e.name) || e), 'bad');
    log('   （把这段错误截图发给开发者即可定位；数据没有被上传到任何地方）', 'warn');
  } finally {
    btn.disabled = false;
  }
};
</script></body></html>`;
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
    return send(res, 200, pageHtml(), 'text/html; charset=utf-8');
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
  if (req.method === 'POST' && req.url === '/api/convert') {
    let body = '', size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); return; }
      body += c;
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (!payload.files || !payload.files.length) return send(res, 400, JSON.stringify({ ok: false, log: [{ line: '❌ 没有收到文件', cls: 'bad' }] }));
        const out = doConvert(payload);
        send(res, out.ok ? 200 : 500, JSON.stringify(out));
      } catch (e) {
        send(res, 500, JSON.stringify({ ok: false, log: [{ line: '❌ ' + e.message, cls: 'bad' }] }));
      }
    });
    return;
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
