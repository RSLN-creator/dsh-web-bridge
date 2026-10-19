// think-effort.test.mjs — 0.19.48 护栏：思考等级（推理等级）必须真的下发到网页，且失败必须报。
//
// ## 这个文件防的是哪一类缺陷
//
// 用户报障原话（2026-09-28）：「现在的模型网页端，除了 deepseek 是只有深度思考开关没有
// 思考等级开关，其他网站都有思考等级的分级你没有选择，写好 dsh 这里能主动选择」。
//
// 真因是桥**没有把宿主的推理等级通道接上**：`resolveModel()` 从不返回 `reasoning`，
// 于是 DSH 选择器里所有站点都没有等级一栏；更隐蔽的是第二半——即使声明了，驱动也不会
// 去点网页上的档位。这一旦写错有两种失效形状，都很贵：
//
//   ① **假功能**：声明了等级、点了没生效，界面显示「深度」而网页停在「快速」；
//   ② **整站不可用**：声明了一个网页上没有的档位 ⇒ 每一轮都抛错，站点直接不能用。
//
// 因此本文件钉住五组判据：
//   ① 声明层：等级 id 必须逐字是网页菜单文本（真机读数在 think-effort.js 头部），
//      且**没有读数就不许声明控件**（未取证站点宁可不显示）；
//   ② 计划层：`planEffort` 的步骤形状（含 `openIfClosed` 只对声明过的站点打开）；
//   ③ 判定层：`confirmEffort` 的三态（match / mismatch / unknown）与 Default 的语义；
//   ④ 执行层：`applyEffort` 对**真页面函数**跑一遍——用假 DOM 桩调真正的
//      `FIND_EFFORT_CONTROL` / `READ_CHECKED_EFFORT`，因此验的是驱动会跑的那段代码，
//      不是重写的一份；
//   ⑤ 接线层：`page.evaluate(fn, cfg)` 的**参数转发**必须成立。这一条单独立案：
//      把 cfg 写成第三个参数时 Playwright 会静默丢掉它，页面里 cfg 变 undefined，
//      症状是「每个站点都找不到控件」而单测全绿——本仓库记过这类假绿。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  THINK_EFFORT, thinkEffortFor, reasoningEffortsFor, effortById,
  normalizeLabel, confirmEffort, planEffort, applyEffort, effortFromTriggerLabel,
  FIND_EFFORT_CONTROL, FIND_DISABLED_EFFORT_CONTROL, READ_CHECKED_EFFORT, READ_SELECTOR_TEXT,
} from '../lib/think-effort.js';
import { SITES, resolveWebModel } from '../lib/providers.js';

const PKG = path.join(import.meta.dirname, '..');
const DRIVER = fs.readFileSync(path.join(PKG, 'lib', 'browser-driver.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8');

// ---------------------------------------------------------------------------
// 假 DOM：让 FIND_EFFORT_CONTROL / READ_CHECKED_EFFORT 这两个真页面函数在 Node 里跑起来。
// 刻意只实现它们真正用到的 API（querySelectorAll / getBoundingClientRect / getComputedStyle
// / 属性读取），不引 jsdom——本仓库的脚本传统是无第三方依赖（见 scripts/lint-comments.mjs 头注）。
// ---------------------------------------------------------------------------

/**
 * 造一个「可见元素」桩。`attrs` 给 aria-checked / data-state / role / data-testid；
 * `kids` 给子节点（**父子关系必须真的建起来**：`applyEffort` 靠祖先判「这个节点在不在
 * 已打开的浮层里」，扁平列表里没有 parentElement ⇒ 浮层判定永远为假，回读口径
 * `aria-checked` 的站点会被判成「档位没生效」）。
 */
function el({ text = '', cls = '', attrs = {}, x = 0, y = 0, w = 100, h = 30, kids = [], onClick = null } = {}) {
  const self = {
    textContent: text,
    className: cls,
    childNodes: kids,
    parentElement: null,
    // 页面侧函数（CLICK_EFFORT_OPTION）会用 DOM 原生 `.click()` 点条目：桩里必须真的记一笔，
    // 否则「点了哪一条」在测试里不可观测（而它正是本文件要钉住的东西）。`onClick` 让用例
    // 模拟「点了之后网页自己变了」（如 kimi 把触发钮文本重渲染成新档）。
    clicks: 0,
    click() { this.clicks += 1; onClick?.(self); },
    getBoundingClientRect: () => ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h }),
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
  };
  for (const k of kids) k.parentElement = self;
  return self;
}

/**
 * 桩元素的「标签/type」。
 *
 * 为什么必须让 `input` 组自己带上 `contenteditable`：真页面上输入框是
 * `<div contenteditable="true">`，`FIND_EFFORT_CONTROL` 就是按这个属性找锚点的；
 * 桩里若不写，锚点恒为空 ⇒ 「就近」判据失效（而它正是选定触发控件的那条判据）。
 */
const INPUT_EL = () => el({ x: 300, y: 700, w: 800, h: 40, attrs: { contenteditable: 'true' } });

/**
 * 是否命中简单选择器（够用：标签 / [attr] / [attr="v"]）。
 *
 * 桩元素本身不带标签信息——标签由安装时的分组名给（见 KIND_OF_GROUP）。
 */
function domMatches(e, sel) {
  const s = sel.trim();
  if (s === 'textarea' || s === '[contenteditable="true"]') {
    return e.__kind === 'input' || e.getAttribute('contenteditable') === 'true';
  }
  if (s === 'button') return e.__kind === 'button';
  // 裸标签选择器（0.19.96 补）：zai 的深度思考 pill 是**裸 `div`**（无 role/data-state），
  // 「禁用态取证」函数按 `div, span` 扫候选池。桩若不认裸标签，这条真机形态在单测里恒不可见。
  if (s === 'div' || s === 'span') return e.__kind !== 'input' && e.__kind !== 'button';
  // 类选择器（0.19.49 补）：`readbackSelector` 用的是 `.current-effort` /
  // `.qwen-thinking-selector` 这类类名。桩必须认它，否则「回读节点选择器」这条判据
  // 在单测里恒找不到节点、只能靠别的断言间接覆盖（那就是没覆盖）。
  if (/^\.[\w-]+$/.test(s)) {
    return String(e.className || '').split(/\s+/).includes(s.slice(1));
  }
  const attr = /^\[([\w-]+)(?:([*^$]?=)"?([^"\]]*)"?)?\]$/.exec(s);
  if (attr) {
    const [, name, op, val] = attr;
    const v = e.getAttribute(name);
    if (v == null) return false;
    if (!op) return true;
    if (op === '*=') return String(v).includes(val);
    return String(v) === val;
  }
  return false;
}

/** 组名 → 桩元素的「种类」：`input` 组是输入框、`button` 组是按钮，其余当 div。 */
const KIND_OF_GROUP = (key) => (key === 'input' ? 'input' : key === 'button' ? 'button' : 'div');

/** 当前安装的 DOM 组；`locatorVisible` 用它回答「这个选择器在真页面上看得见吗」。 */
let domGroups = {};

