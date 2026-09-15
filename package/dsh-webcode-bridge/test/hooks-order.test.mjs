// hooks-order.test.mjs — 组件里的 **hooks 顺序/数量** 护栏。
//
// ## 为什么需要它（真机缺陷：设置页「网页桥接」整块空白）
//
// 0.15.3 真机：设置页里本插件那一整栏是空白。根因不是取数、不是接线，而是
// `lib/client.cjs` 的 `SiteAccounts` 里一个 `useState` 写在了**提前 return 之后**。
//
// 那个组件体的形状是：先连续 4 个 hook（busySite / results / winSites 三个 useState
// 加一个 useEffect），紧接着一句「站点表为空就提前返回加载中」的守卫，**守卫之后**
// 又写了第 5 个 useState（`picked`）。
//
// 于是首屏 `sites` 未到达时只执行 4 个 hook 就返回；`sites` 到达后同一次挂载会走到
// 第 5 个 hook。真实 React 对「本次渲染比上次多 hook」是硬错误，错误冒泡到
// `settings.section` 的 SlotErrorBoundary，整块栏目被替换成空占位 —— 用户看到的
// 就是「一片空白」。0.14.7 里还没有 picked，所以旧版没有这个跳变。
//
// ## 为什么原来的护栏全绿却漏掉
//
// `client-render.test.mjs` 的 useState 桩是**按名字取值**的映射（键为组件身份加序号），
// 结构上就无法察觉顺序/数量违规；而且它在切换 payload 时会**清空** states，于是
// 「同一次挂载内 hook 数量从 4 跳到 5」这个跳变从来没有被复现过。护栏的建模失真，
// 把整类 bug 盖住了。
//
// ## 本测试怎么建这个回路
//
// 不依赖 React：直接**静态**解析 client.cjs，找出每个函数组件体内
// 「hook 调用」与「提前 return」的相对位置，要求所有 hook 都出现在任何
// 提前 return 之前。这是 hooks 规则里唯一能纯静态判定、且正是本次踩中的那一条。
//
// 判据刻意用「位置」而不是「数量」：位置是缺陷本身，数量会随重构变化。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(here, '../lib/client.cjs');
const src = readFileSync(CLIENT, 'utf8');
const lines = src.split('\n');

/** 组件函数声明的起始行（`function Name(`，名称首字母大写）。 */
function componentStarts() {
  const out = [];
  lines.forEach((l, i) => {
    const m = /^\s{4}function ([A-Z][A-Za-z0-9_]*)\(/.exec(l);
    if (m) out.push({ name: m[1], line: i });
  });
  return out;
}

/**
 * 从组件起始行扫到它的结束，只统计**组件体自身**的语句。
 *
 * 必须跟踪花括号深度：组件里到处是嵌套回调（`.map(s => …)`、`async function
 * doLogin(){…}`），它们的 `return` 与 hook 调用**不属于**组件体的 hook 序列。
 * 第一版扫描器没做这件事，于是把内层回调里的 `return` 当成提前 return、
 * 把内层 hook 当成组件 hook，误报了 SiteAccounts / Conversation —— 一个会
 * 误报的护栏会被直接绕过，等于没有。
 *
 * 只认深度 1（组件函数体顶层）的语句。
 *
 * @returns {{hooks: number[], earlyReturns: number[]}} 行下标（0 基）
 */
function scanBody(startIdx) {
  const hooks = [];
  const earlyReturns = [];
  let depth = 0;
  for (let i = startIdx; i < lines.length; i++) {
    const l = lines[i];
    const open = (l.match(/\{/g) || []).length;
    const close = (l.match(/\}/g) || []).length;
    // 组件体顶层 = 深度 1（函数自身的 `{` 已计入）。只有这一层的语句属于
    // hook 序列；嵌套回调里的 hook/return 都不算。
    if (depth === 1) {
      if (/\bReact\.use[A-Z][A-Za-z]*\s*\(/.test(l)) hooks.push(i);
      // 两种提前退出写法都要认：
      //   1. 独立语句：`return <jsx>;`
      //   2. 单行守卫：`if (!list.length) return <jsx>;`  ← 真机缺陷就是这一种
      if (/^\s*return\b/.test(l) || /^\s*(?:if|for|while|switch)\b.*\breturn\b/.test(l)) {
        earlyReturns.push(i);
      }
    }
    depth += open - close;
    // 函数体的 `{` 闭合后即结束——**必须在更新 depth 之后判**，否则会一路
    // 扫到文件末尾，把后面所有组件的 hook 都算进来（第一版就是这样误报的）。
    if (i > startIdx && depth <= 0) break;
  }
  return { hooks, earlyReturns };
}

test('hooks 顺序：组件里任何 hook 都不得出现在提前 return 之后', () => {
  const bad = [];
  for (const c of componentStarts()) {
    const { hooks, earlyReturns } = scanBody(c.line);
    if (!hooks.length || !earlyReturns.length) continue;
    const firstHook = Math.min(...hooks);
    const firstReturn = Math.min(...earlyReturns);
    // 首个 hook 必须早于首个提前 return；否则说明有的 hook 在 return 之后。
    if (firstHook > firstReturn) {
      bad.push(`${c.name}(): 首个 hook 在第 ${firstHook + 1} 行，早退在第 ${firstReturn + 1} 行 —— hook 落在提前 return 之后`);
      continue;
    }
    // 更常见也更阴的形态：hook 夹在两次 return 之间（首屏能到、后屏多一个）。
    const afterReturn = hooks.filter((h) => h > firstReturn);
    if (afterReturn.length) {
      const at = afterReturn.map((h) => h + 1).join(', ');
      bad.push(`${c.name}(): 提前 return 在第 ${firstReturn + 1} 行，但第 ${at} 行仍有 hook —— 首屏与后续渲染的 hook 数量会不同（React 硬错误，整块 UI 变空白）`);
    }
  }
  assert.deepEqual(bad, [],
    'hooks 规则违规（首次渲染与后续渲染的 hook 数量不一致会让整块组件崩成空白）：\n  ' + bad.join('\n  '));
});

test('hooks 顺序：本测试自己不是空转（能抓到已知的历史缺陷形态）', () => {
  // 用一段**最小复现**验证判据本身有效：两个 hook → 单行提前守卫 → 第三个 hook。
  // 若上面的扫描逻辑被改坏，这里会立刻红。
  //
  // 形态必须与真机缺陷**逐字同形**：一行写尽的 `if (条件) return 元素;` 守卫。
  // 真机上正是这种单行守卫把 hook 挡在了后面（「站点表为空就返回加载中」那一句）。
  // 若写成 `if (…) { return … }` 的多行形式，return 落在花括号深度 2，判据刻意
  // 不认它——那是内层块的 return，不是组件体的提前退出。
  const probe = [
    '    function Probe() {',
    '      const [a] = React.useState(null);',
    '      const [b] = React.useState(null);',
    '      if (!a) return null;',
    '      const [c] = React.useState(null);',
    '      return null;',
    '    }',
  ].join('\n');
  const saved = lines.slice();
  lines.length = 0;
  lines.push(...probe.split('\n'));
  const starts = componentStarts();
  const { hooks, earlyReturns } = scanBody(starts[0].line);
  lines.length = 0;
  lines.push(...saved);

  assert.equal(starts.length, 1, '复现样本没被识别为组件');
  assert.ok(earlyReturns.length >= 1, '复现样本没被识别出提前 return');
  const afterReturn = hooks.filter((h) => h > Math.min(...earlyReturns));
  assert.equal(afterReturn.length, 1, '判据没抓到「hook 在提前 return 之后」这个形态——护栏是空转的');
});