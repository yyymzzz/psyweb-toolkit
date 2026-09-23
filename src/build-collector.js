#!/usr/bin/env node
/* ============================================================================
 * build-collector —— 生成主试端回收器（单文件、离线可用）
 * ----------------------------------------------------------------------------
 * 产物: tools/collector.html —— 主试双击即用：把被试发来的二维码截图拖进去，
 *       自动解码 → 分组 → 还原 CSV → 累积多名被试 → 一键导出合并表。
 * 为什么也做成单文件：主试端同样不该依赖服务器；而且它要能跟着数据一起归档。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'collector.html');

function read(p, what) {
  if (!fs.existsSync(p)) { console.error(`\n[构建失败] 缺少 ${what}: ${p}\n`); process.exit(1); }
  return fs.readFileSync(p, 'utf8');
}

const jsqr = read(path.join(ROOT, 'node_modules', 'jsqr', 'dist', 'jsQR.js'), 'jsQR 浏览器构建（npm i jsqr）');
const pako = read(path.join(ROOT, 'spike', 'm0', 'vendor', 'pako.min.js'), 'pako（scripts/fetch-vendor.ps1）');
const core = read(path.join(ROOT, 'src', 'collector-core.js'), 'collector-core.js');
const page = read(path.join(ROOT, 'src', 'collector-page.js'), 'collector-page.js');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>psyweb 数据回收器 · 主试端</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--line:#e3e6ea;--ink:#1a1a1a;--muted:#6b7280;--ok:#0f8a4a;--warn:#b45309;--bad:#c0392b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--muted);margin-bottom:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:16px}
#drop{border:2px dashed #c3c9d2;border-radius:10px;padding:28px;text-align:center;color:var(--muted);cursor:pointer;transition:.15s}
#drop.hot{border-color:#2f6fed;background:#eef4ff;color:#2f6fed}
button{font:inherit;padding:8px 16px;border:0;border-radius:8px;background:#2f6fed;color:#fff;cursor:pointer;margin-right:8px}
button.ghost{background:#e8eaee;color:#333}
#log{max-height:190px;overflow:auto;background:#fbfbfc;border:1px solid var(--line);border-radius:8px;padding:10px;font:12px/1.7 ui-monospace,Consolas,monospace;margin-top:12px}
.log.ok{color:var(--ok)} .log.warn{color:var(--warn)} .log.bad{color:var(--bad)}
.group{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px dashed var(--line)}
.badge{font-size:12px;padding:1px 8px;border-radius:99px;color:#fff}
.badge.ok{background:var(--ok)} .badge.warn{background:var(--warn)}
.badge.ok+.group,.group .badge.warn{}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);font-size:13px}
th{color:var(--muted);font-weight:600}
.muted{color:var(--muted)}
a{color:#2f6fed;text-decoration:none} a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="wrap">
  <h1>psyweb 数据回收器</h1>
  <div class="sub">把被试发来的<b>二维码截图</b>拖进来（或直接 Ctrl+V 粘贴），自动还原成结构化 CSV。全程本地运行，不联网、不上传。</div>

  <div class="card">
    <div id="drop">把二维码截图拖到这里　·　或点击选择文件　·　或直接 Ctrl+V 粘贴</div>
    <input id="file" type="file" accept="image/*" multiple style="display:none">
    <div style="margin-top:12px">
      提示：微信里请让被试勾选「<b>原图</b>」再发；一次可以把多张、多人的截图一起拖进来。
    </div>
    <div id="log"></div>
  </div>

  <div class="card">
    <div style="font-weight:700;margin-bottom:8px">分片识别</div>
    <div id="groups"><div class="muted">还没有任何分片。</div></div>
  </div>

  <div class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div style="font-weight:700">已回收数据 <span id="count" class="muted"></span></div>
      <div><button id="merge">导出合并 CSV</button><button id="clear" class="ghost">清空</button></div>
    </div>
    <table><thead><tr><th>被试</th><th>行数</th><th>列数</th><th>入库时间</th><th>操作</th></tr></thead>
    <tbody id="tbody"></tbody></table>
  </div>

  <div class="sub">psyweb · 单文件离线工具 · 数据只在本机内存与浏览器本地存储里</div>
</div>

<script>${jsqr}</script>
<script>${pako}</script>
<script>${core}</script>
<script>${page}</script>
</body>
</html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log('✅ 回收器已生成');
console.log('  输出: ' + path.relative(ROOT, OUT));
console.log('  大小: ' + kb(fs.statSync(OUT).size));
console.log('  内联: jsQR ' + kb(jsqr.length) + ' + pako ' + kb(pako.length) + ' + collector-core + 界面');