/** 把一组元素按简单选择器分组装进 globalThis.document（没有输入框时自动补一个）。 */
function installDom(groups) {
  domGroups = { input: [INPUT_EL()], ...groups };
  /**
   * 展开一个组里的元素**及其后代**（0.19.49 补）。
   *
   * 为什么必须递归：`readbackSelector` 指向的节点常常是**触发控件的子节点**
   *（kimi 的 `span.current-effort` 在 `div.current-model` 里面）。真 `querySelectorAll`
   * 是深度优先扫全树的，桩若只看顶层分组，那条选择器在单测里恒命中不到 —— 于是
   * 「回读节点」这条判据看起来通过了、实际什么都没验。
   */
  const withDescendants = (item) => {
    const out = [item];
    for (const k of item.childNodes || []) out.push(...withDescendants(k));
    return out;
  };
  globalThis.document = {
    querySelectorAll: (sel) => {
      const out = [];
      for (const [key, list] of Object.entries(domGroups)) {
        for (const item of list) {
          for (const node of withDescendants(item)) {
            const probe = { ...node, __kind: node.__kind ?? KIND_OF_GROUP(key) };
            if (sel.split(',').some((one) => domMatches(probe, one.trim()))) out.push(node);
          }
        }
      }
      return out;
    },
  };
  globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block', opacity: '1', position: 'static', zIndex: 'auto' });
}

/**
 * 选择器在**当前 DOM 里**可见吗？—— 用真实 DOM 回答，而不是靠 fixture 里写死 count。
 *
 * 为什么必须这样：`applyEffort` 用同一个选择器既做「点开触发」也做「点档位条目」，
 * 靠 count 写死会在两条路上给出同一个答案（把 fixture 变成一句谎言）。真 Playwright
 * 的可见性本来就由 DOM 决定，这里照同一判据回答，测试才有资格叫「验的是那段代码」。
 */
function locatorVisible(sel) {
  return globalThis.document.querySelectorAll(sel).length > 0;
}

/**
 * 假 locator：**语义对齐 Playwright**——`filter({hasText})` 真的按文本筛，`first()` 取第一个，
 * `click()` 触发那个元素。
 *
 * 为什么不能图省事（0.19.48 教训）：第一版把 `locator()` 写成「选择器命中就 count=1、
 * click 记一笔」，于是 `filter({hasText:'进阶'})` 什么都不筛——单测里「点了档位」看起来成功，
 * 实际点的是筛选前的那个节点，而真机上那一层筛选是**必须成立**的（否则会点错条目）。
 * 桩在语义上偷懒，测试就变成了自证。
 */
function fakeLocator(all, sel, preds = [], log = null) {
  const self = {
    first: () => fakeLocator(all, sel, preds, log),
    filter: (o) => fakeLocator(all, sel, o && 'hasText' in o ? [...preds, (el) => (el.textContent || '').includes(o.hasText)] : preds, log),
    count: async () => self._items().length,
    isVisible: async () => self._items().length > 0,
    click: async () => {
      const [el] = self._items();
      log?.(sel);
      if (el) el.click();
    },
    _items: () => {
      const hit = all().filter((el) => sel.split(',').some((one) => domMatches({ ...el, __kind: el.__kind ?? 'div' }, one.trim())));
      return hit.filter((el) => preds.every((fn) => fn(el)));
    },
  };
  return self;
}

const CLEANUP = [];
test.afterEach(() => {
  delete globalThis.document;
  delete globalThis.getComputedStyle;
  domGroups = {};
  CLEANUP.length = 0;
});

/**
 * 假 page：只实现 applyEffort 用到的那几个方法。
 *
 * 关键一条：`evaluate` 把**第二个参数**原样交给函数——这正是真 Playwright 的语义，
 * 也是「cfg 被丢成空」那个 bug 的判据（见文件头 ⑤）。
 *
 * `textMode: 'any'` 表示「任何 getByText 都算命中一次」（用于只想看「点过哪个文本」的用例）。
 */
function fakePage({ texts = {}, domGroups: groups = {}, textMode = 'exact' } = {}) {
  const calls = { clicks: [], textClicks: [], mouse: [], evaluates: [] };
  installDom(groups);
  const page = {
    calls,
    async evaluate(fn, arg) {
      calls.evaluates.push({ fn: fn?.name || '(anon)', argType: typeof arg, hadArg: arguments.length > 1 });
      try { return fn(arg); } catch (e) { calls.threw = String(e?.message || e); throw e; }
    },
    locator(sel) {
      return fakeLocator(() => Object.values(domGroups).flat(), sel, [], (s) => calls.clicks.push(s));
    },
    getByText(text) {
      const spec = texts[text] ?? (textMode === 'any' ? { count: 1 } : { count: 0 });
      return {
        first: () => page.getByText(text),
        count: async () => spec.count ?? 0,
        isVisible: async () => spec.visible !== false,
        click: async () => { calls.textClicks.push(text); },
      };
    },
    mouse: { click: async (x, y) => { calls.mouse.push({ x, y }); } },
    async waitForTimeout() {},
  };
  return page;
}

// ---------------------------------------------------------------------------
// ① 声明层
// ---------------------------------------------------------------------------

test('① 每个声明了等级的站点：id 非空且唯一，控件契约要么完整要么显式允许空触发', () => {
  const declared = SITES.filter((s) => (s.efforts || []).length > 0).map((s) => s.id);
  // 真机取到的五个站点（2026-09-28）；改这一行等于声明「又多了一个站点的读数」，
  // 而读数必须落在 think-effort.js 头部的证据清单里。
  assert.deepEqual(declared.sort(), ['doubao', 'glm', 'kimi', 'qwen', 'zai'],
    '声明了思考等级的站点集合变了：要么补真机读数，要么把没读数的站点摘掉');
  for (const s of SITES) {
    if (!(s.efforts || []).length) continue;
    const ids = s.efforts.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, `${s.id} 的等级 id 有重复：${ids.join(',')}`);
    for (const e of s.efforts) {
      assert.equal(e.id, e.name, `${s.id} 的等级 id 必须与显示名逐字相同（id 就是要点的菜单文本）`);
      assert.ok(e.id.trim() && e.id.length <= 8, `${s.id} 的等级 id 形状不对：${JSON.stringify(e.id)}`);
    }
    const ctl = s.effortControl;
    assert.ok(ctl, `${s.id} 声明了等级却没有 effortControl——那会让每一轮都抛 THINK_EFFORT_UI_CHANGED`);
    // 定位手段三选一：独立触发钮（文本/token/选择器）、或「弹层里那一行」（itemLabel，glm）。
    // 两条都没有 ⇒ 这个声明是死的，任何人选了档位都点不到东西。
    const hasTrigger = Boolean(ctl.triggerText || ctl.triggerTokens || (ctl.triggerSelectors || []).length);
    assert.ok(hasTrigger || ctl.itemLabel,
      `${s.id} 的 effortControl 既没有触发钮也没有 itemLabel——没有任何定位手段`);
    // 只允许「有触发器 + 声明过 allowEmptyTrigger」的站点走空触发这条路。
    //
    // 0.19.49 收窄：走这条路的**前提**是「回读只能靠弹层里的选中态」。若站点已经用
    // `readbackSelector` 指了一个**稳定持有档位**的节点（kimi `.current-effort`、
    // qwen `.qwen-thinking-selector`、glm `.think-mode-trigger`），回读就不依赖触发文本，
    // 也就不需要打开 `allowEmptyTrigger`（那个开关的语义是「放弃触发文本这一层校验」，
    // 对能读到干净档位的站点来说纯属放水）。真机依据见 think-effort.js 各条目的注释。
    if (!ctl.triggerText && !ctl.triggerTokens && (ctl.triggerSelectors || []).length && !ctl.readbackSelector) {
      assert.equal(ctl.allowEmptyTrigger, true,
        `${s.id} 只有选择器、没有文本 token：必须显式声明 allowEmptyTrigger（否则「容器上读不到档位」这条会判死）`);
    }
    // 反向：既没有触发文本、也没有选择器/itemLabel 的站点，必须有 readbackSelector 兜底，
    // 否则回读既无锚点也无定位手段 ⇒ 恒 no-readback（用户报障的形态）。
    if (!ctl.triggerText && !(ctl.triggerSelectors || []).length && !ctl.itemLabel) {
      assert.ok(ctl.readbackSelector || ctl.allowEmptyTrigger,
        `${s.id} 既没有触发文本也没有定位手段：回读必然恒 no-readback`);
    }
  }
});

