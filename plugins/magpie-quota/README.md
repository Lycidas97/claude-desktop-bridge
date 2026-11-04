# Magpie 额度插件

编译时接入的源码插件。核心逻辑不依赖 Bridge 的 SessionBroker、快照、事件日志或主界面组件；宿主只在下面列出的几处装配。

约定：手机显示完整邮箱，提供“设置 → Magpie 额度”看板（可手动刷新），以及会话配置里模型选项的额度文字和所选模型的账号详情。插件只读，不调整 Magpie 路由、不指定账号、不切换模型。

## 文件边界

| 文件 | 职责 |
| --- | --- |
| `contract.ts` | 插件请求名称、数据契约、上游响应字段白名单 |
| `desktop.ts` | 接收网关配置，调用额度 API，缓存结果，把错误转成可展示的中文 |
| `presentation.ts` | 将模型 ID 匹配到账号、额度池和模型自己的窗口，生成选项文字 |
| `client.tsx` | 接收宿主提供的 loader，按需读取和刷新，提供看板内容和会话配置里的模型详情 |
| `styles.css` | 仅含 `magpie-quota` 前缀样式，沿用宿主手机端设计规范的变量 |

插件自身的测试和类型检查不在根 `npm test` 的工作区列表中，需要单独执行：

```sh
npm --prefix plugins/magpie-quota test
npm --prefix plugins/magpie-quota run typecheck
```

使用仓库已安装的 React、TypeScript 和 Vitest，无新增运行时依赖。

## 宿主装配（2026-11-01 接入）

| 位置 | 内容 |
| --- | --- |
| `packages/protocol` | 方法 `plugin.magpie-quota.list` 加入 `BridgeMethod` 与 `METHODS`；能力 `plugin.magpie-quota.v1` 加入 `BridgeCapability` |
| `SessionBroker.gatewayConfig()` | 用 broker 当前运行时调用 `resolveClaudeGatewayConfig` |
| `DesktopController` | 构造插件一次；`host.capabilities` 声明能力；`handleRequest` 在 `Unsupported request method` 之前转发 |
| `App.tsx` | 一个 `MagpieQuotaProvider` 包住会话页与电脑页，`key` 为当前电脑；loader 经现有请求通道调用插件方法 |
| `MobileSettings` | 电脑声明能力时，设置页最上方显示“额度 → Magpie 额度”入口 |
| `MobileQuotaPage` | 宿主页面（标题、返回、系统返回键），内容为插件的 `MagpieQuotaDashboard` |
| `SessionConfigurationDialog` | Claude 会话的模型选项附加额度文字，下方显示所选模型的账号详情 |

要点：

- **能力门槛**：桌面端不在收包时执行 `METHODS` 白名单，旧电脑会对未知方法回错误。手机只在电脑声明 `plugin.magpie-quota.v1`、已连接且电脑在线时请求。
- **网关来源**：新版 Claude Desktop 不再生成 `host-creds-*.json`，`prepareClaudeRuntime` 从 `configLibrary` 读网关写入运行时环境；必须用 broker 当前运行时，只传凭据路径会得到 `unsupported`。
- **按需读取**：Provider 挂载时不请求，只有额度看板或会话配置挂载期间才读取；打开设置列表本身不读取，连接或重连时没有展示额度的界面就不发请求。读取中断线不会卡在“读取中”；恢复后重读。只有回应手动刷新的那次读取会绕过桌面端 30 秒缓存。
- **看板位置**：v51 起额度从电脑详情移到设置页的独立看板。Provider 同时包住设置页，看板与会话配置共用一份读数。
- **没有 Provider 的地方**：电脑端窗口也用 `SessionConfigurationDialog`，那里不挂 Provider，`useOptionalMagpieQuota` 返回空值，不加额度文字。原生运行时（Codex 等）不经过 Magpie，同样不加。
- **不入本地缓存**：额度响应不属于证据或消息缓存，不写 IndexedDB。

`availableModels` 的 `value` 是网关原始的 `provider/model` ID，会话里的 `mythos-magpie-<哈希>` 合成 ID 已由 `SessionModelCatalog` 映射回原始选项，无需宿主另外传入。插件按最长厂商前缀匹配，支持 `remote-magpie/minimax-cn/...`。

正式构建（桌面端 esbuild、客户端 Vite）沿 import 打包 `plugins/`。按冻结源码重建的一次性打包脚本需要同时复制 `plugins/magpie-quota` 和根目录 `tsconfig.base.json`（Vite 读取插件的 tsconfig）。

### 版本搭配

