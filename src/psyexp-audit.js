#!/usr/bin/env node
/* ============================================================================
 * psyexp-audit —— .psyexp 解析器 + 上线体检
 * ----------------------------------------------------------------------------
 * 用法：
 *   node src/psyexp-audit.js <file.psyexp|目录> [--json out.json] [--md out.md] [--quiet]
 *
 * 为什么要"体检"而不是直接转换：
 *   官方状态页自己就写着「Not all components are currently supported」。
 *   用户真正的痛点是"我这实验到底能不能上网、要改哪几处"，
 *   而不是"生成了一堆看不懂的 JS 然后跑起来白屏"。
 *
 * 解析上的两个坑（实测踩过，写在这里免得后人再踩）：
 *   1. 根元素名在不同版本不同（PsychoPy2experiment / PsychoPy3experiment），
 *      不能写死，要取第一个符合 ^PsychoPy 的子元素。
 *   2. 代码类参数（valType=code/extendedCode）在 XML 里是**双重转义**的：
 *      文件里存的是 &amp;#10;，解一次得到字面量 &#10;，必须再解一次才是换行。
 *      少解一次，所有基于换行/引号的代码检查都会失准。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const M = require('./support-matrix');

// ---------------------------------------------------------------- XML 解析
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  trimValues: false,
  processEntities: false,               // 自己解，才能精确控制"解几次"
  isArray: (name) =>
    name === 'Param' || name === 'Routine' || name === 'LoopInitiator' ||
    name === 'LoopTerminator' || name.endsWith('Component')
});

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** 解一次实体（含数字实体）。代码参数需要连续调用两次。 */
function decodeOnce(s) {
  if (typeof s !== 'string' || s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : m;
  });
}
function decodeParam(val, valType) {
  const once = decodeOnce(val == null ? '' : String(val));
  return (valType === 'code' || valType === 'extendedCode') ? decodeOnce(once) : once;
}

function parsePsyexp(file) {
  const xml = fs.readFileSync(file, 'utf8');
  const doc = parser.parse(xml);
  const rootKey = Object.keys(doc).find((k) => /^PsychoPy\w*experiment$/.test(k) || /^Experiment$/.test(k));
  if (!rootKey) throw new Error('不是合法的 .psyexp（找不到根元素）: ' + file);
  const root = doc[rootKey];

  const readParams = (node) => {
    const out = {};
    for (const p of node.Param || []) {
      const name = p['@_name'];
      if (name === undefined) continue;
      out[name] = {
        val: p['@_val'],
        valType: p['@_valType'] || 'str',
        updates: p['@_updates'] || 'None',
        decoded: decodeParam(p['@_val'], p['@_valType'])
      };
    }
    return out;
  };

  const settings = root.Settings ? readParams(root.Settings) : {};

  const routines = [];
  for (const r of (root.Routines && root.Routines.Routine) || []) {
    const comps = [];
    for (const key of Object.keys(r)) {
      if (!key.endsWith('Component') && key !== 'RoutineSettingsComponent') continue;
      for (const c of r[key]) {
        comps.push({ type: key, name: c['@_name'] || '(未命名)', params: readParams(c) });
      }
    }
    routines.push({ name: r['@_name'] || '(未命名 Routine)', components: comps });
  }

  const flow = [];
  const loops = [];
  const f = root.Flow || {};
  for (const item of f.Routine || []) flow.push({ kind: 'routine', name: item['@_name'] });
  for (const item of f.LoopInitiator || []) {
    const p = readParams(item);
    const loop = {
      kind: 'loop-start', name: item['@_name'],
      // 循环类型是**元素属性**（loopType="TrialHandler"），
      // 而 Param 里那个同名 loopType 存的是抽样方法（random/sequential）——别搞混。
      loopType: item['@_loopType'] || 'TrialHandler',
      method: p['loopType'] ? p['loopType'].decoded : '',
      nReps: p['nReps'] ? p['nReps'].decoded : '',
      conditionsFile: p['conditionsFile'] ? p['conditionsFile'].decoded.trim() : '',
      params: p
    };
    loops.push(loop);
    flow.push(loop);
  }
  for (const item of f.LoopTerminator || []) flow.push({ kind: 'loop-end', name: item['@_name'] });

  return {
    file, rootKey, version: root['@_version'] || '', encoding: root['@_encoding'] || '',
    settings, routines, flow, loops
  };
}

