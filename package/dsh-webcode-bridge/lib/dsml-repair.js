// dsml-repair.js — 网页原生 DSML 的**无名闭合标签**还原（0.16.2）。
//
// ## 为什么单独成模块
//
// 这段逻辑必须在 normalizeDsml **之前**跑（它要看到原始的标签名），而
// normalizeDsml 在 agent-preset.js 里。把它抽出来独立成纯函数模块，
// 就能被 test/dsml-native-close.test.mjs 直接断言，也让 agent-preset.js
// 只多一行 import。
//
// ## 为什么必须存在（真机取证，不是推测）
//
// 用户原话：「用 bridge 怎么总是返回真实工具调用说正文没有返回？
// 但是我看 web 是真实有的啊！」——「web 是真实有的」是字面为真：
// 网页端确实发出了完整调用，丢在桥这一侧。
//
// 用桥自己的只读控制面取网页原话：
//
//   POST http://127.0.0.1:8931/__webcode/history {"sessionId":"…"}
//   node .tmp/capture-dsml-fixtures.mjs      # 落成 test/fixtures/dsml-real-*.txt
//
// 13 份真机夹具里，两个形态在旧代码上解析出 **0 条调用**：
//
//   · dsml-real-13 —— 闭合标签连名字都省掉（`</>`，没有 invoke/parameter）
//   · dsml-real-7  —— **漏写 invoke 开标签**，直接从 parameter 起写、却用
//                     invoke 的闭标签收束
//
// 第一个形态的后果链：旧的 `</标记\s*` → `</` 规则把它变成裸的 `</>`；
// 于是 invokeBodyEnd 的参数配平状态机永远等不到 `</invoke>`，体一直未闭合
// → takeObj 拿到的东西不是合法调用 → 整条被丢。
// 第二个形态：没有外壳就没有 invoke 体，一条也匹配不到。
//
// 两者叠加后，收尾时协议被 proseSafeEnd 整段扣住，只剩散文或空消息，
// 于是交回 TOOL_CALL_UNPARSED —— 用户看到的就是「说有工具调用、
// 又说没有正文」。
//
// ## 保守判据（这就是反向安全线）
//
// **只对带 DSML 标记的标签动手**。裸的 parameter 标签常出现在讲解协议的
// 散文/文档里，补了外壳就会把示例当调用执行——宁可少救，不可错认。
// 栈空时的无名闭合原样返回，绝不凭空造出闭标签。

/** 全角竖线 ×2：DSML 标记的构成字符。用 charCode 现造，源码里不出现该字符。 */
const BAR = String.fromCharCode(0xFF5C) + String.fromCharCode(0xFF5C);
/** 正则里的反斜杠转义引导符。同样用 charCode 现造，源码里不出现反斜杠。 */
const ESC = String.fromCharCode(92);
const SP = ESC + 's';

/**
 * 匹配「带 DSML 标记的标签」，并捕获斜杠、标记串与（可选的）标签名。
 *
 * 形状：`<` + DSML 标记 + 可选标签名
 * 闭合与开标签由第 1 个捕获组区分（`/` 或空）。
 * 标记串要允许重复（真机里出现过 `</标记><标记>` 连写的畸形）。
 */
const TAG = new RegExp(
  '<([/]?)((?:' + SP + '*[' + BAR + '|]+' + SP + '*DSML' + SP + '*[' + BAR + '|]+' + SP + '*)+)([A-Za-z_][A-Za-z0-9_-]*)?',
  'gi',
);

/**
 * 栈式还原无名闭合标签，并在缺失 invoke 外壳时补一个空名外壳。
 *
 * 三个动作，各自对应一族真机形态：
 *   1. 无名闭合（`</>`）→ 按栈顶补回真实标记名（parameter / invoke）；
 *   2. 只带标记的 parameter 且栈里没有 invoke → 补 `name=""` 外壳，
 *      名字交给下游的 inferToolNameFromArgs 按参数形状反推（唯一解才认）；
 *   3. 具名标签只维护栈，原样返回——既有形态**逐字不变**。
 *
 * @param {string} text 网页原始回复
 * @returns {string} 还原后的文本（不改动具名标签）
 */
export function repairNamelessClosers(text) {
  const stack = [];
  return String(text ?? '').replace(TAG, (m, slash, marker, name) => {
    const tag = String(name || '').toLowerCase();
    if (!slash) {
      if (tag === 'invoke') { stack.push('invoke'); return m; }
      if (tag === 'parameter') {
        // 漏写 invoke 开标签的形态：补一个空名外壳，让 invokeBodyEnd 有体可配平。
        if (!stack.includes('invoke')) {
          stack.push('invoke');
          stack.push('parameter');
          return '<' + marker + 'invoke name="">' + m;
        }
        stack.push('parameter');
        return m;
      }
      return m;
    }
    // 具名闭合：把栈收到该标签之下（畸形嵌套按最近匹配处理）。
    if (tag) {
      const at = stack.lastIndexOf(tag);
      if (at >= 0) stack.length = at;
      return m;
    }
    // 无名闭合：栈空则原样返回（不凭空造标签）。
    const top = stack.pop();
    return top ? '</' + marker + top : m;
  });
}
