// real-probe-11-tool-loop.mjs — 真机完整工具调用闭环（正面回应"擦边"）
// 用项目自身的 agent-preset 协议 + 真实本地工具执行器，在真实 DeepSeek 网页上跑：
//   R1: 首轮注入 preset+自用案例 → 网页自主发 <tool_call>（read）
//   R2: 本地执行 read → 结果以 result 围栏回填 → 网页继续（search/grep）
//   R3: 执行 → 回填 → 网页给出简洁总结收束
// 关键：工具名称/参数来自网页自主选择并严格匹配 schema，本地真实执行后才回填。
import { createBrowserDriver } from '../lib/browser-driver.js';
import { serializeFirstTurn, parseAgentReply } from '../lib/agent-preset.js';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = 'd:\\9_Code_Workspace\\dsh-webcode-bridge';
const pkgDir = path.join(ROOT, 'package', 'dsh-webcode-bridge');

const tools = [
  { name: 'read', description: '读取本地文件文本内容。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'grep', description: '在指定目录下按正则关键词递归搜索文本。', parameters: { type: 'object', properties: { pattern: { type: 'string' }, dir: { type: 'string' } }, required: ['pattern', 'dir'] } },
  { name: 'pwsh', description: '在本地执行一条 PowerShell 命令并返回输出。', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
];

// 真实本地执行器：仅在白名单安全方向执行，base 固定为实际工程目录（pkgDir）
function runTool(name, args, base = pkgDir) {
  switch (name) {
    case 'read': {
      const p = path.resolve(base, String(args?.path || ''));
      if (!fs.existsSync(p)) return { status: 'error', error: '文件不存在: ' + p };
      const t = fs.readFileSync(p, 'utf8');
      return { status: 'success', output: t.slice(0, 2000) };
    }
    case 'grep': {
      const dir = String(args?.dir && args.dir !== '.' ? (path.isAbsolute(args.dir) ? args.dir : path.resolve(base, args.dir)) : base);
      // DeepSeek 网页常输出 PCRE/grep 风格内联修饰符 (?i)(?s)，JS 正则不识别，
      // 需提取为构造函数 flag（真实 harness 的 grep 执行器也需做这一步语义归一）。
      let src = String(args?.pattern || '');
      let flag = 'i';
      const im = /^\(\?([imsxu]+)\)/.exec(src);
      if (im) {
        flag = im[1].includes('i') ? 'i' : '';
        flag += im[1].includes('s') ? 's' : '';
        src = src.slice(im[0].length);
      }
      const rx = new RegExp(src, flag);
      const hits = [];
      const walk = (d, depth = 0) => {
        if (depth > 2 || hits.length >= 20) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
          const fp = path.join(d, e.name);
          if (e.isDirectory()) walk(fp, depth + 1);
          else if (/\.(js|mjs|ts|json)$/.test(e.name)) {
            try { if (rx.test(fs.readFileSync(fp, 'utf8'))) hits.push(path.relative(base, fp)); } catch {}
          }
        }
      };
      walk(dir);
      return { status: 'success', output: hits.length ? hits.join('\n') : '无命中' };
    }
    case 'pwsh': {
      const cmd = String(args?.command || '');
      if (!cmd || /rm\s+-?r|Remove-Item|Set-Content|[^\\]>|format\s+/i.test(cmd)) return { status: 'error', error: '拒绝执行的命令（只读白名单）' };
      try { return { status: 'success', output: execSync(`powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 15000, cwd: base }).slice(0, 1500) }; }
      catch (e) { return { status: 'error', error: String(e.stderr || e.message).slice(0, 500) }; }
    }
    default: return { status: 'error', error: '未知工具: ' + name };
  }
}

function resultFence({ name, status, output, error }) {
  const p = { mcp_action: 'result', name, status };
  if (status === 'error') p.error = String(error || 'unknown').slice(0, 2000);
  else p.output = String(output || '').slice(0, 2000);
  return '```json\n' + JSON.stringify(p) + '\n```';
}

const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/',
  profileDir: 'd:\\9_Code_Workspace\\dsh-webcode-bridge\\.edge-real-profile',
  headless: true,
  requestTimeoutMs: 120_000,
  logger: console,
});

// 长一点的自用案例（用户要求）
const userCase = '请审查本项目（dsh-webcode-bridge）的安全性。第一步先用 read 读取 package.json 查看依赖情况；第二步用 grep 在代码里搜索鉴权相关的关键词（token、authorization、secret、password）看是否泄露硬编码凭据；最后用一行总结本项目是否存在明显的安全风险。每一步都真实调用工具，拿到结果再继续，不要凭空描述。';

let timer = setTimeout(() => { console.log('GLOBAL-TIMEOUT'); process.exit(2); }, 240_000);
let firstPass = null;
try {
  const conn = await driver.connect();
  console.log('connect loggedIn=', conn.loggedIn);
  if (!conn.loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }

  // ---- 首轮：preset + 案例，网页自主发起调用 ----
  console.log('\n===== R1 首轮：注入 preset + 自用案例 =====');
  const first = serializeFirstTurn({ messages: [{ role: 'user', content: userCase }], tools, model: { id: 'deepseek' } });
  const t0 = Date.now();
  let acc1 = '';
  const r1 = await driver.sendTurn('tool-loop-real', first, {
    fresh: true, model: 'deepseek',
    onDelta: (d) => { if (!firstPass) firstPass = Date.now() - t0; acc1 += d; },
  });
  console.log('[R1] firstTokenMs=', firstPass, 'sessionId=', r1.sessionId);
  const p1 = parseAgentReply(acc1 || r1.text);
  console.log('[R1] calls=', JSON.stringify(p1.calls.map(c => c.name)));
  if (!p1.calls.length) {
    console.log('[R1] 网页未自主发起工具调用，原始输出前 500 字：\n', (acc1 || r1.text).slice(0, 500));
    console.log('PROBE RESULT: WEB did not initiate tool call');
  } else {
    const c0 = p1.calls[0];
    console.log('[R1] 网页选择工具=', c0.name, 'args=', JSON.stringify(c0.arguments));
    console.log('[R1] 真实执行:');
    const res0 = runTool(c0.name, c0.arguments);
    console.log('    result=', JSON.stringify(res0).slice(0, 200));
    // ---- R2：真实结果回填（带 train 提醒），让网页继续 ----
    console.log('\n===== R2 回填执行结果，让网页继续搜索/收束 =====');
    const r2text = resultFence(res0) + '\n[系统提示] 请保持工具调用格式：以 <tool_call> 开始、</tool_call> 结束，其内为单个 JSON 对象 {"mcp_action":"call","name":"工具名","purpose":"原因","arguments":{…}}。拿到结果后如还需其它数据就继续调用；若已足够，直接给出简洁总结收束。';
    let acc2 = '';
    const r2 = await driver.sendTurn('tool-loop-real', r2text, {
      fresh: false, model: 'deepseek',
      onDelta: (d) => { acc2 += d; },
    });
    const p2 = parseAgentReply(acc2 || r2.text);
    console.log('[R2] calls=', JSON.stringify(p2.calls.map(c => c.name)));
    if (p2.calls.length) {
      const c1 = p2.calls[0];
      console.log('[R2] 工具=', c1.name, 'args=', JSON.stringify(c1.arguments));
      const res1 = runTool(c1.name, c1.arguments);
      console.log('[R2] result=', JSON.stringify(res1).slice(0, 150));
      // ---- R3：再回填，期望网页总结收束 ----
      console.log('\n===== R3 二次回填，期望总结收束 =====');
      let acc3 = '';
      await driver.sendTurn('tool-loop-real', resultFence(res1) + '\n请基于以上真实数据，给出一行安全结论并收束。', {
        fresh: false, model: 'deepseek',
        onDelta: (d) => { acc3 += d; },
      });
      console.log('[R3] 网页总结输出：');
      console.log((acc3 || '').split('\n').map(l => '   ' + l).join('\n').slice(0, 800));
      console.log('\nPROBE RESULT: TOOL-LOOP COMPLETE');
    } else {
      console.log('[R2] 网页二次输出来（非调用）:\n', (acc2 || r2.text).slice(0, 600));
      console.log('PROBE RESULT: R2 did not continue tool loop');
    }
  }
} catch (e) {
  console.error('\nPROBE-ERROR:', e?.message, e?.code ?? '');
} finally {
  clearTimeout(timer);
  try { await driver.close(); } catch {}
}