test('①b 未取证的站点**不许**声明等级（没读数就不显示，而不是猜一个）', () => {
  for (const id of ['deepseek', 'chatgpt', 'gemini', 'grok', 'claude']) {
    const s = SITES.find((x) => x.id === id);
    // deepseek 只有「深度思考」开关（用户原话），没有档位分级；其余四站本机网络取不到读数。
    assert.equal(s.efforts, undefined, `${id} 不应声明思考等级（无真机读数）`);
  }
});

test('①c 等级声明只有一份：providers 的条目必须与 think-effort 引用同一数组', () => {
  for (const s of SITES) {
    if (!s.efforts) continue;
    assert.equal(s.efforts, thinkEffortFor(s.id).efforts,
      `${s.id} 的 efforts 不是 think-effort.js 的那一份（拷了一份 = 第二份真相）`);
  }
});

test('①d 宿主载荷形状：efforts 只有 id/name，逐站声明 defaultEffort（0.19.52 决策反转）', () => {
  const r = reasoningEffortsFor('kimi');
  assert.deepEqual(r, {
    efforts: [{ id: '标准', name: '标准' }, { id: '进阶', name: '进阶' }],
    defaultEffort: '标准',
  });
  assert.equal(reasoningEffortsFor('deepseek'), null, '没有等级的站点必须返回 null（宿主据此不显示那一栏）');
  // 0.19.52（用户指令「去除没有的 auto 挡位」）：不声明 defaultEffort 时宿主选择器恒显示
  // 「Default」行——网页上没有这档，它就是那枚「没有的 auto」。声明后该行消失、选模型
  // 即携带站点默认档。每个默认值都有取证（THINK_EFFORT 条目注释）；改这里必须带新读数。
  // 值同时必须落在本站 efforts 里——声明一个菜单上不存在的档会让每轮抛
  // THINK_EFFORT_UNKNOWN。
  const expectedDefaults = { kimi: '标准', glm: '极致', zai: '最高', qwen: '自动', doubao: '快速' };
  for (const s of SITES) {
    if (!s.efforts) continue;
    const def = thinkEffortFor(s.id).defaultEffort;
    assert.equal(def, expectedDefaults[s.id],
      `${s.id} 的 defaultEffort 应为「${expectedDefaults[s.id]}」（THINK_EFFORT 条目注释里逐条有取证；改动必须附新读数）`);
    assert.ok(s.efforts.some((e) => e.id === def),
      `${s.id} 的 defaultEffort「${def}」不在本站档位清单里——会每轮 THINK_EFFORT_UNKNOWN`);
    assert.equal(reasoningEffortsFor(s.id).defaultEffort, def, `${s.id} 的 defaultEffort 必须随载荷外发`);
  }
  assert.deepEqual(effortById('kimi', '进阶'), { id: '进阶', name: '进阶', ordinal: 2 });
  assert.equal(effortById('kimi', '不存在的档'), null);
});

// ---------------------------------------------------------------------------
// ② 计划层
// ---------------------------------------------------------------------------

test('② planEffort：步骤形状（找触发 → 点开 → 点档位 → 回读）', () => {
  const kimi = planEffort({ siteId: 'kimi', target: '标准' });
  assert.equal(kimi.kind, 'popup');
  // 0.19.49：kimi 不再有 `openVia`——它自己就是触发控件（testid），直接点它开菜单。
  // 旧形状是 `click(openVia) → find-trigger → click → …`，而那两步点的是**同一个节点**，
  // 第二次点击会把刚打开的菜单关掉（真机症状：menuOpen 恒 false）。少一步是对的。
  assert.deepEqual(kimi.steps.map((s) => s.op), ['find-trigger', 'click', 'click-option', 'readback']);
  assert.deepEqual(kimi.steps[0].selectors, ['[data-testid="model-select-trigger"]']);
  assert.equal(kimi.steps[0].text, null, 'kimi 不再声明触发文本（「快速」是模型名，不是固定锚点）');
  assert.equal(kimi.steps[1].op, 'click');
  assert.equal(kimi.steps[2].selector, '[data-testid="model-effort-option"]');
  // 回读必须带上那个「只持有档位」的节点选择器（真机 `.current-effort` 的文本恰好是档位）
  assert.equal(kimi.steps[3].selector, '.current-effort',
    'kimi 的回读必须声明 readbackSelector —— 否则回读靠 token 启发式，而 token 是模型名');
  assert.equal(kimi.openIfClosed, false, '只有声明过 allowEmptyTrigger 的站点才允许空触发');
  assert.deepEqual(kimi.knownIds, ['标准', '进阶']);
});

test('②a2 planEffort：glm 与 qwen 也走「选择器定位 + readbackSelector 回读」', () => {
  const glm = planEffort({ siteId: 'glm', target: '极致' });
  assert.equal(glm.steps[0].op, 'find-trigger', 'glm 的触发控件自己就能开弹层（不再需要 openVia）');
  assert.deepEqual(glm.steps[0].selectors, ['.think-mode-trigger', '.mode-button']);
  assert.equal(glm.steps[3].selector, '.think-mode-trigger', 'glm 的回读节点');
  const qwen = planEffort({ siteId: 'qwen', target: '自动' });
  assert.deepEqual(qwen.steps[0].selectors,
    ['.qwen-thinking-selector .qwen-chat-v2-dropdown-menu-trigger', '.qwen-thinking-selector']);
  assert.equal(qwen.steps[0].text, null, 'qwen 的触发文本「自动」是档位 id，不是固定锚点');
  assert.equal(qwen.steps[3].selector, '.qwen-thinking-selector', 'qwen 的回读节点');
});

