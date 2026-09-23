// attach-scope.js — 附件证据的**唯一**判定实现（0.19.5）。
//
// ## 为什么把它抽成独立模块
//
// 这条判据此前写在 `browser-driver.js` 的 `page.evaluate` 回调里，于是它**无法被单测
// 真正驱动**：护栏只能「查源码里有没有某个字符串」。首版护栏正是这样写的，而反向验证
// （把 `if (inTranscript(el)) return false;` 改成恒不成立、把作用域那一条短路掉）**两条
// 都仍然全绿**——判据是装饰品。本仓库把这种形态记作「护栏逃逸」，因此这里改成：
//
//   · 判定逻辑只写一份，放在本模块的 `pickAttachEvidence(o)` 里（纯函数，只依赖传入的
//     `doc`/元素适配器，不碰全局 document）；
//   · 驱动侧把它以**源码字符串**注入 `page.evaluate`（`ATTACH_PICK_SRC`），因此浏览器
//     里跑的就是这一份，不存在「实现一份、判据一份」；
//   · 护栏用一个小 DOM 适配器**直接驱动**它，并断言真附件 chip 通过、正文里的同名文本
//     被拒——变异掉任何一条过滤都会当场变红。
//
// ## 判据（真机依据见 browser-driver.js 的 TRANSCRIPT_SELECTOR 注释）
//
// 一条命中要被接受，必须同时满足：
//   ① 文本含文件名且长度 ≤ 文件名 + 80（chip 量级）；
//   ② 不在**网页会话正文**里（`closest(transcriptSel)` 为 null）；
//   ③ 落在 **composer 作用域**内——从输入框往上、最高的「含文件入口且不含正文节点」
//      的祖先。真机层高读数：第 5 层 `div._871cbca` 含 2 个真 chip、0 个正文节点，
//      第 6 层起正文节点出现（3 个），因此作用域必须停在正文之下。
//
// 第 ③ 条的作用域若认不出来（页面结构变了），`scoped:false` 如实报出，此时只靠 ②
// 兜底——宁可少一层收紧，也不制造假阴性（那会让真附件永远确认不了）。

/**
 * 判定主体。参数与返回值与驱动侧 `pageAttachEvidence` 一致。
 *
 * @param {object} o
 * @param {object} o.doc 文档适配器：需有 `querySelectorAll(sel)` 与 `body`。
 * @param {object|null} o.input 文件入口元素（可 null）。
 * @param {object|null} o.ta 输入框元素（可 null；缺省回落到 input）。
 * @param {string} o.name 文件名（可为空串：表示只测类名候选）。
 * @param {number} o.max 文本长度上限（文件名长度 + 80）。
 * @param {string} o.transcriptSel 正文节点选择器。
 * @param {string[]} o.sels 类名候选选择器。
 */
export function pickAttachEvidence(o) {
  const { doc, input, ta, name, max, transcriptSel, sels } = o;
  const NAME = String(name || '');
  const skip = (el) => ['SCRIPT', 'STYLE', 'INPUT', 'TEXTAREA'].includes(el.tagName);
  const qsa = (root, sel) => { try { return [...root.querySelectorAll(sel)]; } catch { return []; } };

  // composer 作用域：从输入框往上，取**最高的**「含文件入口且不含正文节点」的祖先。
  // 真机层高读数见文件头：越过这一层就会把正文节点收进来。
  let scope = null;
  for (let n = ta; n && n !== doc.body; n = n.parentElement) {
    if (input && !n.contains(input)) continue;
    const hasTranscript = qsa(n, transcriptSel).length > 0;
    if (!hasTranscript) scope = n;
  }
  const inTranscript = (el) => {
    try { return typeof el.closest === 'function' && el.closest(transcriptSel) !== null; } catch { return false; }
  };
  const visible = (el) => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects?.().length);

  // 类名候选也必须在**作用域内**计数：全页计数会把正文里的历史附件卡、侧栏元素
  // 一起算进来，于是「候选命中」这一列又会变成假阳性。
  const candidates = (sels || []).map((sel) => {
    const els = qsa(scope || doc, sel);
    return { sel, count: els.length, visible: els.filter(visible).length };
  });

  const hits = qsa(doc, 'body *').filter((el) => {
    if (skip(el)) return false;
    const t = (el.textContent || '').trim();
    if (NAME && !t.includes(NAME)) return false;
    if (t.length > max) return false;
    if (inTranscript(el)) return false;              // ② 正文排除
    if (scope && !scope.contains(el)) return false;  // ③ composer 作用域
    return true;
  });

  let nameHit = null;
  if (hits.length) {
    const deep = hits.filter((el) => !hits.some((x) => x !== el && el.contains(x)));
    const node = deep[0] || hits[0];
    nameHit = {
      tag: node.tagName.toLowerCase(),
      cls: String(node.getAttribute('class') || '').slice(0, 120),
      id: node.id || null,
      snippet: String(node.outerHTML || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    };
  }
  let near = null;
  if (!nameHit) {
    let box = input;
    for (let i = 0; i < 2 && box?.parentElement; i += 1) box = box.parentElement;
    if (box) near = String(box.outerHTML || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }
  return {
    candidates,
    nameHit,
    domSnippet: nameHit ? nameHit.snippet : near,
    scoped: Boolean(scope),
    scopeDesc: scope ? scope.tagName.toLowerCase() + '.' + String(scope.getAttribute('class') || '').split(/\s+/).slice(0, 2).join('.') : null,
    transcriptNodes: qsa(doc, transcriptSel).length,
  };
}

/**
 * `pickAttachEvidence` 的源码字符串，供 `page.evaluate` 在浏览器里求值。
 *
 * 为什么用源码注入而不是再写一份：浏览器上下文拿不到模块作用域，而「实现一份、判据
 * 另一份」正是本轮修掉的缺陷形态。这里保证**跑在页面里的就是被单测驱动的那一份**。
 */
export const ATTACH_PICK_SRC = pickAttachEvidence.toString();
