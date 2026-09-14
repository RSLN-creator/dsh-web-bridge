# 教程：手机连接 DSH（dsh-local-link）

本文件是**入库长期文档**，记录手机连接插件的选型依据、安装、配对与安全边界。
取证口径：包身份与兼容性来自 npm registry 元数据与包内已发布的 `README.md`；
选型对比来自 `.tmp-plugins.json`（awesome-dsh-plugin.com 快照）+ 逐个 npm 查询。

安装与验证时间：2026-09-14。目标 profile：`web`。

## 1. 选型结论

**装 `dsh-local-link@1.1.1`。**

| 项 | 值 |
| --- | --- |
| npm 包 | `dsh-local-link` |
| 版本 | `1.1.1`（latest；shasum `01c8a8a0ff42e5b39923244cbd03b2d5b31e14d2`） |
| 仓库 | `github.com/donoteatme/dsh-local-link` |
| 作者 | DoNotEatMe |
| 许可证 | MIT |
| 体量 | 22 文件 / 1.47 MB 解包 |
| 运行时依赖 | 只有两个：`qrcode`、`@deepseek-ai/schemastery` |
| engines | `^22.19.0 \|\| >=24.0.0`（本机 node v24.18.0 ✓） |
| 最近更新 | 2026-09-12 |
| 供应链 | 带 SLSA provenance（GitHub Actions OIDC 发布） |

### 决定性理由：它点名兼容本机核心版本

它的 peer 里显式枚举了 `@deepseek-ai/dsh-host-webserver`：

```
0.1.0-rc.8 || 0.1.1-rc.2 || 0.1.2-rc.1 || 0.1.5-rc.1 || 0.1.5-rc.2
```

`0.1.5-rc.1` **就在列表里**，正是本机版本。包内 README 的兼容表也写明：

| DeepSeek Harness | Local Link 状态 |
| --- | --- |
| `0.1.5-rc.2` | Verified next |
| **`0.1.5-rc.1`** | **Supported release（开发基线）** |
| `0.1.2-rc.1` | Verified |
| `0.1.1-rc.2` / `0.1.1-rc.1` / `0.1.0-rc.8` | Verified |

README 还说明这六行是用 **packed 1.1.1 源码**逐个核对的，每行都过了
「隔离 profile 组合、插件 peer 检查、配对、带认证的 HTTP 与 WebSocket 流量、
撤销后立即关闭 socket、拒绝已撤销设备」，`0.1.5` 那两行还额外做了
`390 × 844` 真实客户端响应式检查。

**这是本次选型里唯一一个对本机核心版本给出明确、可核对兼容声明的候选。**

## 2. 落选候选与理由

同一 category（`remote`，远程与移动端）下的候选非常多，逐个核对后的结论：

| 包 | 版本 | 落选理由 |
| --- | --- | --- |
| `dsh-remote-plugin` | 0.6.24 | 依赖**配套原生 Android App**；含 systemd 独立单元（Linux 取向）；11 MB |
| `dsh-plugin-mobile-gateway` | 0.7.4 | 依赖**配套原生 iOS 客户端**；5 MB |
| `dsh-webui-mobile` | 0.4.4 | 只是移动端 CSS 外壳（抽屉/FAB/输入框修复），**不提供远程访问**；不解决「手机怎么连上」 |
| `dsh-gateway` | 1.7.0 | 通用 HTTPS + 登录网关，**没有二维码配对**；面向「从另一台机器访问」，配对体验弱 |
| `dsh-plugin-qr-connect` | 0.1.3 | 形态对口（二维码 + 反向代理），但 2026-08-24 后未更新，且 peer 范围是老的 `^0.1.0-rc.6` |
| `dsh-mobile-pwa` | 0.1.0 | 单一首发版本、已停滞（2026-08-15） |
| `dsh-weave` | 0.1.0-rc.15 | 基于 Iroh 的网状网络，是**跨主机**方案，比「局域网手机访问」重得多 |
| `github:Bernardxu123/dsh-mobile-gate` 等 | — | 未发布到 npm，只能从 GitHub 装，供应链上不可核对 |