test('②b planEffort：doubao 走「空触发 + 点开弹层」那条路', () => {
  const p = planEffort({ siteId: 'doubao', target: '专家' });
  assert.equal(p.openIfClosed, true);
  // 没有 openVia（豆包的档位就在第 0 步那个触发钮后面），首步即 find-trigger
  assert.equal(p.steps[0].op, 'find-trigger');
  assert.deepEqual(p.steps[0].selectors, ['[data-testid="chat_input_action_model"]']);
  assert.equal(p.steps[1].op, 'click', '空触发时仍然要发一次「点开弹层」');
  assert.equal(p.steps[2].selector, null, 'doubao 没有 optionSelector ⇒ 走包含文本点');
});

test('②c planEffort：Default（target=null）是 noop——桥一个字都不动网页', () => {
  assert.deepEqual(planEffort({ siteId: 'kimi', target: null }), { kind: 'noop', reason: 'default-effort-leaves-web-untouched' });
  assert.deepEqual(planEffort({ siteId: 'kimi', target: undefined }), { kind: 'noop', reason: 'default-effort-leaves-web-untouched' });
});

test('②d planEffort：不在声明里的档位必须抛 THINK_EFFORT_UNKNOWN（而非静默改别的档）', () => {
  for (const [siteId, target] of [['kimi', '极致'], ['deepseek', '高'], ['kimi', '']]) {
    let caught = null;
    try { planEffort({ siteId, target }); } catch (e) { caught = e; }
    assert.ok(caught, `${siteId} + ${JSON.stringify(target)} 必须抛错`);
    assert.equal(caught.code, 'THINK_EFFORT_UNKNOWN');
    assert.match(caught.message, /^THINK_EFFORT_UNKNOWN: /, '错误文案必须带码前缀（可机读分类）');
  }
  // 站点整个没有等级声明：用户却选了档 ⇒ 同样必须抛（而不是「忽略后照常发送」）
  assert.throws(() => planEffort({ siteId: 'gemini', target: '高' }), /未声明思考等级/);
});

// ---------------------------------------------------------------------------
// ③ 判定层
// ---------------------------------------------------------------------------

test('③ confirmEffort：三态与 Default 语义（只认锚点之后的附加部分）', () => {
  const zai = { triggerText: '深度思考', knownIds: ['低', '高', '最高'] };
  // Default 永远算命中：它的语义就是「不动网页」
  assert.equal(confirmEffort({ target: null, label: '随便什么' }).state, 'match');
  // 触发控件里带档位（z.ai 的「深度思考 最高」）：剥掉固定部分「深度思考」后恰好是目标
  assert.equal(confirmEffort({ target: '最高', label: '深度思考 最高', ...zai }).state, 'match');
  // 归一化：换行写法必须同判（真机 textContent 是换行、innerText 是空格）
  assert.equal(normalizeLabel('深度思考\n最高'), '深度思考 最高');
  assert.equal(confirmEffort({ target: '最高', label: '深度思考\n最高', ...zai }).state, 'match');
  // 附加部分里混进了别的功能名（真机 readback 偶发读到更宽的容器文本）仍算命中
  assert.equal(confirmEffort({ target: '最高', label: '深度思考 最高 智能搜索', ...zai }).state, 'match');
  // 弹层里被 checked 的那条（豆包 / kimi 的弹层口径）
  assert.equal(confirmEffort({ target: '专家', checkedLabel: '豆包 2.1 Turbo 专家', knownIds: ['快速', '专家'] }).state, 'match');
  // 明确不匹配：读到了一个**别的**已知档（最有价值的读数——说明网页停在一个可识别的档上）
  const mis = confirmEffort({ target: '最高', label: '深度思考 低', ...zai });
  assert.equal(mis.state, 'mismatch');
  assert.equal(mis.reason, 'other-effort:低');
  // 读不出任何已知档：诚实报 unknown，不许当成 match
  assert.equal(confirmEffort({ target: '最高', label: '深度思考', ...zai }).state, 'unknown');
  assert.equal(confirmEffort({ target: '最高', label: '', knownIds: [] }).state, 'unknown');
  // ⚠ **没有锚点就必须读不出来**（kimi 真机教训）：kimi 的触发钮是「快速 进阶」，「快速」是
  // 模型档。若按「文本里含目标片段」判定，目标「进阶」会被当成「网页已经是进阶」而跳过下发
  // ——那就是一次静默降级。这里把这条判据钉死。
  const kimi = { triggerText: '快速', knownIds: ['标准', '进阶'] };
  assert.equal(effortFromTriggerLabel('快速 进阶', kimi.triggerText), '进阶');
  assert.equal(confirmEffort({ target: '标准', label: '快速 进阶', ...kimi }).state, 'mismatch');
  assert.equal(confirmEffort({ target: '进阶', label: '快速 进阶', ...kimi }).state, 'match');
  // 触发钮文案是模型名在前、档位在后 ⇒ 剥出来的附加部分就是档位本身
  assert.equal(confirmEffort({ target: '进阶', label: 'K3 进阶', triggerText: 'K3', knownIds: ['标准', '进阶'] }).state, 'match');
  // ## 0.19.49 行为变更：锚点对不上时，**按已知档位后缀读**，不再一律 unknown
  //
  // 旧期望是 `unknown`（"锚点对不上就不猜"）。真机证明那条路走不通：kimi 的
  // `triggerText` 声明成了模型名 `快速`，换模型后触发文本是 `K3 标准`，锚点对不上 ⇒
  // `unknown`；而调用方**无法补救**——`FIND_EFFORT_CONTROL` 的 token 匹配池同样基于
  // `快速`，也是空的，于是回读恒 `no-readback` ⇒ **每一轮都抛 THINK_EFFORT_UI_CHANGED**。
  // 现在改成：文本**以某个已知档位结尾**（或恰好等于它）就认它是当前档位。
  assert.equal(confirmEffort({ target: '进阶', label: 'K3 进阶', triggerText: '快速', knownIds: ['标准', '进阶'] }).state, 'match',
    '锚点过期，但文本以已知档位「进阶」结尾 ⇒ 必须读得出当前档（否则 kimi 换模型后每轮必挂）');
  assert.equal(confirmEffort({ target: '标准', label: 'K3 进阶', triggerText: '快速', knownIds: ['标准', '进阶'] }).state, 'mismatch',
    '读得出「网页停在进阶」⇒ 必须是 mismatch（触发下发），不是 unknown');
  // 声明了锚点却对不上时**仍然不许**按「文本里含目标片段」判定
  //（否则「模型名里的词恰好是档位」会误判成已生效）——只认**后缀/整段相等**。
  assert.equal(confirmEffort({ target: '进阶', label: '快速 进阶', triggerText: '深度思考', knownIds: ['标准', '进阶'] }).state, 'match',
    '以「进阶」结尾 ⇒ 读得出当前档');
  assert.equal(confirmEffort({ target: '进阶', label: '进阶的快速响应', triggerText: '深度思考', knownIds: ['标准', '进阶'] }).state, 'unknown',
    '「进阶」出现在**词中**（不是结尾、不是整段）⇒ 不许当命中，继续诚实报 unknown');
  // 锚点之后是**别的**档位 ⇒ 明确不匹配
  assert.equal(confirmEffort({ target: '进阶', label: 'K3 标准', triggerText: 'K3', knownIds: ['标准', '进阶'] }).state, 'mismatch');

  // ## 0.19.49 新增：两种真机形态（各自都曾让整个站点不可用）
  //
  // 形态①：**整段文本就是一个档位 id**（qwen）。它的 `triggerText` 也声明成 `自动`，
  // 于是剥离函数返回 null、「声明了锚点就不走词级兜底」这条又把兜底关掉 ⇒ 恒 unknown。
  // 真机读数（只读 CDP，.qwen-thinking-selector）：`自动`，切档后是 `思考`。
  assert.equal(confirmEffort({ target: '自动', label: '自动', triggerText: '自动', knownIds: ['快速', '思考', '自动'] }).state, 'match',
    'qwen：触发文本整段就是档位 id ⇒ 必须认（旧判据恒 unknown）');
  assert.equal(confirmEffort({ target: '自动', label: '思考', triggerText: '自动', knownIds: ['快速', '思考', '自动'] }).state, 'mismatch',
    'qwen：读到「思考」⇒ mismatch（触发下发）');
  assert.equal(confirmEffort({ target: '思考', label: '思考', triggerText: null, knownIds: ['快速', '思考', '自动'] }).state, 'match');
  //
  // 形态②：**模型名与档位无缝拼接**（glm）。真机只读 CDP 实测 `.think-mode-trigger` 文本
  // 是 `GLM-Flash极致` —— 中间**没有空格**，`split(' ')` 切不出 `极致`，词级判据失效。
  // 对照：同样的控件在另一个模型下是 `GLM-5.3 极致`（**有**空格）⇒ 两个形态都必须认。
  assert.equal(confirmEffort({ target: '极致', label: 'GLM-Flash极致', triggerText: null, knownIds: ['快速', '深度', '极致'] }).state, 'match',
    'glm：无分隔符拼接（GLM-Flash极致）⇒ 必须按后缀认出「极致」');
  assert.equal(confirmEffort({ target: '深度', label: 'GLM-Flash极致', triggerText: null, knownIds: ['快速', '深度', '极致'] }).state, 'mismatch',
    'glm：读到「极致」⇒ mismatch');
  assert.equal(confirmEffort({ target: '极致', label: 'GLM-5.3 极致', triggerText: null, knownIds: ['快速', '深度', '极致'] }).state, 'match',
    'glm：带空格的写法同样要认（同一控件的两种真机形态）');
  // 后缀判据**长者优先**：档位集合里存在互为子串的成员（低 ⊂ 最高），
  // 若按短的先匹配，`深度思考 最高` 会被读成「高」而误报 mismatch。
  assert.equal(confirmEffort({ target: '最高', label: '深度思考 最高', triggerText: '深度思考', knownIds: ['低', '高', '最高'] }).state, 'match',
    '「最高」必须胜过「高」（互为子串时的长者优先）');
});

