#!/usr/bin/env node
/* ============================================================================
 * verify-vendor-refs —— 第三方库路径接线守卫
 * ----------------------------------------------------------------------------
 * 为什么需要（真实事故）：
 *   提交 55992e7「vendor 目录收敛」把第三方库从 spike/m0/vendor/ 搬到仓库根
 *   vendor/，docs/项目收尾.md 也记为"✅ 收敛，校验 ok=23"——但 4 处代码里的
 *   路径没跟着改（src/pack-portable.js ×2、src/build-collector.js、本目录测试）。
 *   症状：本地工具一切到"内联素材"就 [打包失败] 缺少第三方库 jquery-3.6.0.min.js。
 *   node --check 抓不到，单测也不覆盖 —— 因为它是"路径接线"而不是"逻辑"。
 *
 * 本守卫做三件事：
 *   ① 全仓库搜"已废弃的 vendor 目录写法"，命中即失败（陈旧路径不许复活）
 *   ② 断言仓库根 vendor/ 存在，且 scripts/fetch-vendor.ps1 所需的关键文件齐全
 *   ③ 断言 vendor.lock.json 里每条 path 都真实存在（防止 lock 与磁盘漂移）
 *
 * 用法: node src/verify-vendor-refs.js        （退出码 0=通过，1=失败）
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '输出', 'build', 'out', 'vendor', 'assets']);
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.ps1', '.py', '.json', '.html', '.md']);

// ① 已废弃写法（正则，容忍各种引号/逗号/反斜杠写法）
const STALE = [
  { re: /spike[\/\\'",\s]*m0[\/\\'",\s]*vendor/i, what: "spike/m0/vendor（已搬到仓库根 vendor/）" }
];

// ② 关键文件：pack-portable / build-collector 真正读的那些
const REQUIRED = [
  'psychojs-2026.2.3.iife.js', 'psychojs-2026.2.3.css',
  'jquery-3.6.0.min.js', 'jquery-ui-1.12.1.min.js', 'jquery-ui-1.12.1.min.css',
  'preloadjs-1.0.1.min.js', 'pako.min.js', 'xlsx.full.min.js'
];

let fail = 0, warn = 0;
const bad = (s) => { console.log('  ❌ ' + s); fail++; };
const ok = (s) => console.log('  ✅ ' + s);
const wn = (s) => { console.log('  ⚠️  ' + s); warn++; };

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (SCAN_EXT.has(path.extname(e.name).toLowerCase())) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

console.log('=== vendor 路径接线守卫 ===');
console.log('仓库根: ' + ROOT + '\n');

console.log('[①] 陈旧写法扫描（' + STALE[0].what + '）');
// 跳过自己：本文件里必然含这个模式（它是检测规则本身）。
// 不要用"路径字符串"去判断——那会把自己也算进去。
const SELF = path.resolve(__filename);
const files = walk(ROOT, []).filter((f) => path.resolve(f) !== SELF);
let staleHits = 0;
for (const f of files) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
  const ext = path.extname(f).toLowerCase();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // 显式豁免：守卫脚本自己需要一个"断言旧布局已不存在"的检查，它**必须**写出旧路径。
    // 用行内标记而不是"跳过 verify-*.js"，是为了让豁免可审计、且不会连带放过真正的陈旧引用。
    if (lines[i].indexOf('verify-vendor-refs:allow') >= 0) continue;
    for (const s of STALE) {
      if (!s.re.test(lines[i])) continue;
      const trimmed = lines[i].trim();
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      // 文档是散文，提到历史路径属正常（只提示）；代码/配置里出现才算接线错误。
      if (ext === '.md' || ext === '.txt') { wn(rel + ':' + (i + 1) + ' 文档提到旧路径（无害）'); continue; }
      if (/^(\/\/|\*|#|<!--)/.test(trimmed)) { wn(rel + ':' + (i + 1) + ' 注释提到旧路径（无害）'); continue; }
      bad(rel + ':' + (i + 1) + ' 代码里仍指向 ' + s.what + ' → ' + trimmed.slice(0, 110)); staleHits++;
    }
  }
}
if (!staleHits) ok('没有任何代码指向 ' + STALE[0].what);

console.log('\n[②] 仓库根 vendor/ 关键文件');
const VENDOR = path.join(ROOT, 'vendor');
if (!fs.existsSync(VENDOR)) bad('目录不存在: ' + VENDOR + '（先跑 scripts/fetch-vendor.ps1）');
else {
  for (const n of REQUIRED) {
    const p = path.join(VENDOR, n);
    if (fs.existsSync(p)) ok(n.padEnd(28) + (fs.statSync(p).size / 1024).toFixed(0) + ' KB');
    else bad('缺少 ' + n + '（先跑 scripts/fetch-vendor.ps1）');
  }
}

console.log('\n[③] vendor.lock.json ↔ 磁盘一致性');
const lockPath = path.join(ROOT, 'vendor.lock.json');
if (!fs.existsSync(lockPath)) wn('没有 vendor.lock.json，跳过');
else {
  let lock;
  try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (e) { bad('vendor.lock.json 解析失败: ' + e.message); }
  if (lock) {
    let miss = 0;
    for (const k of Object.keys(lock.entries || {})) {
      const rel = lock.entries[k].path;
      if (!fs.existsSync(path.join(ROOT, rel))) { bad('lock 里的 ' + k + ' → ' + rel + ' 不存在'); miss++; }
    }
    if (!miss) ok('lock 中 ' + Object.keys(lock.entries || {}).length + ' 条路径全部存在');
  }
}

console.log('\n=== 结论 ===');
if (fail) { console.log('❌ 发现 ' + fail + ' 个问题' + (warn ? '（另有 ' + warn + ' 条提示）' : '')); process.exit(1); }
console.log('✅ vendor 路径接线完好' + (warn ? '（' + warn + ' 条无害提示）' : ''));
