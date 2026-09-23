#!/usr/bin/env node
/* ============================================================================
 * build-portable —— 一条命令：.psyexp → 单文件便携实验包
 * ----------------------------------------------------------------------------
 * 流水线：
 *   ① 官方 headless 编译器（PsychoPy 自带 python 里的 psychopy.scripts.psyexpCompile）
 *        xxx.psyexp → index.html + xxx.js + xxx-legacy-browsers.js
 *   ② psyweb 打包器（pack-portable.js）
 *        修自动翻译缺陷 → 内联运行时与资源 → 装开始页/资源门禁/数据出口 → 出单文件
 *
 * 为什么用官方编译器而不是自己写：官方 codegen 覆盖了全部组件的语义，
 * 自己重写等于把 PsychoPy 五年积累重做一遍（这是方案 v2 里"内核路线 C"的落地）。
 *
 * 关键发现（省掉了一次几百 MB 的安装）：
 *   PsychoPy 的 Windows standalone 安装包**自带 Python 与 psychopy 包**
 *   （实测 PsychoPy 官方 standalone 自带解释器 = Python 3.10.11 + psychopy 2026.2.3），
 *   所以只要用户装过 PsychoPy（能画实验、能导出 HTML 的人必然装过），
 *   就能直接调用官方编译器，零额外安装。
 *
 * 用法:
 *   node src/build-portable.js --psyexp <文件.psyexp> --out <产物.html>
 *        [--title "实验名称"] [--expname name] [--python <psychopy python>] [--autotest]
 * ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const has = (n) => process.argv.includes('--' + n);

const PSYEXP = arg('psyexp');
const OUT = arg('out');
const TITLE = arg('title', '在线实验');
const EXPNAME = arg('expname', PSYEXP ? path.basename(PSYEXP, path.extname(PSYEXP)) : 'experiment');
const AUTOTEST = has('autotest');
if (!PSYEXP || !OUT) {
  console.error('用法: node src/build-portable.js --psyexp <文件.psyexp> --out <产物.html> [--title …] [--autotest]');
  process.exit(2);
}
if (!fs.existsSync(PSYEXP)) { console.error('[失败] 找不到 ' + PSYEXP); process.exit(1); }

/** 找一个装了 psychopy 的 python：显式参数 > 环境变量 > 常见安装位置 */
function findPsychoPyPython() {
  const explicit = arg('python', process.env.PSYWEB_PSYCHOPY_PYTHON);
  const cands = [];
  if (explicit) cands.push(explicit);
  // PsychoPy standalone 的默认位置 + 用户实际用的位置
  for (const drive of ['C', 'D', 'E', 'F']) {
    cands.push(drive + ':\\PsychoPy\\python.exe');
    cands.push(drive + ':\\Program Files\\PsychoPy\\python.exe');
    cands.push(drive + ':\\Program Files (x86)\\PsychoPy\\python.exe');
  }
  for (const c of cands) {
    if (!c || !fs.existsSync(c)) continue;
    const r = spawnSync(c, ['-c', 'import psychopy,sys;sys.stdout.write(psychopy.__version__)'],
      { encoding: 'utf8', timeout: 120000 });
    if (r.status === 0 && (r.stdout || '').trim()) return { python: c, version: r.stdout.trim() };
  }
  return null;
}

const py = findPsychoPyPython();
if (!py) {
  console.error('\n[失败] 找不到装了 PsychoPy 的 Python。\n' +
    '  · 如果你装过 PsychoPy（standalone 安装包），它自带 python，通常在 <盘符>:\\PsychoPy\\python.exe\n' +
    '  · 也可以用 --python <路径> 或环境变量 PSYWEB_PSYCHOPY_PYTHON 指定\n');
  process.exit(1);
}
console.log('① 官方编译器');
console.log('   python : ' + py.python);
console.log('   psychopy: ' + py.version);

// 在临时目录里编译，绝不写用户的实验目录
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'psyweb-compile-'));
const expDir = path.dirname(path.resolve(PSYEXP));
const tmpPsyexp = path.join(work, path.basename(PSYEXP));
fs.copyFileSync(PSYEXP, tmpPsyexp);
const outJs = path.join(work, EXPNAME + '.js');
const legacyJs = path.join(work, EXPNAME + '-legacy-browsers.js');

const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });
const t0 = Date.now();
const r = spawnSync(py.python, ['-m', 'psychopy.scripts.psyexpCompile', tmpPsyexp, '-o', outJs],
  { encoding: 'utf8', timeout: 600000, env });
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const output = ((r.stdout || '') + (r.stderr || '')).trim();

// PsychoPy 自带的 JS 语法检查告警要如实转达（它检查出的正是 psyweb 修复器要处理的问题）
const alerts = output.split('\n').filter((l) => /Alert \d+|Error parsing JS|Unexpected token/.test(l));

if (!fs.existsSync(legacyJs)) {
  console.error('\n[失败] 编译器没有产出 ' + legacyJs);
  console.error(output.split('\n').slice(-12).join('\n'));
  process.exit(1);
}
console.log('   耗时 ' + secs + 's → ' + [path.basename(outJs), path.basename(legacyJs), 'index.html']
  .filter((f) => fs.existsSync(path.join(work, f))).join(', '));
if (alerts.length) {
  console.log('\n   ⚠️ 官方检查器报出 ' + alerts.length + ' 条告警（psyweb 的修复器会处理其中可自动修的）：');
  alerts.slice(0, 4).forEach((a) => console.log('     ' + a.slice(0, 150)));
}

// ---- 交给打包器 ----
console.log('\n② psyweb 打包器');
const packArgs = [path.join(__dirname, 'pack-portable.js'),
  '--dir', expDir, '--js', legacyJs, '--out', OUT, '--psyexp', path.resolve(PSYEXP),
  '--title', TITLE, '--expname', EXPNAME];
if (AUTOTEST) packArgs.push('--autotest');
const p = spawnSync(process.execPath, packArgs, { stdio: 'inherit' });
const code = p.status === null ? 1 : p.status;

// 清理临时目录（产物已写到 OUT）
try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {}
process.exit(code);