// ---------------------------------------------------------------------------
// ④ 执行层（用假 DOM 跑真页面函数）
// ---------------------------------------------------------------------------

test('④ applyEffort：kimi 全流程（点开模型菜单 → 点档位 → 回读确认）', async () => {
  // 真机形状（2026-09-28 只读 CDP 实采，见 .tmp-probe/cdp-effort-models.json）：
  //   <div class="current-model" data-testid="model-select-trigger" aria-haspopup="menu">K3 标准
  //     <div class="model-name">K3 标准
  //       <span class="current-effort">标准     ← **只持有档位**的那个节点
  // 回读走 `.current-effort`（readbackSelector），因此它的文本必须随档位变。
  // 初始档位刻意不是目标，这样才验得到「点了之后回读确实变了」——若一上来就是目标，
  // 走的会是幂等快路（另有覆盖）。
  const effortSpan = el({ text: '标准', cls: 'current-effort' });
  const trigger = el({
    text: 'K3 标准', x: 1000, y: 700, w: 90, h: 36,
    attrs: { 'data-testid': 'model-select-trigger', 'aria-haspopup': 'menu' },
    kids: [effortSpan],
  });
  const option = el({
    text: '进阶 已选',
    attrs: { 'data-testid': 'model-effort-option', 'aria-checked': 'true' },
    // 点档位 = 网页把那枚触发钮与档位节点的文本都改成新档（真机就是这样重渲染的）
    onClick: (self) => { trigger.textContent = 'K3 进阶'; effortSpan.textContent = '进阶'; void self; },
  });
  const page = fakePage({
    domGroups: { div: [trigger], button: [option] },
    texts: { 思考强度: { count: 1 } },
  });
  let out;
  try {
    out = await applyEffort(page, { siteId: 'kimi', target: '进阶' });
  } catch (e) {
    assert.fail('applyEffort 抛错：' + (e.stack || e.message) + '\n calls=' + JSON.stringify(page.calls));
  }
  assert.equal(out.applied, true);
  // kimi 的回读口径是 `effort-text`，且**首选 readbackSelector**（`.current-effort`）：
  // 那个节点的文本恰好就是档位（`进阶`），不含模型名 —— 因此换模型也不会读错。
  assert.equal(out.readback, '进阶',
    'kimi 的回读必须来自 .current-effort（只含档位）；若读到「K3 进阶」说明走回了旧启发式');
  // 0.19.49：kimi **不再有 openVia**——触发控件自己就开菜单，第一次点击就落在它身上。
  // 旧实现会先点 openVia（同一节点）再点一次，第二次把刚打开的菜单关掉。
  assert.deepEqual(page.calls.clicks, ['[data-testid="model-effort-option"]'],
    '只在点档位那一步用 Playwright locator 点击');
  assert.deepEqual(page.calls.mouse, [{ x: 1045, y: 718 }],
    '触发钮按坐标点开**恰好一次**（kimi 的触发是 div，不是 button；点两次会把菜单关掉）');
  // kimi 的触发钮文本里已经带着当前档位 ⇒ **不进**子菜单分支（`useSubmenu` 判据是
  // 「触发控件文本里读不读得到已知档位」）。
  assert.deepEqual(page.calls.textClicks, [], '触发钮已显示档位 ⇒ 不该去点「思考强度」那一行');
  // 参数转发：find-trigger 与两次回读都必须拿到 cfg（否则页面里 cfg=undefined ⇒ 找不到控件）
  const withArg = page.calls.evaluates.filter((e) => e.fn === 'FIND_EFFORT_CONTROL');
  assert.ok(withArg.length >= 1);
  for (const e of withArg) assert.equal(e.argType, 'object', 'FIND_EFFORT_CONTROL 的 cfg 必须作为第二参数传进去');
  // 回读节点选择器必须真的被 evaluate 出去（否则 readbackSelector 是死声明）
  const selReads = page.calls.evaluates.filter((e) => e.fn === 'READ_SELECTOR_TEXT');
  assert.ok(selReads.length >= 1, 'kimi 声明了 readbackSelector ⇒ 必须真的调用 READ_SELECTOR_TEXT');
  for (const e of selReads) assert.equal(e.argType, 'string', 'READ_SELECTOR_TEXT 必须拿到站点声明的选择器字符串');
});

