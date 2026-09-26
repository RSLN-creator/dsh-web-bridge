// probe-lock-verify-reverse.mjs — bridge-lock 0.19.22 的**反向验证**（变异测试）。
//
// ## 为什么必须做这一步
//
// 新加的「持有者已死 ⇒ 允许接管」是一条**放宽**判据。放宽型修复有一个特有风险：
// 判据写宽了（例如误把活着的持有者判成死的）会让准则本身失效，而正常测试**照样全绿**——
// 因为正常测试只开一个桥。
//
// 所以本探针做两件事，两件都必须成立：
//
//   ① **删掉死锁分支** → 「接管」那一组用例必须变红（证明修复真的在承重）；
//   ② 还原 → 必须全绿（证明没有别的路径在替我兜底）。
//
// 用法：node test-mock/probe-lock-verify-reverse.mjs
// 退出码：0 = 反向验证成立（该红的红了、该绿的绿了）；1 = 不成立。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const lockPath = path.join(pkgRoot, 'lib', 'bridge-lock.js');
const testFile = 'test/bridge-lock.test.mjs';

/** 变异：整段删掉「持有者已死」判据，其余一字不动。 */
const MUTATION = /  \/\/ ── 持有者已死（0\.19\.22）[\s\S]*?\n  }\n\n/;

function runTests() {
  const r = spawnSync(process.execPath, ['--test', testFile], {
    cwd: pkgRoot, encoding: 'utf8', stdio: 'pipe',
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const pass = Number(/^ℹ pass (\d+)/m.exec(out)?.[1] ?? -1);
  const fail = Number(/^ℹ fail (\d+)/m.exec(out)?.[1] ?? -1);
  const failed = [...out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1]);
  return { code: r.status, pass, fail, failed };
}

const original = fs.readFileSync(lockPath, 'utf8');
if (!/holder-process-dead/.test(original)) {
  console.error('前置失败：修复不在盘上（找不到 holder-process-dead）');
  process.exit(1);
}

let ok = true;
try {
  const mutated = original.replace(MUTATION, '');
  if (mutated === original) {
    console.error('变异未生效：正则没匹配到死锁分支');
    process.exit(1);
  }
  fs.writeFileSync(lockPath, mutated);
  const red = runTests();
  console.log(`[变异后] pass=${red.pass} fail=${red.fail}`);
  console.log(`         变红的用例：${red.failed.join(' | ') || '(无)'}`);
  const deadCaseRed = red.failed.some((n) => /①g|②d|⑦b/.test(n));
  if (!deadCaseRed) {
    console.error('✗ 反向验证失败：删掉死锁判据后，「接管」用例仍然是绿的 ⇒ 修复没有承重');
    ok = false;
  }
} finally {
  fs.writeFileSync(lockPath, original);
}

const green = runTests();
console.log(`[还原后] pass=${green.pass} fail=${green.fail}`);
if (green.fail !== 0 || green.pass <= 0) {
  console.error('✗ 还原后不绿 ⇒ 探针自身污染了工作树');
  ok = false;
}

console.log(ok ? '✓ 反向验证成立：该红的红了、该绿的绿了' : '✗ 反向验证不成立');
process.exit(ok ? 0 : 1);
