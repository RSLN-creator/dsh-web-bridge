// 变量隔离:专家模式 / 工具格式化 prompt / 二者组合
async function ask(model, content, label) {
  const body = JSON.stringify({ model, stream: false, messages: [{ role: 'user', content }] });
  const t0 = Date.now();
  try {
    const resp = await fetch('http://127.0.0.1:8931/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(150_000) });
    const j = await resp.json();
    const text = typeof j?.choices?.[0]?.message?.content === 'string' ? j.choices[0].message.content : JSON.stringify(j?.choices?.[0]?.message?.content ?? j?.error ?? '');
    console.log(`${label} -> HTTP ${resp.status} in ${((Date.now()-t0)/1000).toFixed(1)}s | ${text.slice(0, 60)}`);
  } catch (e) { console.log(`${label} -> FAIL ${((Date.now()-t0)/1000).toFixed(1)}s | ${e.message}`); }
}

// 1) 专家模式短消息
await ask('deepseek:deepseek', '请只回复:好', '专家+短');
// 2) 专家模式 + agent-preset 风格工具声明(模拟 DSH 首轮注入格式)
const toolDecl = Array.from({ length: 27 }, (_, i) => `工具${i}: read_file_${i} / write_file_${i}`).join('\n');
await ask('deepseek:deepseek', `你可以使用以下工具:\n${toolDecl}\n\n请只回复:好`, '专家+工具声明');