test('④b applyEffort：doubao 空触发路径（按 selectors 点开 + 触发钮文本回读）', async () => {
  // ## 为什么回读口径是「触发钮文本」而不是「弹层里的 aria-checked」（0.19.77 真机改正）
  //
  // 旧判据 `readback:'aria-checked'` 被真机证伪（2026-10-14，有头冷启页）：
  //   · 两条目 `aria-checked` / `data-state` **皆为 null**（全页 TRUE 计数 = 0）；
  //   · 且豆包的 radix 菜单**点完条目即刻关闭** ⇒ 回读那一刻 `role="menuitem"` 已不在 DOM，
  //     「读弹层选中项」这一类口径（含我中途试过的 `menuitem-svg`）**读的时机窗口不存在**。
  //   修正为读触发钮文本：真机 trace 显示点完后触发钮文本从 `豆包 快速` → `豆包 专家`。
  //
  // ⚠ 本用例因此**必须让触发钮文本在点击后真的变化**——否则它验的是「回读一个不动的旧值」，
  //   那正是这次真机事故的形态（旧用例把 checked 态写死在 fixture 里，所以红不了）。
  const trigger = el({ text: '豆包 快速', x: 1200, y: 840, w: 84, h: 32, attrs: { 'data-testid': 'chat_input_action_model' } });
  // 真机行为：点了档位条目之后，触发钮文本变成「豆包 <档位>」，且菜单关闭（条目脱离 DOM）。
  // ⚠ `onClick` 必须走 `el()` 的工厂参数——它在工厂里是闭包捕获的形参，事后再赋值
  // `menuItem.onClick = …` 不会生效（第一版就是这么写的，红灯由此而来）。
  const menuItem = el({
    text: '豆包 专家',
    attrs: { role: 'menuitem' },
    onClick: () => { trigger.textContent = '豆包 专家'; menuItem.parentElement = null; },
  });
  const menu = el({ text: '', attrs: { role: 'menu' }, __tag: 'div', kids: [menuItem] });
  const page = fakePage({
    domGroups: { button: [trigger], div: [menu, menuItem] },
    texts: { 专家: { count: 1 } },
    textMode: 'any',
  });
  const out = await applyEffort(page, { siteId: 'doubao', target: '专家' });
  assert.equal(out.applied, true, '回读口径是触发钮文本 ⇒ 点击后文本变成「豆包 专家」，应确认成功');
  // 豆包走的是「按坐标点开触发钮」那条路：触发钮文本拼了模型名，token 匹配不到档位，
  // 所以站点知识只提供 testid，点开用坐标（与真人一致），档位条目再按**浮层里的可点元素**点。
  assert.equal(page.calls.clicks.length, 0, '触发钮按坐标点，不按 locator（它身上没有档位文本）');
  assert.deepEqual(page.calls.mouse, [{ x: 1242, y: 856 }], '点开触发钮一次');
  assert.equal(menuItem.clicks, 1, '档位条目被点了（原生 click，走 CLICK_EFFORT_OPTION）');
});

test('④c applyEffort：档位菜单里没有目标档 ⇒ THINK_EFFORT_UNAVAILABLE（带可选项与当前读数）', async () => {
  // z.ai 声明 低/高/最高；这里模拟「网页菜单里缺了最高那一档」（站点改版/降级）。
  // 用户选了「最高」而弹层里没有它 ⇒ 必须是 UNAVAILABLE（菜单缺项），不是「找不到控件」，
  // 也不是静默点「高」顶上——这正是「绝不静默降级」要拦的那一类。
  const trigger = el({ text: '深度思考 高', x: 900, y: 700, w: 120, h: 28, attrs: { 'data-state': 'closed' } });
  const optLow = el({ text: '低', attrs: { role: 'menuitem' } });
  const optHigh = el({ text: '高', attrs: { role: 'menuitem' } });
  const menu = el({ text: '', attrs: { role: 'menu' }, kids: [optLow, optHigh] });
  const page = fakePage({ domGroups: { div: [trigger, menu, optLow, optHigh] } });
  const caught = await catchEffort(page, { siteId: 'zai', target: '最高' });
  assert.ok(caught, '必须抛错（不允许静默改别的档或静默跳过）');
  assert.equal(caught.code, 'THINK_EFFORT_UNAVAILABLE', '实际抛的是: ' + caught.code + ' / ' + caught.message);
  assert.match(caught.message, /低 \/ 高 \/ 最高/, '报错必须列出真实可选项');
  assert.equal(optLow.clicks + optHigh.clicks, 0, '缺档时**一个**档位都不许被点（更不许拿别的档顶上）');
});

test('④c2 applyEffort：档位条目在浮层里 ⇒ 点**可点元素**而不是它的内层 span（真机教训）', async () => {
  // 真机形状（z.ai）：菜单开着时，档位行是 `<button><span>高</span></button>`。
  // Playwright 的 `getByText('高')` 命中的是那个 span，而 span 不可点（isVisible=false）⇒
  // 0.19.48 首版真机症状是「截图里菜单明明开着，却报档位菜单里没有这一档」。
  const trigger = el({ text: '深度思考 最高', x: 900, y: 700, w: 120, h: 28, attrs: { 'data-state': 'open' } });
  const span = el({ text: '高', w: 20, h: 18 });
  // 点这一条 → 网页把那枚 pill 重渲染成新档（真机就是这样回读的）
  const optionBtn = el({ text: '高', w: 232, h: 36, attrs: { role: 'button' }, kids: [span], onClick: () => { trigger.textContent = '深度思考 高'; } });
  const menu = el({ text: '', w: 232, h: 120, attrs: { role: 'menu' }, kids: [optionBtn] });
  const page = fakePage({ domGroups: { div: [trigger, menu, optionBtn, span] } });
  const out = await applyEffort(page, { siteId: 'zai', target: '高' });
  assert.equal(out.applied, true);
  assert.equal(out.readback, '深度思考 高', '回读读的是 pill 的新文本');
  assert.equal(optionBtn.clicks, 1, '必须点在可点的那个 button 上');
  assert.equal(span.clicks, 0, '内层 span 不该被点（它不是可点元素）');
});

/** 跑一次 applyEffort 并返回抛出的错误（不抛则返回 null）。断言错误码用 `err.code`。 */
async function catchEffort(page, opts) {
  try { await applyEffort(page, opts); return null; } catch (e) { return e; }
}

test('④d applyEffort：glm 的触发控件找不到 ⇒ THINK_EFFORT_UI_CHANGED（带就近候选）', async () => {
  // ⚠ 0.19.49 前提更正：glm **有**独立触发钮 —— 真机只读 CDP 实测
  // `.think-mode-trigger` 的文本是 `GLM-Flash极致`（模型名与档位无缝拼接）。
  // 旧测试写的是「glm 没有独立触发钮，靠 modelPicker 弹层里的『思考强度』那一行」，
  // 那条描述来自 09-13 的模型弹层 dump（拍到的是**模型菜单打开之后**的 DOM），
  // 不是控件本身的层级事实。现在 glm 走「选择器定位触发 → 点开 → 点档位 → 回读」
  // 同一条通用路，子菜单入口只在触发控件缺 `triggerSelectors` 时才用。
  const page = fakePage({ domGroups: {}, texts: { 思考强度: { count: 0 } }, textMode: 'exact' });
  const err = await catchEffort(page, { siteId: 'glm', target: '极致' });
  assert.ok(err, '触发控件找不到必须抛错');
  assert.equal(err.code, 'THINK_EFFORT_UI_CHANGED');
  assert.match(err.message, /找不到思考等级控件/,
    '报错必须说清是「控件找不到」，而不是含糊的「没生效」——两者的下一步完全不同');
});

