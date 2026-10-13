# Runbook：抓 z.ai（chat.z.ai）的真实 completion 帧

本文件回答一个问题：**长期问题 #30「Z.ai 真实流帧格式未录制」到底怎么拿到帧。**

它是 `lib/providers.js`（ZAI 条目「decoder 现状」那段注释）与
[`../long-term-issues.md`](../long-term-issues.md) §30 共同引用的落点。
那条引用的**形状本身**是本文件存在的原因，见 §4。

| 项 | 读数 / 位置 |
| --- | --- |
| 登记条目 | [`../long-term-issues.md`](../long-term-issues.md) §30 |
| 探针（入库） | [`../../package/dsh-webcode-bridge/test-mock/zai-capture-frames.mjs`](../../package/dsh-webcode-bridge/test-mock/zai-capture-frames.mjs) |
| 被谁引用 | `lib/providers.js` 的 ZAI `decoder` 注释、§30 正文 |
| 卡在哪 | **人的一次手动过闸**（站点风控 `enable_captcha`，见 §30 与 [`../long-term-issues.md`](../long-term-issues.md) §29） |
| 当前状态 | 工具已就绪；**真机帧仍未取得**（未取得的原因见 §2，不是脚本坏） |

---

## 1. 为什么需要人（先看这条，否则会以为脚本坏了）

z.ai 自带风控闸：站点前端在**发出 completion 请求之前**先 `await HN()`（阿里云滑块验证），
验证没过就直接 `return`——`POST /api/chat/completions` **根本不存在于 wire 上**。
所以「抓不到帧」的直接原因是**请求没发**，不是捕获层没绑上。

⇒ 探针必须在**有头窗口**里跑，由人把滑块拖过去；帧会立刻落盘。
无人值守跑只会得到 `frames=0`，探针会如实写进 `summary.verdict`（`NO_FRAMES`）而**不是**报成功。

> 一条不要下错的结论：站点风控**不是本项目能在代码里绕过的**。绕过它等于破解站点风控，
> 本项目不做。我们能做且已经做的是**被拦时立刻如实说「被风控拦了」**（`WEB_CAPTCHA_REQUIRED`），
> 而不是等 120s/240s 再报一句由假读数拼出来的 `WEB_NO_PROGRESS`。

---

## 2. 跑法（三步）

### 2.1 准备一份「已登录 chat.z.ai」的**副本** profile

不要用桥自己的 profile：它会被 DSH 启动的那个浏览器独占，`Network/Cookies` 复制会稳定
`EBUSY`（§30 实测 3/3），在它上面再开浏览器等于和运行中的桥抢同一个账号。

副本的两个硬要求：

1. **已登录**：profile 里要有 `chat.z.ai` 的登录态（cookie + localStorage）。
   登录态可以用只读 CDP（`Storage.getCookies`，不 enable 任何 domain）从活着的桥浏览器里取，
   再播种到副本；**不要**直接复制活 profile 的目录。
2. **剔除 `webcode-bridge.lock.json`**：否则驱动侧会判 `BRIDGE_ACCOUNT_BUSY`。

副本放在 `package/dsh-webcode-bridge/test-mock/.zai-probe-profile`（默认值，
被 `.gitignore` 的 `test-mock/.*-profile*/` 覆盖，与其它真机探针同一口径），
或任意路径 + `PROBE_PROFILE` 指过去。

### 2.2 有头跑，人肉过闸

```powershell
cd D:\9_Code_Workspace\dsh-webcode-bridge
$env:PROBE_HEADED='1'
$env:PROBE_WAIT_MS='180000'
node package/dsh-webcode-bridge/test-mock/zai-capture-frames.mjs
```

探针会在**有头窗口**里：打开 chat.z.ai → 点开一个**既有会话**（不新建，避免触发新建接口的
风控）→ 装只读 fetch tee → 用 `providers.js` 里 zai 声明的同一组选择器填字并发送 →
停在页面上等你过闸。**弹滑块时在窗口里拖过去**，帧会自动落盘。

### 2.3 读产物

产物在 `package/dsh-webcode-bridge/test-mock/out/zai-capture/<时间戳>/`：

| 文件 | 读什么 |
| --- | --- |
| `summary.json` | `verdict`（`GOT_FRAMES` / `NO_FRAMES`）、`frames.count`、`frames.topKeys`、`decoders`（现成 decoder 各解出多少）、`dom`（正文/风控现场）、`network`（有没有 `/api/chat/completions`） |
| `raw-stream.log` | **原始帧字节**（逐字）。这是要搬进夹具的那份 |
| `page.png` | 当轮页面截图 |

**判读口诀**：`network` 里**没有** `/api/chat/completions` ⇒ 风控挡在发送之前（重跑并过闸）；
**有**但 `frames.count=0` ⇒ 捕获层问题（这时才值得查 tee）。

`test-mock/out/` 被 `.gitignore` 覆盖——它是**每次跑都变**的产物，不是证据本体。
要留档的帧必须**逐字**搬进 `test/fixtures/`（会话 id 可脱敏），见 §3。

---

## 3. 拿到帧之后（这一步不在本 runbook 之外，就是 #30 的关闭条件）

1. 把 `raw-stream.log` 的**逐字**片段（脱敏 `id`）存进
   `test/fixtures/zai-real-frames/`；
2. 按 `providers.js` 注释里的字段表新增 **zai 专属 decoder kind**（`lib/decoder.js`）——
   语义要点：**`delta_content` 是增量、`content` 是全量快照**，两者混用必须走前缀差分，
   否则整段会播两遍（与 #21「SET 重发吞掉流式增量」同一族坑）；
3. 写护栏断言：新 decoder 能解出正文**且不重复**。缺了「不重复」那半条，
   「整段播两遍」会安静地通过；
4. 把 `providers.js` 的 `decoder: 'openai-sse'` 换成新 kind —— 在夹具与护栏落地**之前不要改**：
   现状是「已知解不出」，换成另一个同样解不出的 kind 是「猜着解不出」，更糟；
5. 回写 §30 与 `CHANGELOG.md`，并**如实**写清哪些是真机读数、哪些仍是代码推断。

---

## 4. 一条副作用纪律（本文件为什么在 `doc/`）

本文件的抓帧步骤原先只存在于 `.tmp-probe/zai/RESULT.md`，而 `.tmp-probe/` 被 `.gitignore:61`
覆盖 ⇒ **对克隆仓库的人不存在**。同时 `lib/providers.js` 与 §30 的正文都在叫读者去那里取步骤。

这正是本仓库明令禁止的形态（[`../../wiki/protocol.md`](../../wiki/protocol.md) §5、
[`../../AGENTS.md`](../../AGENTS.md) §1）：**「外面没有它就理解不了」的信息必须放在入库处**
（`doc/` 或随包发布的源码）。本仓库此前记过 4 次同类事故，判据是：

> 入库文件（`lib/`、`doc/`、`README*`）里**不得**出现指向 `.tmp/`、`.tmp-*`、`.tmp-probe/`、
> `PLAN*.md`、`REPORT.md` 这些**被 gitignore 且有实质内容**的路径的引用；
> 要么把内容搬进入库处，要么把引用改掉。

§30 与 `providers.js` 的注释已按此条改为指向本文件与
`test-mock/zai-capture-frames.mjs`。