选型原则：**优先「浏览器优先 + 仅局域网 + 一次性配对」，避免引入配套原生 App 与云中继**。
`dsh-local-link` 明确把这些写成 non-goals（不暴露公网、不做托管中继、不做云账号、
不做独立原生 App、不做替换版聊天客户端）。

## 3. 安装

```powershell
$env:NODE_OPTIONS='--use-system-ca'
dsh plugin --profile web add 'dsh-local-link@1.1.1'
dsh web
```

装完核对 `dsh.profile.bundles` 里出现了 `dsh-local-link`：

```powershell
(Get-Content "C:\Users\rsyhn\.dsh\profiles\web\package.json" -Raw | ConvertFrom-Json).dsh.profile.bundles
```

离线组合验证（不重启）：

```powershell
# 应看到 "# == dsh-local-link" 层，含 id: dsh-local-link
dsh --profile web --dump-config
```

## 3.5 二维码到底在哪（用户实测找不到，2026-09-14 补）

这是本轮**最高优先级的排查结论**。二维码不是独立悬浮入口，**藏在一个弹出层里**，触发点很隐蔽。

### 位置

**左侧边栏最底部**的一颗按钮（图标 + 文字），点开才弹出二维码浮层。

从已发布的 `lib/client.js` 读出的确切事实：

- 它注册在 DSH 官方侧栏槽位 **`sidebar.footer.action`**，id `local-link-connect`，`order: -10`。
- 官方侧栏把该槽渲染在 **footArea** 里（`sidebar.settings` 之**上**）。
- 触发按钮的**文字标签只在侧栏展开时渲染**：
  `wide && <span className="dsh-local-link-trigger__label">{t("footer.trigger")}</span>`。
  → **侧栏折叠时只剩一个图标，看不到「Local access」字样**。这是「找不到」的第一大原因。
- 点开后二维码在 `.dsh-local-link-popover` 浮层里，`<img className="dsh-local-link-popover__qr" src={pairing.qrDataUrl}>`。

### 三个必须先满足的前提

1. **必须重启过 `dsh web`**（插件才注册 host 侧网关与 client 贡献）。
2. **浏览器页面必须刷新**（client 侧 `client.js` 是页面加载时注入的；装完插件没刷新的标签页不会有这个按钮）。
3. **必须在桌面本机打开**：`desktopOrigin()` 要求 hostname ∈ {`localhost`, `127.0.0.1`, `::1`}。
   用局域网 IP 打开桌面页时，这个入口**和**设置页里的 `Local access` 分区**都会隐藏**。

### 怎么确认它真的活着（本机实测通过）

```powershell
# 1) 网关端口应在监听
Get-NetTCPConnection -LocalPort 3088 -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess
# 2) 直接打配对接口：应返回 201，且 body 里有 qrDataUrl
Invoke-WebRequest 'http://127.0.0.1:3080/__dsh-local-link/admin/pairing' -Method POST `
  -Body '{"sessionId":"probe"}' -ContentType 'application/json' -UseBasicParsing |
  Select-Object -ExpandProperty Content
```

本机 2026-09-14 实测：

```
3088  Listen  0.0.0.0  OwningProcess=36232   # 与 3080 同一个 node 进程
POST /__dsh-local-link/admin/pairing  ->  201
{"id":"brKFgHStt9WdECsF",
 "url":"http://172.22.73.74:3088/__dsh-local-link/pair#token=…&session=…",
 "expiresAt":"2026-09-14T09:59:43.396Z",
 "qrDataUrl":"data:image/png;base64,iVBORw0KGgo…"}
```

即：**后端完全正常**，二维码数据已经生成，只是前端触发点不显眼。

### 找不到时的处置顺序

1. **展开左侧边栏**（否则只有图标）→ 看最底部。
2. 刷新页面（Ctrl+Shift+R）。
3. 确认地址栏是 `127.0.0.1:3080`（不是局域网 IP）。
4. 仍然没有 → 用上面的两条命令验证后端；后端 201 说明是前端注入问题（重启 + 硬刷新）。
5. 备选入口：**设置 → `Local access`**（同一个 `desktopOrigin()` 门槛；
   它注册在 `settings.section`，id `local-access-devices`，`order: 12`）。

### 诊断记录长什么样

`~/.dsh/local-link/diagnostics.json`：

```json
{ "version": 1, "events": [
  { "level": "warn", "code": "REQUEST_REJECTED", "context": { "reason": "untrusted_source" } } ] }