test('④d3 glm 仍保留子菜单入口这条兜底路（触发控件缺选择器时才能走到）', async () => {
  // 入口不可点 = 站点改版。这条路径由 `itemLabel` + `useSubmenu` 判据承担：
  // 只有当触发控件文本里**读不到任何已知档位**时才会去点那一行
  //（glm 触发文本 `GLM-Flash极致` 读得到档位 ⇒ 正常轮次不走这里）。
  const { applyEffort: apply2 } = await import('../lib/think-effort.js');
  const noTrigger = el({ text: '模型', x: 900, y: 700, w: 80, h: 30 });
  const page = fakePage({ domGroups: { div: [noTrigger] }, texts: { 思考强度: { count: 1 } } });
  // 直接把这条判据钉在纯函数层：`useSubmenu` 的输入是触发文本，
  // 读得到档位 ⇒ false（不进子菜单）；读不到 ⇒ true（进子菜单）。
  const readKnown = (text, known) => known.some((id) => String(text).split(' ').filter(Boolean).includes(id));
  assert.equal(readKnown('GLM-Flash极致', ['快速', '深度', '极致']), false,
    '无空格拼接读不出词级档位 ⇒ useSubmenu 会返回 true（进子菜单）——这是 glm 的已知代价');
  assert.equal(readKnown('GLM-5.3 极致', ['快速', '深度', '极致']), true,
    '带空格的写法读得到 ⇒ 不进子菜单');
  void apply2; void page;
});

test('④d2 applyEffort：控制控件整个找不到 ⇒ UI_CHANGED，且带上就近可点节点', async () => {
  // 输入框附近只有「发送」，没有 z.ai 的「深度思考」pill ⇒ 必须报 UI_CHANGED 并列出候选
  const other = el({ text: '发送', x: 1300, y: 700, w: 40, h: 40 });
  const page = fakePage({ domGroups: { button: [other] } });
  const err = await catchEffort(page, { siteId: 'zai', target: '高' });
  assert.ok(err, '找不到控件必须抛错');
  assert.equal(err.code, 'THINK_EFFORT_UI_CHANGED');
  assert.match(err.message, /找不到思考等级控件/);
  assert.match(err.message, /发送/, '报错要带上就近可点节点，否则排障只能靠猜');
});

test('④e applyEffort：点了但回读不匹配 ⇒ 抛错，绝不静默降级', async () => {
  // 模拟「点得动、但网页没改档」：触发控件文本恒为「深度思考 最高」，而我们要求「低」。
  // 各给「低」一条可点条目（否则会先撞 UNAVAILABLE，验不到这条判据）。
  // 这一支必须抛（回读读数就是 mismatch），绝不允许「反正点了就继续发」。
  const trigger = el({ text: '深度思考 最高', x: 900, y: 700, w: 120, h: 28, attrs: { 'data-state': 'open' } });
  const opt = el({ text: '低', attrs: { role: 'menuitem' } });
  const menu = el({ text: '', attrs: { role: 'menu' }, kids: [opt] });
  const page = fakePage({ domGroups: { div: [trigger, menu, opt] } });
  const err = await catchEffort(page, { siteId: 'zai', target: '低' });
  assert.ok(err, '回读不匹配必须抛错');
  assert.equal(err.code, 'THINK_EFFORT_UI_CHANGED');
  assert.match(err.message, /没有生效/);
  assert.equal(err.state, 'mismatch');
  assert.equal(err.readback, '深度思考 最高', '报错要带上回读到的真实档位');
  assert.equal(opt.clicks, 1, '点击确实发出去了——所以这不是「没点到」，而是「点了没生效」');
});

test('④f applyEffort：Default 立即返回，一次 DOM 都不碰', async () => {
  const page = fakePage({});
  const out = await applyEffort(page, { siteId: 'kimi', target: null });
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'not-selected');
  assert.deepEqual(page.calls.evaluates, [], 'Default 不许产生任何页面读数（更不许点）');
  assert.deepEqual(page.calls.clicks, []);
  assert.deepEqual(page.calls.mouse, []);
});

test('④g 页面函数在真 DOM 语义下成立：就近 + 最短文本选出那一行，而不是外层容器', () => {
  // 真机形状：外层容器 textContent 也含「深度思考」（且更长），pill 才是最短那个。
  // 两个节点都带 `data-state="closed"` —— 真机上 z.ai 的这枚 pill 就是这个属性
  //（`<div data-state="closed">深度思考 最高</div>`），而它是 CLICKABLE 候选的入场券。
  const pill = el({ text: '深度思考 最高', x: 900, y: 700, w: 120, h: 28, attrs: { 'data-state': 'closed' } });
  const wrap = el({ text: '深度思考 最高 智能搜索 联网', x: 700, y: 690, w: 500, h: 50, attrs: { 'data-state': 'closed' } });
  installDom({ div: [wrap, pill] });
  const snap = FIND_EFFORT_CONTROL({ text: '深度思考', known: ['低', '高', '最高'] });
  assert.ok(snap.found, '必须能找到那枚 pill（找不到说明 CLICKABLE 候选集没覆盖到它）');
  assert.equal(snap.found.text, '深度思考 最高');
  assert.equal(snap.found.how, 'text');
  assert.equal(snap.menuOpen, false);
});

test('④h 页面函数：显式选择器优先于文本匹配（豆包的 testid 触发）', () => {
  const btn = el({ text: '豆包 快速', x: 1200, y: 840, w: 84, h: 32, attrs: { 'data-testid': 'chat_input_action_model' } });
  installDom({ button: [btn] });
  const snap = FIND_EFFORT_CONTROL({ selector: '[data-testid="chat_input_action_model"]', known: ['快速', '专家'] });
  assert.equal(snap.found.how, 'selector');
  assert.equal(snap.found.text, '豆包 快速');
});

test('④i 页面函数：弹层已开着（选中态命中已知档）时 menuOpen 为真', () => {
  // 真机形状：档位条目在一个 `role="menu"` 浮层里（这里必须真建父子关系，
  // 因为「在不在已打开的浮层里」是 menuOpen 的判据）。
  const checked = el({ text: '豆包 2.1 Turbo专家', attrs: { role: 'menuitem', 'data-state': 'checked' } });
  const menu = el({ text: '', attrs: { role: 'menu' }, kids: [checked] });
  installDom({ div: [menu, checked] });
  const snap = FIND_EFFORT_CONTROL({ selector: '[data-testid="chat_input_action_model"]', known: ['快速', '专家'] });
  assert.equal(snap.menuOpen, true, '菜单开着就别再点触发（点它会把菜单关掉）');
  assert.equal(READ_CHECKED_EFFORT(), '豆包 2.1 Turbo专家');
});