// ---------------------------------------------------------------- 体检规则
const SEV = { ERROR: 'error', WARN: 'warn', OK: 'ok', INFO: 'info' };
const SEV_MARK = { error: '🔴', warn: '🟡', ok: '🟢', info: 'ℹ️' };

function audit(model) {
  const findings = [];
  const add = (severity, code, where, message, action) =>
    findings.push({ severity, code, where, message, action });

  // --- 1. 组件在线支持度 ---
  const compCount = {};
  for (const r of model.routines) {
    for (const c of r.components) {
      if (c.type === 'RoutineSettingsComponent') continue;
      compCount[c.type] = (compCount[c.type] || 0) + 1;
      const info = M.COMPONENTS[c.type] || M.COMPONENTS.UnknownComponent;
      const where = `${r.name} / ${c.name} (${c.type})`;
      if (info.status === M.NO) {
        add(SEV.ERROR, 'component-unsupported', where,
          `组件在线不支持${info.note ? '：' + info.note : ''}`,
          '删除该组件，或改用等效的网页实现（必要时走 jsPsych 兜底）');
      } else if (info.status === M.PROTOTYPE) {
        add(SEV.WARN, 'component-prototype', where,
          `官方状态为 Prototype${info.note ? '：' + info.note : ''}`,
          '先小样本试跑确认，或准备替代实现');
      }
    }
  }

  // --- 2. Code Component 逐字段体检 ---
  const JS_FIELDS = ['Before JS Experiment', 'Begin JS Experiment', 'Begin JS Routine', 'Each Frame JS', 'End JS Routine', 'End JS Experiment'];
  const PY_FIELDS = ['Before Experiment', 'Begin Experiment', 'Begin Routine', 'Each Frame', 'End Routine', 'End Experiment'];
  const PAIRS = [
    ['Before Experiment', 'Before JS Experiment'],
    ['Begin Experiment', 'Begin JS Experiment'],
    ['Begin Routine', 'Begin JS Routine'],
    ['Each Frame', 'Each Frame JS'],
    ['End Routine', 'End JS Routine'],
    ['End Experiment', 'End JS Experiment']
  ];

  for (const r of model.routines) {
    for (const c of r.components.filter((x) => x.type === 'CodeComponent')) {
      const where = `${r.name} / ${c.name} (Code)`;
      const pyValues = {};
      for (const f of PY_FIELDS) {
        const p = c.params[f];
        if (p && String(p.decoded).trim()) pyValues[f] = String(p.decoded);
      }
      if (Object.keys(pyValues).length === 0) continue;   // 空代码组件

      // 2a. Python 有、JS 空 → 必须人工移植
      const missingJs = [];
      for (const [py, js] of PAIRS) {
        if (pyValues[py] && !(c.params[js] && String(c.params[js].decoded).trim())) {
          missingJs.push(py);
        }
      }
      if (missingJs.length) {
        add(SEV.WARN, 'code-needs-js', where,
          `以下代码块只有 Python 版本、没有 JS 版本：${missingJs.join('、')}`,
          '打开 Builder 的 Code Component，用「Auto→JS」生成 JS 版本后逐行核对语义');
      }

      // 2b. Python 专属 API
      for (const [field, code] of Object.entries(pyValues)) {
        for (const pat of M.PYTHON_ONLY_PATTERNS) {
          if (pat.re.test(code)) {
            add(SEV.ERROR, 'code-python-only', `${where} · ${field}`,
              `用到 Python 专属能力：${pat.why}`,
              '该逻辑无法搬上浏览器，需重写或改用网页等价方案');
          }
        }
      }

      // 2c. JS 代码块的危险特征
      for (const field of JS_FIELDS) {
        const p = c.params[field];
        if (!p || !String(p.decoded).trim()) continue;
        const js = String(p.decoded);
        const hits = M.JS_RED_FLAGS.filter((fl) => fl.re.test(js));
        // 同一条 `import x from 'y'` 会同时命中 es-import 与 bare-module，
        // 属同根因，只报更严重的那个，避免报告噪音。
        const shown = hits.filter((h) => !(h.id === 'bare-module' && hits.some((x) => x.id === 'es-import')));
        for (const flag of shown) {
          add(flag.level === 'error' ? SEV.ERROR : flag.level === 'warn' ? SEV.WARN : SEV.INFO,
            'code-js-flag', `${where} · ${field}`, flag.why,
            flag.level === 'error' ? '打包器需改写该语句，否则运行即报错' : '转换时注意核对');
        }
      }
    }
  }

  // --- 3. 条件文件格式 ---
  for (const loop of model.loops) {
    const cf = loop.conditionsFile;
    if (!cf) continue;
    const where = `循环 ${loop.name}`;
    // 动态表达式（$变量 / .format() / 花括号插值）：无法在解析期确定文件名，
    // 但若字面量里出现 .xlsx，那仍然是"在线不支持 XLSX"这个硬阻断。
    if (/^\$|\.format\s*\(|\{/.test(cf)) {
      const mentionsXlsx = /\.xlsx?\b/i.test(cf);
      add(mentionsXlsx ? SEV.ERROR : SEV.WARN, 'cond-dynamic', where,
        `条件文件由表达式动态决定：${cf}` + (mentionsXlsx ? '（字面量中出现 .xlsx —— 在线不支持 XLSX）' : ''),
        mentionsXlsx ? '转换为 CSV 并改写该表达式；或改写为显式文件名' : '转换器需在构建期解析该表达式，或提示改为显式文件名');
      continue;
    }
    const ext = path.extname(cf).toLowerCase();
    const info = M.CONDITION_FILE[ext];
    if (!info) {
      add(SEV.WARN, 'cond-unknown-ext', where, `未知条件文件类型：${cf}`, '请确认能否转为 CSV');
    } else if (!info.ok) {
      add(SEV.ERROR, 'cond-xlsx', where, `条件文件 ${cf}：${info.note}`, '转换时自动转成 CSV 并改写引用');
    } else if (info.note) {
      add(SEV.INFO, 'cond-note', where, `条件文件 ${cf}：${info.note}`, '');
    }
  }

  // --- 3b. 数据输出格式（官方"XLSX not supported"真正适用的地方）---
  // 只作提示，不计入"能不能上线"：这类设置在线会被静默忽略，不影响实验跑不跑得起来。
  // （第一版把它报成 warn，结果 26/26 全中 —— 规则喊狼来了就等于没有规则。）
  for (const [param, info] of Object.entries(M.DATA_OUTPUT)) {
    const v = model.settings[param];
    if (!v) continue;
    if (/^True$/i.test(String(v.decoded)) && !info.ok) {
      add(SEV.INFO, 'output-note', `实验设置 / ${param}`,
        `${info.note}（在线会被忽略，不影响能否上线）`, '');
    }
  }

  // --- 4. 循环类型 ---
  for (const loop of model.loops) {
    const info = M.LOOPS[loop.loopType] || M.LOOPS.UnknownLoop;
    if (info.status !== M.OK) {
      add(SEV.WARN, 'loop-prototype', `循环 ${loop.name}`,
        `循环类型 ${loop.loopType}：${info.note || '官方原型支持'}`, '小样本试跑确认');
    }
  }

  // --- 5. 资源引用与存在性 ---
  const dir = path.dirname(model.file);
  const resources = new Map();   // 引用名 → 引用处
  const RES_PARAMS = {
    ImageComponent: ['image'], MovieComponent: ['movie'], SoundComponent: ['sound'],
    TextboxComponent: ['font'], BrushComponent: []
  };
  for (const r of model.routines) {
    for (const c of r.components) {
      const keys = RES_PARAMS[c.type] || [];
      for (const k of keys) {
        const p = c.params[k];
        const v = p && String(p.decoded).trim();
        if (!v || /^[\[(]/.test(v) || /\$|\.format\(|\{|thisTrial|\.val\b/.test(v)) continue;  // 动态引用跳过
        resources.set(v.replace(/^['"]|['"]$/g, ''), `${r.name} / ${c.name}`);
      }
    }
  }
  for (const [file, where] of resources) {
    const abs = path.join(dir, file);
    if (!fs.existsSync(abs)) {
      add(SEV.ERROR, 'resource-missing', where, `引用资源不存在：${file}`, '补齐资源或修正路径（转换时会打包进便携包）');
    }
  }
  const declared = (model.settings['Resources'] && model.settings['Resources'].decoded) || '[]';
  if (resources.size > 0 && /\[\s*\]/.test(declared)) {
    add(SEV.WARN, 'resources-not-declared', '实验设置 / Resources',
      `实验设置里的 Resources 为空，但组件引用了 ${resources.size} 个资源文件`,
      '转换器会自动收集资源；如需精确控制，请在 Builder 的 Online 页显式登记');
  }

  // --- 6. 实验级设置 ---
  const s = (k) => (model.settings[k] ? String(model.settings[k].decoded) : '');
  if (/^True$/i.test(s('Full-screen window'))) {
    add(SEV.WARN, 'set-fullscreen', '实验设置 / Full-screen window',
      '要求全屏：浏览器只在"用户手势"后才允许 requestFullscreen，双击打开本地 html 时没有任何手势',
      '便携包需先显示「▶ 点击开始」页，由点击触发全屏（同时可作为知情同意落点）');
  }
  if (/^True$/i.test(s('Show info dlg'))) {
    add(SEV.WARN, 'set-info-dialog', '实验设置 / Show info dlg',
      '会弹出被试信息对话框：在线环境下它同时承担"等资源下载完成"的阻塞职责',
      '便携包用自己的被试入口页替换它，并显式等待资源就绪（psyweb 已实现该门禁）');
  }
  if (s('eyetracker') && !/^None$/i.test(s('eyetracker'))) {
    add(SEV.ERROR, 'set-eyetracker', '实验设置 / eyetracker', `启用了眼动：${s('eyetracker')}`, '在线不可用');
  }
  if (/^False$/i.test(s('Save wide csv file')) && /^False$/i.test(s('Save csv file'))) {
    add(SEV.INFO, 'set-no-csv', '实验设置 / 数据输出', '实验设置里关闭了 CSV 输出（便携包的数据出口由 psyweb 独立实现，不受影响）', '');
  }

  // --- 7. 汇总 ---
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) if (counts[f.severity] !== undefined) counts[f.severity]++;
  const compTotal = Object.values(compCount).reduce((a, b) => a + b, 0);
  const runs = compTotal === 0 ? 0
    : Math.max(0, 100 - counts.error * 25 - counts.warn * 8 - counts.info * 1);

  return {
    file: model.file, version: model.version,
    routineCount: model.routines.length, loopCount: model.loops.length,
    componentCount: compTotal, componentTypes: compCount,
    findings, counts,
    verdict: counts.error ? 'blocked' : counts.warn ? 'needs-work' : 'ready',
    readinessScore: runs
  };
}

// ---------------------------------------------------------------- 报告渲染
function renderMarkdown(rep) {
  const L = [];
  const verdictText = { blocked: '🔴 不能直接上线（有阻断项）', 'needs-work': '🟡 需改造后可上线', ready: '🟢 可直上' };
  L.push(`# 上线体检单 · ${path.basename(rep.file)}`, '');
  L.push(`- 实验文件：\`${rep.file}\``);
  L.push(`- 保存版本：${rep.version || '(未标注)'}`);
  L.push(`- 结构：${rep.routineCount} 个 Routine · ${rep.loopCount} 个循环 · ${rep.componentCount} 个组件`);
  L.push(`- 结论：**${verdictText[rep.verdict]}**　（🔴 ${rep.counts.error} · 🟡 ${rep.counts.warn} · ℹ️ ${rep.counts.info}）`);
  L.push('', '## 组件清单', '');
  L.push('| 组件 | 数量 | 在线状态 |', '|---|---|---|');
  for (const [t, n] of Object.entries(rep.componentTypes).sort((a, b) => b[1] - a[1])) {
    const info = M.COMPONENTS[t] || M.COMPONENTS.UnknownComponent;
    const label = info.status === M.OK ? '🟢 支持' : info.status === M.PROTOTYPE ? '🟡 原型/需改造' : '🔴 不支持';
    L.push(`| ${t} | ${n} | ${label} |`);
  }
  L.push('', '## 体检发现', '');
  if (!rep.findings.length) L.push('（无）');
  const order = { error: 0, warn: 1, info: 2 };
  for (const f of rep.findings.slice().sort((a, b) => order[a.severity] - order[b.severity])) {
    L.push(`### ${SEV_MARK[f.severity]} ${f.message}`);
    L.push(`- 位置：\`${f.where}\``);
    L.push(`- 规则：\`${f.code}\``);
    if (f.action) L.push(`- 建议：${f.action}`);
    L.push('');
  }
  L.push('---', '');
  L.push('由 `psyexp-audit` 生成（规则来源：psychopy.org/online/status.html，2026-09-23 抓取）');
  return L.join('\n');
}

function renderConsole(rep) {
  const mark = { error: '🔴', warn: '🟡', info: 'ℹ️' };
  const verdict = { blocked: '🔴 不能直接上线', 'needs-work': '🟡 需改造后可上线', ready: '🟢 可直上' };
  console.log(`\n=== ${path.basename(rep.file)} ===`);
  console.log(`结构: ${rep.routineCount} Routine / ${rep.loopCount} Loop / ${rep.componentCount} 组件   版本: ${rep.version || '?'}`);
  console.log(`结论: ${verdict[rep.verdict]}   🔴${rep.counts.error} 🟡${rep.counts.warn} ℹ️${rep.counts.info}`);
  for (const f of rep.findings) {
    console.log(`  ${mark[f.severity]} [${f.code}] ${f.where}\n      ${f.message}${f.action ? '\n      → ' + f.action : ''}`);
  }
  return rep;
}

// ---------------------------------------------------------------- CLI
function walkPsyexp(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return [p];
  const out = [];
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) out.push(...walkPsyexp(full));
    else if (e.name.toLowerCase().endsWith('.psyexp')) out.push(full);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  if (!target) {
    console.error('用法: node src/psyexp-audit.js <file.psyexp|目录> [--json out.json] [--md out.md] [--quiet]');
    process.exit(2);
  }
  const files = walkPsyexp(target);
  if (!files.length) { console.error('没找到 .psyexp'); process.exit(2); }
  const quiet = args.includes('--quiet');

  const reports = [];
  for (const f of files) {
    try {
      const model = parsePsyexp(f);
      const rep = audit(model);
      reports.push(rep);
      if (!quiet) renderConsole(rep);
    } catch (e) {
      console.error(`🔴 解析失败 ${f}: ${e.message}`);
      reports.push({ file: f, parseError: e.message, findings: [], counts: { error: 1, warn: 0, info: 0 }, verdict: 'blocked' });
    }
  }

  // 批量汇总
  if (files.length > 1) {
    const tally = { ready: 0, 'needs-work': 0, blocked: 0 };
    const byCode = {};
    for (const r of reports) {
      tally[r.verdict] = (tally[r.verdict] || 0) + 1;
      for (const f of r.findings || []) byCode[f.code] = (byCode[f.code] || 0) + 1;
    }
    console.log(`\n===== 批量汇总（${reports.length} 个实验）=====`);
    console.log(`  🟢 可直上 ${tally.ready}   🟡 需改造 ${tally['needs-work']}   🔴 阻断 ${tally.blocked}`);
    console.log('  问题分布:');
    for (const [code, n] of Object.entries(byCode).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(3)} × ${code}`);
    }
  }

  const jsonOut = opt('--json');
  if (jsonOut) { fs.writeFileSync(jsonOut, JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2), 'utf8'); console.log('\nJSON: ' + jsonOut); }
  const mdOut = opt('--md');
  if (mdOut && reports.length === 1) { fs.writeFileSync(mdOut, renderMarkdown(reports[0]), 'utf8'); console.log('报告: ' + mdOut); }
  else if (mdOut) { fs.writeFileSync(mdOut, reports.map(renderMarkdown).join('\n\n---\n\n'), 'utf8'); console.log('报告: ' + mdOut); }

  const blocked = reports.filter((r) => r.verdict === 'blocked').length;
  process.exit(blocked ? 1 : 0);
}

if (require.main === module) main();
module.exports = { parsePsyexp, audit, renderMarkdown };
