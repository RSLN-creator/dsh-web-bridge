#!/usr/bin/env node
/**
 * 基准层的 CI 闸门（0.14.9）——把 `prompt-bench.mjs` 接进 `npm test`。
 *
 * ## 为什么需要这个文件，而不是直接在 package.json 里写 `node test-mock/prompt-bench.mjs`
 *
 * 单跑一次 harness 只能证明「这一批用例今天通过」。它**不能**证明 harness 本身还
 * 有效——如果判据被写坏成「永远返回通过」（例如 `findProtocolStart` 返回对象却被
 * 当成数字用，见 lib/bench.js 里那次 OOM 的注释），单跑依然会绿。所以本脚本同时
 * 断言**四种退出码**，其中两种是「必须失败」：
 *
 *   | 场景                          | 期望退出码 | 证明了什么                     |
 *   |-------------------------------|-----------|--------------------------------|
 *   | 正常用例集                    | 0         | 判据对正例不误伤               |
 *   | 负向用例集（negative-control）| 1         | **harness 不是永远通过**       |
 *   | 不存在的用例文件              | 2         | 参数/文件错误被如实报出        |
 *   | `--live` 未获批准             | 3         | 默认拒绝联网（风控纪律）       |
 *
 * ## 为什么退出码 1 那条是**本文件存在的理由**
 *
 * 「所有测试都通过」是最容易伪造的健康信号。负向用例集里的期望值全是**故意错**的
 * （例如期望一个不存在的调用），所以只要判据真的在判，它就**必须**失败。若哪天
 * harness 被判坏了，这条会变绿——那时本脚本立刻报红，而不是让整个基准层静默失效。
 *
 * 用法：`node test-mock/bench-ci.mjs`（`npm test` 已包含）。退出 0 = 四种行为全部符合。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(here, 'prompt-bench.mjs');
const CASES = path.join(here, 'prompt-bench', 'cases.json');
const NEGATIVE = path.join(here, 'prompt-bench', 'negative-control', 'cases.json');

/**
 * 跑一次 harness 并取退出码。
 *
 * 用 `spawnSync` + `stdio:'inherit'` 而不是 `exec`：本 harness 会输出中文报告，
 * 需要让它在 CI 日志里可读；同时避免把大段输出塞进内存（父进程只需退出码）。
 * 关键：**必须捕获退出码**，不能只看 stdout 有没有报错文字——退出码是契约。
 */
function run(label, args) {
  const r = spawnSync(process.execPath, [HARNESS, ...args], { stdio: 'inherit' });
  if (r.error) {
    console.error(`[bench-ci] ${label} 无法启动：${r.error.message}`);
    return { code: -1 };
  }
  return { code: r.status === null ? -1 : r.status };
}

const checks = [
  { label: '正例用例集（期望 0）', args: [], expect: 0 },
  { label: '负向用例集（期望 1 = 判据可被反证）', args: ['--cases', NEGATIVE], expect: 1 },
  { label: '不存在的用例文件（期望 2 = 参数错误）', args: ['--cases', path.join(here, 'prompt-bench', '__no_such_file__.json')], expect: 2 },
  { label: '--live 未获批准（期望 3 = 默认拒绝联网）', args: ['--live'], expect: 3 },
];

/**
 * **逐判据隔离检查**——本文件存在的真正理由。
 *
 * 为什么整份负向用例集一起跑还不够：负向用例会*同时*违反多条判据，于是只要其中
 * 任意一条还在工作，退出码就仍是 1。实测过这个缺口：把 `expectCalls` 的检查改成
 * `if (false && ...)`（判据恒真）之后，跑整份 negative-control **依然退出 1**，
 * 缺口完全不可见。
 *
 * 做法：为**每一条判据**单独生成一个临时用例集，只放一条用例、只违反一条判据，
 * 断言它仍然退出 1。任一条判据被写坏成恒真时，对应的那条单独的用例就会变绿，
 * 这一步立刻报红并指出是**哪一条**判据失效。
 *
 * 用例的 id 与产物必须一一对应（产物登记在 prompt-bench.mjs 的 RESPONSES 里），
 * 因为 harness 按 id 取录制流。
 */