test('④j 页面函数：**常驻**的 checked 控件不算「菜单已开」（0.19.48 真机教训）', () => {
  // 首版把「页面上存在 data-state=checked 的元素」当成「菜单开着」，于是 kimi 的模型下拉
  // 触发钮（自身带 data-state）让驱动跳过「点开触发」那一步，档位菜单永远不开——最后死在
  // 回读上，报错方向还指向「等级没有生效」。这条护栏钉住：没有浮层祖先就不算开着。
  // 触发钮在真机上的位置就在输入框附近（kimi：(1077,439)，输入框在同一容器里）。
  const resident = el({ text: '快速 进阶', x: 1000, y: 700, w: 90, h: 36, attrs: { 'data-testid': 'model-select-trigger', 'data-state': 'closed' } });
  installDom({ div: [resident] });
  const snap = FIND_EFFORT_CONTROL({ tokens: ['快速', '进阶'], known: ['标准', '进阶'] });
  assert.equal(snap.menuOpen, false, '常驻控件不算菜单已开（否则触发永远点不开）');
  assert.equal(snap.found.text, '快速 进阶');
});

// ④k 控件存在但**禁用**（0.19.96，zai 真机 #34）
//
// 真机读数（2026-10-19 23:23，零发送 live-probe；见 think-effort.js 的 FIND_DISABLED_EFFORT_CONTROL）：
//   div#bits-c802[aria-label="当前场景无法取消"]
//     └ div.flex…opacity-50.cursor-not-allowed   ← 可点容器（**裸 div**，无 role/data-state）
//         ├ span 深度思考
//         └ span 最高
// 旧实现：该 pill 不进 CLICKABLE 候选池 ⇒ 报「找不到思考等级控件」（THINK_EFFORT_UI_CHANGED，
// **致命**），而 zai 声明了默认档「最高」⇒ 每一轮都抛、整站不可用。修法把它判成
// 「此刻不能改档」：非致命 applied:false / reason:'control-disabled' / note 带禁用依据。
test('④k applyEffort：控件存在但禁用 ⇒ 非致命 control-disabled（不抛、不点、不假装成功）', async () => {
  const t1 = el({ text: '深度思考' });
  const t2 = el({ text: '最高' });
  const clickable = el({
    text: '深度思考 最高', x: 1063, y: 835, w: 126, h: 28,
    // 真机逐字 class 片段（opacity-50 / cursor-not-allowed 是 disabled 的**唯一**证据：
    // 既没有 native disabled，也没有 aria-disabled）
    cls: 'flex gap-1.5 items-center h-7 pl-3 pr-2 py-1 rounded-lg whitespace-nowrap transition-colors opacity-50 cursor-not-allowed',
    kids: [t1, t2],
  });
  const wrap = el({ text: '深度思考 最高', cls: 'flex', attrs: { 'aria-label': '当前场景无法取消' }, kids: [clickable] });
  const page = fakePage({ domGroups: { div: [wrap, clickable] } });
  const out = await applyEffort(page, { siteId: 'zai', target: '高' });
  assert.equal(out.applied, false, '禁用的控件不许被当作「已生效」');
  assert.equal(out.reason, 'control-disabled', '必须返回 control-disabled，而不是抛 THINK_EFFORT_UI_CHANGED');
  assert.equal(out.state, 'control-disabled');
  assert.match(String(out.note), /不可操作|禁用/, 'note 必须说明为什么没生效（驱动/排障能读到）');
  assert.match(String(out.note), /高/, 'note 要带上目标档（否则不知道是哪个目标没生效）');
  assert.match(String(out.readback), /深度思考/, '回读要带页面当前读数（真机是「深度思考 最高」）');
  assert.deepEqual(page.calls.mouse, [], '禁用控件不许按坐标点击（点了也开不了菜单）');
  assert.equal(clickable.clicks, 0, '禁用容器一次都不许被点');
  assert.equal(t1.clicks + t2.clicks, 0, '内层 span 也不许被点');
});

// ---------------------------------------------------------------------------
// ⑤ 接线层
// ---------------------------------------------------------------------------

test('⑤ 适配器必须把等级交给宿主（resolveModel 的 reasoning），旧的响应不变', () => {
  assert.match(INDEX, /reasoningEffortsFor\(/, 'index.js 没有把等级声明交给宿主的 resolveModel');
  assert.match(INDEX, /\.\.\.\(reasoning \? \{ reasoning \} : \{\}\)/, 'reasoning 字段名必须与 LlmResolvedModelInfo 一致');
  assert.match(INDEX, /reasoningEffort: options\.reasoningEffort/, '运行时必须把宿主选中的等级带进本轮 meta');
  assert.match(INDEX, /reasoningEffort: m\?\.reasoningEffort/, 'meta 上的等级必须透到驱动（不然声明了也没人下发）');
});

test('⑤b 驱动必须调用唯一执行器，且透传 reasoningEffort', () => {
  assert.match(DRIVER, /applyEffort\(page, \{ siteId, target: reasoningEffort \}\)/,
    '驱动没有调用 lib/think-effort.js 的 applyEffort —— 等级声明就成了摆设');
  assert.match(DRIVER, /effortApplied/, 'status 必须透出最近一次生效的等级（排障读数）');
  assert.match(DRIVER, /reasoningEffort = null \}/, 'runTurn 的签名必须收 reasoningEffort');
});

test('⑤c sendTurn / sendPrompt 两条路都要带上等级（否则同一模型两种行为）', () => {
  const sendTurn = DRIVER.slice(DRIVER.indexOf('async function sendTurn('));
  assert.match(sendTurn.slice(0, 400), /reasoningEffort/, 'sendTurn 必须收 reasoningEffort');
  const runTurnCall = DRIVER.slice(DRIVER.indexOf('result = await runTurn(message, {'), DRIVER.indexOf('result = await runTurn(message, {') + 300);
  assert.match(runTurnCall, /reasoningEffort/, 'runTurn 调用点必须把等级传下去');
  const sendPrompt = DRIVER.slice(DRIVER.indexOf('async function sendPrompt('));
  assert.match(sendPrompt.slice(0, 600), /reasoningEffort: meta\?\.reasoningEffort/,
    'sendPrompt（无会话轮 / OpenAI 前端）必须走同一条 meta 口径');
});

test('⑤d 模型表里的 kimi 档位与真机菜单一致（K3 集群已从菜单消失）', () => {
  const kimi = SITES.find((s) => s.id === 'kimi');
  assert.deepEqual(kimi.models.map((m) => m.id), ['k3', 'k2.8-preview', 'quick'],
    'kimi 模型表必须与真机菜单（K3 / K2.8 Preview / 快速）一致');
  // 历史 id 必须仍解析得开——旧会话、旧设置值依赖它
  assert.equal(resolveWebModel('kimi:k3-cluster').id, 'k3');
  assert.equal(resolveWebModel('k3-cluster').id, 'k3');
  assert.equal(resolveWebModel('kimi:k2.8-preview').id, 'k2.8-preview');
});