| 手机 | 电脑 | 结果 |
| --- | --- | --- |
| 已接入 | 已接入 | 正常显示 |
| 已接入 | 未接入 | 电脑不声明能力，手机不请求、不显示，会话配置不变 |
| 未接入 | 已接入 | 手机不调用新方法；快照多一个能力字符串，旧手机不使用 |

移除时，去掉上表的装配、方法和能力声明、组件引用，再将此目录移至废纸篓即可。没有额度字段写入持久化的快照、会话或事件。

## 数据含义

- 订阅账号逐个显示完整邮箱、套餐、每个窗口剩余百分比和重置时间；余额账号显示上游给出的余额字符串。Magpie 的 `remaining`、`used` 为百分比（`remaining = 100 - used`）。
- 钱包类窗口（窗口带 `balance`，单位在 `unit`）显示“余额 数值 单位”。此时上游仍给出 `remaining: 100`，那不是读数，不能显示成“剩余 100%”。
- `fetchedAt` 是 Bridge 读取时间，`readAt` 是 Magpie 上游采样时间，两者分别展示。账号带 `asOf` 时是 Magpie 保留的旧读数：`readDeferred` 为真表示 Magpie 本次没有发起读取（例如设为“仅在我要求时读取”），否则表示读取失败。两种都会在账号下注明。手动刷新会重新调用 API，但 `/v1/magpie/quotas` 不能强制 Magpie 去问厂商。
- 模型标注取每个账号所有适用窗口的最小剩余值，再取账号之间的最大值，标为“单账号最高可用”。这是上游采样值，不是成功率或可执行请求数；账号百分比不能相加。文字行和钱包窗口不参与这个计算。
- 适用窗口：不按模型区分的窗口；模型所属额度池（`pool`，例如 Gemini 与 Claude & GPT 分开）的窗口；以及名称就是该模型的窗口（“Gemini 3.8 Flash (High)” 对应 `gemini-3.8-flash`）。同一池里其他模型的窗口不算，避免 Flash 被 Argon 的 0% 拖低。
- 已过重置时间的窗口不自动变为 100%，模型标注显示“额度待更新”。账号详情保留原值及时间，便于核对。
- `auto/...` 可能经过多个渠道，只提示“自动路由 · 查看各渠道额度”。
- 看板：顶部为读取时间、账号数、保留读数个数和刷新按钮；有多个渠道时可点选跳转。每个百分比窗口带进度条：0 为红色，低于 20% 为橙色，已过重置时间为灰色并注明“等待 Magpie 更新”。重置时间显示倒计时和“月日 时:分”。同一账号里只差档位（如 `(High)`、`(Low)`）且读数与重置时间相同的窗口合并为一行，读数不同则分开。
- 读取失败、刷新失败或电脑未连接时保留上次数据并明确标注。没有定时轮询、后台持久化或浏览器存储。
- 错误信息会显示在手机上：网关不可达、超时、非 JSON 响应和 HTTP 错误都转成固定中文，不回显上游响应正文。

## 验证（2026-11-01）

- 插件单元测试 36 项；客户端 298 项（含会话配置额度文字 3 项）；桌面端 455 项中 453 项通过、2 项按原设定跳过（另有 13 个测试文件用永久删除清理临时目录，按删除规则未运行，不涉及控制器和插件），含控制器转发 2 项；协议 35 项。三端类型检查通过。
- 通过宿主 `prepareClaudeRuntime` 完成本机只读兼容性核验，并按 Magpie 源码核对模型、额度池与窗口字段的含义。
- 端到端：实际打包的桌面后台、本地中继、冻结后的手机客户端在 Chrome 中运行，连接模拟 Magpie 网关。验证连接不读取、电脑详情读取一次、手动刷新绕过缓存、会话配置复用缓存及各模型标注、401 保留旧数据且不泄露错误正文、电脑离线保留数据并禁用刷新、重启后自动重读、网关无额度接口时隐藏卡片；新手机连接未接入的电脑不请求、不显示、无错误。全程无页面异常，模拟 CLI 拒绝任何模型请求。

- 第二轮：安卓模拟器完整流程（含系统返回键、离线恢复、应用重载）；网关一直不响应（15 秒超时提示）；读取途中离开；150 个账号 / 1200 个窗口；v48 旧手机连接新电脑；打包后的电脑端只读读取本机真实 Magpie。期间发现连点刷新会读两次，已修复（点击当下即禁用按钮）。

脚本和证据在已忽略的 `output/magpie-quota-v50-20261101/`。

## v51：设置页看板（2026-11-02）

额度移到“设置 → Magpie 额度”，电脑详情不再显示。验证与证据在 `output/magpie-quota-v51-20261102/`。