```

注意：诊断是**事件驱动的失败历史，不是请求日志**；成功启动/请求/配对/复制/重命名/撤销**都不记录**。
所以「空诊断」= 没有失败，**不等于**插件没工作。

## 4. 用起来：三步

1. 在电脑上打开你想在手机上继续的那个会话。
2. 点 Harness 侧栏底部的 **`Local access`**。
3. 用手机扫二维码，或把一次性链接复制到同网络的另一台设备。

**第一个使用邀请的浏览器**会打开**原版** Harness 客户端，并落在你刚才选中的那个会话上。

- 邀请是**一次性**的，默认 **5 分钟**过期；点 `Generate another code` 会立刻换掉旧码。
- 手机/平板浏览器在视口宽度 **≤ 834 CSS px** 时**自动**进入 Mobile View，
  不需要 URL 参数、不需要切 UA、也不是第二个客户端。

## 5. Mobile View 改了什么

| 原版窄屏行为 | Mobile View（1.1.x） |
| --- | --- |
| 桌面导航和对话抢空间 | 工作区与会话导航变成**可关闭的左侧抽屉** |
| 会话元信息挤占标题栏 | 上下文、模型、访问权限、预设、活动、导出移进**紧凑右抽屉** |
| 子代理信息太密够不到 | 总数/活跃数留在输入区附近，原生目录变**底部弹层** |
| 会话/工作区操作依赖 hover | 溢出操作**常驻可见**、可触摸 |
| 切会话会弹软键盘 | **抑制**自动聚焦输入框，但主动点击输入仍正常 |
| 桌面间距无视安全区 | 头部、输入区、标签、媒体、浮层、滚动都适配窄视口 |

实现上它是**只改呈现、不改归属**：原版 AppFrame 仍挂载，
动态 Chat / Trajectory / 输入区 / 浮层 / 第三方插件插槽全部保留。
移动端导航里**故意省略**桌面专属的 Settings 与嵌套的 Local access 动作。

响应式目标视口 **360–834 CSS px**，发布矩阵检查 `360×800`、`390×844`、
`430×932`、`768×1024`。

## 6. 管理已配对设备

在**电脑上**，用二维码面板里的 `Paired devices`，或打开 `Settings → Local access`。

- 每个新浏览器初始名为 `My device`，副标题自动识别（如 `Phone · Chrome`、
  `Tablet · Safari`、`Computer · Edge`；笔记本与台式机都显示 `Computer`，浏览器分不出来）。
- `Rename` **只改显示元数据**。
- `Revoke` 让该浏览器凭据失效，并**立刻关闭**它所有开着的 Local Link WebSocket 连接。
- 清了 cookie、隐私窗口、换浏览器 profile、或被撤销的设备，**都需要新的邀请**。

## 7. 配置项（bundled profile patch 的保守默认）

| 选项 | 默认 | 用途 |
| --- | --- | --- |
| `listenHost` | `0.0.0.0` | 监听本机各接口；请求校验仍只接受私有/回环来源 |
| `listenPort` | `3088` | 局域网网关端口 |
| `upstreamOrigin` | `http://127.0.0.1:3080` | 已有的回环 Harness Web 服务 |
| `accessMode` | `pairing` | 要求一次性邀请 + 设备 cookie |
| `pairingTtlSeconds` | `300` | 邀请有效期 |
| `deviceTtlDays` | `90` | 已记住浏览器的有效期 |
| `diagnosticsEnabled` | `true` | 保留有界本地诊断历史 |
| `diagnosticsMaxEntries` | `15` | 最多保留事件数（可 5–200） |
| `diagnosticsFile` | 与 `stateFile` 同目录 | 本地 JSON 事件存储 |
| `stateFile` | — | 已配对设备状态（`~/.dsh/local-link/devices.json`） |

