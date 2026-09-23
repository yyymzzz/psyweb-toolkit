#!/usr/bin/env node
/* ============================================================================
 * js-codeblock-fix —— 改写 PsychoPy 生成的 JS 里"必然报错"的语句
 * ----------------------------------------------------------------------------
 * 为什么必须做这件事（不是洁癖，是真实阻断）：
 *   PsychoPy 的 Python→JS 自动翻译会把 `import random` 翻成
 *       import * as random from 'random';
 *   而这行会被塞进 routine 的函数体里；legacy 版（经典脚本）与单文件便携包
 *   都不允许函数体内出现 import —— **解析阶段就语法错误，整份实验跑不起来**。
 *   紧接着的 `random.random()` 还被翻成 `Math.random.random()`（Math.random 是函数不是对象）。
 *
 * 实测证据：某实验导出目录下的 <实验名>-legacy-browsers.js
 *   第 546 行 `import * as random from 'random';`
 *   第 547 行 `if ((Math.random.random() < 0.5)) {`
 *
 * 处理策略：把 import 就地换成等价的内联实现（保持原作用域位置不变），
 *          并把已知的翻译缺陷改成正确写法；无法等价替换的模块则注释掉并记为待人工处理。
 * ========================================================================== */
'use strict';

/** 已知模块 → 内联等价实现（与 npm 'random' 包常用 API 对齐） */
const SHIMS = {
  random: `const random = {
    random: () => Math.random(),
    randomInt: (a, b) => Math.floor(Math.random() * (b - a + 1)) + a,
    randint: (a, b) => Math.floor(Math.random() * (b - a + 1)) + a,
    choice: (arr) => arr[Math.floor(Math.random() * arr.length)],
    uniform: (a, b) => a + Math.random() * (b - a),
    shuffle: (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; },
    sample: (arr, k) => { const c = arr.slice(); const out = []; for (let i = 0; i < Math.min(k, c.length); i++) { out.push(c.splice(Math.floor(Math.random() * c.length), 1)[0]); } return out; }
  };`
};

/**
 * 修复一段（PsychoPy 生成的）JS 代码。
 * @returns {{code:string, changes:Array<{line:number,kind:string,from:string,to:string}>, todos:string[]}}
 */
function fixJsCode(src) {
  const changes = [];
  const todos = [];
  const lines = String(src).split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const lineNo = i + 1;

    // --- 1. import 语句（函数体内非法 → 就地替换为等价内联实现）---
    const m = line.match(/^(\s*)import\s+(?:\*\s+as\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)|\{([^}]*)\})\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/);
    if (m) {
      const [, indent, nsName, defName, named, mod] = m;
      const local = nsName || defName;
      if (SHIMS[mod] && local) {
        out.push(indent + SHIMS[mod]);
        changes.push({ line: lineNo, kind: 'import→内联实现', from: line.trim(), to: `const ${local} = {…}（${mod} 等价实现，${Object.keys(SHIMS).length} 个已支持模块之一）` });
      } else {
        out.push(indent + `/* psyweb: 原语句 \`${line.trim()}\` 引用了裸模块 '${mod}'，浏览器里无法解析；` +
                 `已注释。若实验确实用到它，请把用到的函数改为内联实现。 */`);
        changes.push({ line: lineNo, kind: 'import→注释', from: line.trim(), to: '(已注释，待人工替换为内联实现)' });
        todos.push(`第 ${lineNo} 行引用了无法解析的模块 '${mod}'${named ? '（具名导入: ' + named + '）' : ''}，需人工提供内联实现`);
      }
      continue;
    }

    // --- 2. 已知自动翻译缺陷：Math.random.random() ---
    if (/Math\.random\.random\s*\(/.test(line)) {
      const fixed = line.replace(/Math\.random\.random\s*\(/g, 'Math.random(');
      changes.push({ line: lineNo, kind: '翻译缺陷修正', from: 'Math.random.random(', to: 'Math.random(' });
      line = fixed;
    }

    // --- 3. 其他常见翻译缺陷（保守，只改语义确定的）---
    if (/Math\.random\.randint\s*\(/.test(line)) {
      const fixed = line.replace(/Math\.random\.randint\s*\(([^)]*)\)/g,
        (mm, args) => `(function(a,b){return Math.floor(Math.random()*(b-a+1))+a;})(${args})`);
      changes.push({ line: lineNo, kind: '翻译缺陷修正', from: 'Math.random.randint(a,b)', to: '内联 randint(a,b)' });
      line = fixed;
    }

    out.push(line);
  }

  return { code: out.join('\n'), changes, todos };
}

// ---------------------------------------------------------------- CLI
function main() {
  const fs = require('fs');
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const outFile = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  if (!file) {
    console.error('用法: node src/js-codeblock-fix.js <generated.js> [--out fixed.js]');
    process.exit(2);
  }
  const src = fs.readFileSync(file, 'utf8');
  const r = fixJsCode(src);

  console.log(`文件: ${file}  (${src.length} B, ${src.split('\n').length} 行)`);
  console.log(`修改: ${r.changes.length} 处`);
  for (const c of r.changes) {
    console.log(`  第 ${c.line} 行 [${c.kind}]`);
    console.log(`     - ${c.from}`);
    console.log(`     + ${c.to}`);
  }
  if (r.todos.length) {
    console.log(`\n⚠️ 待人工处理 ${r.todos.length} 项:`);
    r.todos.forEach((t) => console.log('   - ' + t));
  }

  // 验证：修完不该再有这些模式
  const residue = {
    '函数体内 import': /^\s*import\s/m.test(r.code),
    'Math.random.random(': /Math\.random\.random\s*\(/.test(r.code)
  };
  console.log('\n残留检查: ' + Object.entries(residue).map(([k, v]) => `${k}=${v ? '❌仍有' : '✅已清'}`).join('  '));

  if (outFile) { fs.writeFileSync(outFile, r.code, 'utf8'); console.log('已写出: ' + outFile); }
  process.exit(Object.values(residue).some(Boolean) ? 1 : 0);
}

if (require.main === module) main();
module.exports = { fixJsCode, SHIMS };
