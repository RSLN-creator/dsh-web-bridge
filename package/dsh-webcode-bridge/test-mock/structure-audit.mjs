// structure-audit.mjs — 结构审计：依赖图（扇入/扇出/环）+ 超长函数启发式 + 安全面扫描。
//
// ## 为什么入库（而非 .tmp）
//
// `doc/CODE-STRUCTURE.md` §三引用了本脚本的读数（扇出 Top / 无环 / god-function 行数）。
// 按 `wiki/protocol.md` §5，入库文档**不得引用**「外面没有它就理解不了」的 gitignore 路径，
// 因此本脚本与 `test-mock/` 其余探针一样入库，README 口径下它只读、不改任何文件。
//
// ## 判据边界（如实）
//
//   · 依赖图是**静态 import 相对路径**解析：只覆盖 `./x` / `../x` 的 ESM import，
//     不覆盖 `import('node:...')` 动态导入、也不覆盖 `client.cjs`（CJS 不用 import）。
//   · 超长函数边界是**启发式**（以声明行缩进为界），会把嵌套 method 也计入宿主函数，
//     因此行数**偏保守（偏大）**——它回答「哪些函数大到该想拆」，不是精确 SLOC。
//   · 安全面扫描是**模式命中**，`exec` 会误报正则 `.exec()`；结论以人读代码为准，
//     本脚本只做「把候选聚到一处」。
//
// 用法：`node test-mock/structure-audit.mjs`（只读，无 spawnSync）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const libDir = path.join(pkgRoot, 'lib');
const files = fs.readdirSync(libDir).filter((f) => f.endsWith('.js'));

// ---- 依赖图 ----------------------------------------------------------------

function parseImports(text) {
  const out = new Set();
  const re = /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    let target = path.resolve(libDir, spec);
    if (!fs.existsSync(target)) {
      if (fs.existsSync(target + '.js')) target += '.js';
      else if (fs.existsSync(path.join(target, 'index.js'))) target = path.join(target, 'index.js');
      else continue;
    }
    if (path.extname(target) !== '.js') continue;
    const rel = path.relative(libDir, target);
    if (rel.startsWith('..')) continue;
    out.add(rel.replace(/\.js$/, '').replace(/[\\/]/g, '/'));
  }
  return out;
}

const deps = new Map();
for (const f of files) {
  const text = fs.readFileSync(path.join(libDir, f), 'utf8');
  deps.set(f.replace(/\.js$/, ''), parseImports(text));
}

const fanOut = new Map();
const fanIn = new Map();
for (const mod of deps.keys()) { fanOut.set(mod, deps.get(mod).size); fanIn.set(mod, 0); }
for (const [, ds] of deps) for (const d of ds) if (fanIn.has(d)) fanIn.set(d, fanIn.get(d) + 1);

console.log('=== 扇出 Top 10（依赖最多 = 装配面最广）===');
[...fanOut.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  .forEach(([m, n]) => console.log(`${String(n).padStart(2)}  ${m}`));
console.log('\n=== 扇入 Top 10（被依赖最多 = 改动风险最高）===');
[...fanIn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  .forEach(([m, n]) => console.log(`${String(n).padStart(2)}  ${m}`));
console.log('\n=== 零依赖叶模块 ===');
[...fanOut.entries()].filter(([, n]) => n === 0).sort((a, b) => a[0].localeCompare(b[0]))
  .forEach(([m]) => console.log(`  ${m}`));

console.log('\n=== 循环依赖 ===');
const visited = new Set(); const inStack = new Set(); const stack = []; const cycles = new Set();
function dfs(node) {
  visited.add(node); inStack.add(node); stack.push(node);
  for (const dep of deps.get(node) || []) {
    if (!deps.has(dep)) continue;
    if (!visited.has(dep)) dfs(dep);
    else if (inStack.has(dep)) cycles.add([...stack.slice(stack.indexOf(dep)), dep].sort().join(' -> '));
  }
  stack.pop(); inStack.delete(node);
}
for (const mod of deps.keys()) if (!visited.has(mod)) dfs(mod);
if (cycles.size === 0) console.log('  （无）');
else for (const c of cycles) console.log('  ' + c);

// ---- 超长函数（启发式，>80 行）--------------------------------------------

function collectDeclarations(text) {
  const lines = text.split('\n');
  const re = /^(\s*)(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function)|(\w+)\s*\([^)]*\)\s*\{)/;
  const decls = [];
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) decls.push({ name: m[2] || m[3] || m[4], indent: m[1].length, line: i + 1 });
  }
  return { lines, decls };
}

console.log('\n=== 超长函数 Top 15（>80 行，重构候选；行数偏保守）===');
const longFns = [];
for (const f of files) {
  const text = fs.readFileSync(path.join(libDir, f), 'utf8');
  const { lines, decls } = collectDeclarations(text);
  for (let d = 0; d < decls.length; d++) {
    const cur = decls[d];
    let end = lines.length;
    for (let e = d + 1; e < decls.length; e++) if (decls[e].indent <= cur.indent) { end = decls[e].line - 1; break; }
    const len = end - cur.line + 1;
    if (len > 80) longFns.push({ f, name: cur.name, line: cur.line, len });
  }
}
longFns.sort((a, b) => b.len - a.len).slice(0, 15)
  .forEach(({ f, name, line, len }) => console.log(`${String(len).padStart(4)} 行  ${f}:${line}  ${name}`));

// ---- 安全面（模式命中，结论以人读为准）-------------------------------------

console.log('\n=== 安全面扫描（eval / Function / spawn / innerHTML；`exec` 含正则误报）===');
const SEC = [
  [/\beval\s*\(/, 'eval()'],
  [/new\s+Function\s*\(/, 'new Function()'],
  [/child_process/, 'child_process'],
  [/\bspawn(Sync)?\s*\(/, 'spawn'],
  [/\bexecFile\s*\(/, 'execFile'],
  [/\.innerHTML\s*[=+]/, 'innerHTML 赋值'],
  [/insertAdjacentHTML/, 'insertAdjacentHTML'],
  [/document\.write\s*\(/, 'document.write'],
];
for (const f of files) {
  const text = fs.readFileSync(path.join(libDir, f), 'utf8');
  const lines = text.split('\n');
  const hits = [];
  for (const [re, label] of SEC) for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hits.push(`${label} @${i + 1}`);
  if (hits.length) console.log(`${f}: ${hits.join(', ')}`);
}