const CRITERIA = [
  { kind: 'expectCalls', caseSpec: { id: 'nc-require-args', family: 'TOOL_ARGS_MISSING_REQUIRED', expectCalls: ['read', 'pwsh'] } },
  { kind: 'expectArgsAt', caseSpec: { id: 'nc-expect-args-at', family: 'TOOL_ARGS_MISSING_REQUIRED', expectArgsAt: [{ index: 0, key: 'command', value: '__not_the_real_command__' }] } },
  { kind: 'requireArgs', caseSpec: { id: 'nc-require-args', family: 'TOOL_ARGS_MISSING_REQUIRED', requireArgs: [{ index: 0, keys: ['__no_such_arg_key__'] }] } },
  // expectFinish 必须挂在一个**纯文本收尾**的产物上（nc-max-text-chars 的收尾是 stop，
  // 所以要求 tool-calls 必然不成立）。第一版我把它挂在 nc-require-args 上——那个产物
  // 有调用，收尾本来就是 tool-calls，判据自然通过，于是 harness 的 selfCheckCoverage
  // 以「用故意写错的产物仍然判为通过」把我拦下。这条自检确实在防我这类错误。
  { kind: 'expectFinish', caseSpec: { id: 'nc-max-text-chars', family: 'TEXT_DELTA_WITHOUT_BLOCK', expectFinish: 'tool-calls' } },
  { kind: 'maxTextChars', caseSpec: { id: 'nc-max-text-chars', family: 'TEXT_DELTA_WITHOUT_BLOCK', maxTextChars: 1 } },
  { kind: 'expectNoLeak', caseSpec: { id: 'nc-expect-no-leak', family: 'PROTOCOL_RESIDUE', expectNoLeak: true } },
  { kind: 'expectTextIncludes', caseSpec: { id: 'nc-max-text-chars', family: 'TEXT_DELTA_WITHOUT_BLOCK', expectTextIncludes: ['<<<MUST_NOT_APPEAR>>>'] } },
];

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bench-ci-'));
let criteriaFailed = 0;
try {
  for (const c of CRITERIA) {
    const file = path.join(tmp, c.kind + '.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, cases: [c.caseSpec] }), 'utf8');
    const { code } = run(`判据隔离：${c.kind}`, ['--cases', file]);
    const ok = code === 1;
    if (!ok) {
      criteriaFailed++;
      console.error(`[bench-ci] FAIL  判据「${c.kind}」单独违反时退出码=${code}（期望 1）`
        + ' —— 这条判据很可能已被写坏成恒真/恒假，它现在不提供任何证据。');
    } else {
      console.log(`[bench-ci] PASS  判据隔离：${c.kind} 单独违反 → 退出 1（该判据确实在判）`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

let failed = 0;
for (const c of checks) {
  const { code } = run(c.label, c.args);
  const ok = code === c.expect;
  if (!ok) failed++;
  console.log(`[bench-ci] ${ok ? 'PASS' : 'FAIL'}  ${c.label}  实际退出码=${code} 期望=${c.expect}`);
}

console.log('');
if (failed || criteriaFailed) {
  console.error(`[bench-ci] ${failed}/${checks.length} 项整体检查、${criteriaFailed}/${CRITERIA.length} 条判据隔离检查不符合预期。`);
  console.error('[bench-ci] 特别注意「负向用例集」那条：若它变绿，说明 harness 变成了'
    + '「永远通过」，此时整个基准层不再提供任何证据。');
  process.exit(1);
}
console.log(`[bench-ci] 全部 ${checks.length} 项整体检查 + ${CRITERIA.length} 条逐判据隔离检查符合预期：`
  + '每条判据都单独可被反证、错误码正确、默认拒绝联网。');
console.log(`[bench-ci] 用例集：${path.relative(process.cwd(), CASES)}（${path.basename(NEGATIVE)} 为负向对照）`);