- `listenHost` **只接受** `0.0.0.0` 或明确的私有/回环 IP 字面量；
  公网监听地址在**启动时就被拒绝**。这是配置层守卫，**不替代**操作系统防火墙。
- `trusted-lan` 会**关掉按设备授权**，只应留给隔离的开发网络。
  默认的 `pairing` 才是受支持的形态——因为连上来的 Harness 浏览器**能读文件、
  提交提示词、批准动作、触发命令**。

## 8. 它是怎么工作的（以及为什么安全边界是这样）

```text
桌面浏览器 127.0.0.1:3080
  └─ Local access → 一次性邀请
                         │
同私有网络的手机 / 平板 / 电脑
  └─ 192.168.x.x:3088 → 网络 + Host 校验
                       → 配对或设备 cookie 校验
                       → HTTP / WebSocket 代理
                       → 127.0.0.1:3080（同一个 Harness Host）
```

关键性质：

- 网关**不创建第二个 Harness 会话**。首次连接时它把桌面浏览器**当前选中的会话**
  转移给新的浏览器源；会话数据与进行中的对话事件仍来自**同一个 Host**。
- 授权用 **256 位随机 cookie 凭据**，服务端只存它的 **SHA-256 哈希**。
  可编辑的名字与自动识别的设备/浏览器文本**永不授予访问权**（不做指纹识别）。
- 局域网权限是通过 Harness **官方的 `connection.trustedHosts` 契约**声明的——
  这让带认证的会话 API 与 WebSocket 流量能工作，**而不是**假装手机是回环。
  patch 里那一行是：

  ```yaml
  - id: connection
    inject: [webRuntime, localLinkGateway]
    config:
      trustedHosts: !!js "[...ctx.webRuntime.trustedHosts, ...ctx.localLinkGateway.trustedHosts]"
  ```

- **Settings、凭据、原生 Host 动作、agent-preset 编写仍然是回环专属**，远程拿不到。
  在 `0.1.2-rc.1` 与已核验的 `0.1.5` 构建上，传输整体认证，因此 Local Link 自己会拒绝
  这些 RPC。
- 远程浏览器**继承所选会话的权限**（Read only / Workspace write / Full access）。
  Mobile View **只显示**这个值，**不创建也不削弱**权限层。

## 9. 安全边界（务必读懂）

> **网关走明文 HTTP，只适用于可信私有网络。不要把它暴露到互联网，不要在公共 Wi-Fi 上用。**

- 局域网流量**不加密**——这是**有记录的已知限制**，不是「支持的公网部署」。
- 插件**从不创建防火墙规则**。Windows 弹网络访问提示时，**只允许 Private 网络配置**，
  **绝不要**在路由器上做 3088 端口转发。
- 撤销会阻止新请求与重连，并终止该设备的每条已认证 Local Link WebSocket。

## 10. 诊断

诊断是**本地的、事件驱动的失败历史，不是请求日志**。默认保留 15 条、显示最新 12 条、
五秒内的相同事件会合并；成功启动、请求、配对、复制、重命名、撤销**都不记录**。

排查流程：

1. 复现失败动作**一次**。
2. 打开 `Settings → Local access → Diagnostics`。
3. 面板已开着就点 `Refresh`。
4. 用**最新的稳定事件码**定位失败的边界。
5. 点 `Copy report`，审阅 JSON，需要时附到 issue 里。

报告**绝不包含**密钥、地址、ID、名字、URL、路径、提示词、对话或项目数据，
也**绝不自动上传**。

## 11. 已知限制

- 局域网流量不加密（明文 HTTP）。
- 从远程浏览器做的浅色/深色选择在受支持的 Harness 构建上是**页面级**的；
  刷新会回到 Host 偏好，并把 `system` 解析到远程设备。
- 邀请使用启动时探测到的**排序最高的私有 IPv4 接口**；多 LAN 接口下如何选择**尚未暴露**。
- 打开特定 Settings 分区的快捷方式用了一个小的语义兼容桥，因为 Harness 没有暴露
  通用的 settings 导航服务。
