#!/usr/bin/env node
/* ============================================================================
 * serve-site —— 本机预览在线工具站点（30 行静态服务器，零依赖）
 * ----------------------------------------------------------------------------
 * 为什么需要：在线工具要用 fetch 读同源素材（psychojs 等），浏览器不允许
 * 从 file:// 直接 fetch —— 所以本机预览也必须走 http。
 * 用法: node src/serve-site.js [--port 7790]
 * ========================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i > 0 ? parseInt(process.argv[i + 1], 10) : 7790;
})();
const ROOT = path.resolve(__dirname, '..', 'site');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch (e) { p = req.url.split('?')[0]; }
  if (p === '/' || p === '') p = '/index.html';
  const abs = path.normalize(path.join(ROOT, p));
  if (!abs.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(abs).pipe(res);
}).listen(PORT, '127.0.0.1', () => {
  console.log('在线工具站点已启动: http://127.0.0.1:' + PORT + '/');
  console.log('站点根目录: ' + ROOT);
  console.log('按 Ctrl+C 停止。');
});