- 当全宽 Cordis 动作存在时，Harness 的 footer-action 容器需要一条兼容布局规则。
- Mobile View 目标视口从 360 CSS px 起，但**第三方定宽视图、虚拟键盘、旋屏、
  分屏浏览器、系统文字缩放仍需真机验收**。
- 插件按钮与文本输入用 Harness 的 `Button` / `Input` 原语；
  `0.1.5-rc.1` 还没有完整的公开响应式外壳/间距/圆角契约，
  因此移动端几何、响应式组合与少数缺失的原语图标**仍是设计系统兼容风险**。

## 12. 与本仓库 `dsh-webcode-bridge` 共存的注意事项

- 两者**互不依赖**。`dsh-local-link` 只关心「把原版 Web 界面安全地给局域网设备用」；
  本仓库的桥关心「把网页模型接进 Harness」。
- `dsh-local-link` **不做**第二套聊天 UI、不做独立工作区/文件/会话同步，
  所以本仓库右侧栏（官方右栏 + `:8931` 站点中继）在手机上会**原样出现**在
  Mobile View 里，作为第三方插件插槽被保留。
- 手机上操作右栏的窄屏体验**未在本轮验收范围内**——`dsh-local-link` 的响应式检查
  针对的是原版界面。若在手机上用右栏遇到问题，先判断是「桥的布局」还是
  「Mobile View 的插槽适配」，再分别定位。
- 两者共用同一个 `:3080` Harness Host，不冲突；`dsh-local-link` 监听的是另一个端口 `3088`。

## 13. 故障排查

| 现象 | 处置 |
| --- | --- |
| 手机打不开 `192.168.x.x:3088` | 确认电脑与手机在同一私有网络；确认 Windows 防火墙只对 **Private** 放行；确认没在路由器做端口转发 |
| 二维码扫了但进不去 | 邀请**一次性且 5 分钟过期**。点 `Generate another code` 重新生成 |
| 换了手机/清了 cookie 就进不去 | 预期行为。清 cookie、隐私窗口、新浏览器 profile、被撤销设备都需要**新邀请** |
| 侧栏里找不到 `Local access` | 确认插件已装且 `dsh web` 已**重启**；用 `--dump-config` 确认 `dsh-local-link` 层在 |
| 想撤销某台设备 | `Paired devices` → 该设备 → `Revoke`（会立刻断开它的 WebSocket） |
| 需要报障 | `Settings → Local access → Diagnostics` → `Copy report` |

## 14. 卸载与回滚

```powershell
$env:NODE_OPTIONS='--use-system-ca'
dsh plugin --profile web remove dsh-local-link
dsh web
```

回滚 manifest 用 §15 的备份文件（与 agent-teams 教程共用同一份备份）。

## 15. 本机安装实测记录（2026-09-14）

- 已装 `dsh-local-link@1.1.1`，安装副本与 tarball 逐文件 SHA256 比对 **22/22 零差异**。
- `dsh.profile.bundles` 已包含 `dsh-local-link`（在 `@deepseek-ai/dsh-experimental-agent-team-profile` 之后）。
- `dsh --profile web --dump-config` 已确认 `dsh-local-link` 层与其 `diagnosticsFile` / `stateFile` 配置出现。
- 备份：`C:\Users\rsyhn\.dsh\profiles\web\package.json.bak-2026-09-14-addplugins`、
  `pnpm-lock.yaml.bak-2026-09-14-addplugins`、`pnpm-workspace.yaml.bak-2026-09-14-addplugins`。
- **待用户执行**：重启 `dsh web` 后做真机配对验收（扫码 → 打开会话 → 撤销设备）。
  本会话不重启（重启会顶掉当前会话）。

## 16. 参考出处

- npm：`dsh-local-link@1.1.1`（shasum `01c8a8a0ff42e5b39923244cbd03b2d5b31e14d2`）
- 包内 `README.md`、`SECURITY.md`、`docs/COMPATIBILITY.md`、`docs/MOBILE_VIEW.md`、
  `docs/DIAGNOSTICS.md`、`docs/ARCHITECTURE.md`、`docs/SECURITY.md`、`cordis.patch.yml`
- 选型快照：`.tmp-plugins.json`（awesome-dsh-plugin.com，`updated: 2026-09-05`，3196 条）
