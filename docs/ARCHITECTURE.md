# Bridge 架构

本文描述当前源码的 Claude 原生接入与适配范围；旧 Host/lane/所有权流程在对应章节标为历史。原生接入已随 1.3.0 发布，但本文的独立 Agent 退役等候选变更不代表 1.3.1 发布包，版本边界见[首页](../README.md#版本与下载)。macOS 已通过真实 Desktop 的创建、发送、原生事件、历史及关闭 Bridge 后会话保留验证，具体验证范围见[重构记录](HOSTING-REFACTOR.md)。

## 产品边界

Bridge 将 Claude Desktop（含 Claude-3p）的原生会话、队列、授权、提问与成果带到手机。
Claude Desktop 是执行权威；Bridge 负责同步与传输。Claude 内部的 Gemini、Antigravity、
Magpie 等模型和额度功能保持，独立 Agent 适配及跨 Agent 接力已下线。
Bridge 只建立出站连接，不要求公网 IP、端口映射或额外组网客户端。

```mermaid
flowchart LR
  M["Android / iOS"] <-->|"WebRTC DataChannel"| D["Bridge Desktop"]
  M <-->|"公网 WSS / 局域网 WS"| T["TransportRouter"]
  D <-->|"公网 WSS / 局域网 WS"| T
  T <-->|"协议 V3 加密信封"| R["Relay"]
  M -.->|"STUN Binding"| S["STUN"]
  D -.->|"STUN Binding"| S
  D --> B["claude-desktop-bridge.ts 薄中转层"]
  B <-->|"127.0.0.1:9229 Node inspector"| I["Electron main → app://localhost WebContents"]
  I <-->|"executeJavaScript"| C["claude.web.LocalSessions"]
  C -->|"原生事件与权限请求"| EQ["renderer 单队列 + 等待 Promise"]
  EQ --> B
  B --> CS[("请求幂等 / 收据")]
  B --> EM["EvidenceManager 被动收集"]
  EM --> ES[("Evidence SQLite + AES-GCM blobs")]
  EM --> AP["ArtifactPreview"]
  B --> E[("SessionEventLog JSONL / replay")]
  R -. "仅见路由元数据与密文" .-> Q[("SQLite WAL 按设备离线队列")]
```

## Claude 原生接入

新 `claude-desktop-bridge.ts` 是薄中转层，Claude Desktop 是会话执行、队列和权限的
唯一权威。用户选择常开本机 inspector，Bridge 从 `http://127.0.0.1:9229/json/list` 动态
取得 Node inspector 的 `webSocketDebuggerUrl`，经 `process.mainModule.require('electron')`
定位 `app://localhost` WebContents，再以 `executeJavaScript` 调用
`claude.web.LocalSessions`。会话创建、发送、排队、中断和权限答复均走原生接口，
不再启动 SDK/CLI Host 或 standalone API Key lane，也不使用接管/交还、inbox、Claude
lane、自动 goal 续跑或侧边栏文件登记。

事件与权限请求订阅进入 renderer 中同一队列；无事件时等待 Promise，收到事件后
批量返回，由 Bridge 记录事件并向客户端 replay。Bridge 保留配对、E2EE Relay/WebRTC、
请求幂等与收据、附件传输和证据被动收集，不把事件转发变成第二套会话调度。

用户本次选择覆盖旧“绝不 CDP / 不附着”的 Claude 限制；不改 asar、不签 token、
不重启 Desktop、不加 LaunchAgent。macOS 后台每次发现新的 Desktop 主进程后，仅通过
原生菜单尝试开启一次 inspector，保留账号与工作区策略；失败时显示具体错误与不可用状态。Relay 不暴露任意 evaluate，也不传账号凭据。macOS 已实测空会话创建、发送、
原生生命周期事件、历史、请求去重与正常关闭；原生审批和子代理停止尚未对真实 Desktop
做端到端验证。

Claude 直接使用 Desktop 返回的原生会话 ID，历史分页直接调用 Desktop transcript
接口。旧 Bridge 本地隐藏/归档标记不覆盖原生列表；重命名、归档和删除交由 Desktop，
删除确认明确说明将删除 Desktop 中的会话与对话记录。不导入旧数据、不映射旧逻辑 ID，
也不从本地旧历史或 eventlog 回退补页。旧数据
不碰，不从旧队列恢复草稿；手机缓存的 `bridgeExecutionRequested` 不得自动重发。
`removeLegacyConnector` 仅用于退役旧连接组件：先写 `.bridge-backup`，再清理旧
`claude-bridge` MCP、固定
`BRIDGE_HOOK_URL` 及动态 `http://127.0.0.1:<port>/hooks/claude-permission` 中同时带有
`X-Bridge-Permission-Host: $BRIDGE_PERMISSION_HOST` 与 `allowedEnvVars` 包含
`BRIDGE_PERMISSION_HOST` 的 HTTP Hook；无关 Hook、MCP 和设置保留。

## 当前支持范围与退役数据

当前仅注册 Claude Desktop。应用发现、启停控制、会话列表、新建、配置、权限与执行均由
Claude 路径处理；客户端不再提供 Agent 显示开关、运行时选择或筛选、外部默认权限、接力或 goal 续跑入口。

Codex、Hermes、DSH 的 adapter、Registry、RuntimeSessionBroker 和 RuntimeHandoffService
已移除，不连接、启动、探测或轮询这些独立 Agent。旧外部 sessionId、runtimeId、
`runtime.handoff.*`、`runtime.goal.*`、`runtime.file.open` 和
`permission.policy.configure` 执行请求返回 `UNSUPPORTED`。

配置读写仍接受旧 `runtimePermissionModes`，SQLite 中的历史表和协议 V3 类型保持；
升级不清空这些字段、不删除旧数据，也不重建配对身份。旧数据不会恢复执行或成为 Claude 历史的回退来源。

Claude 原生事件继续进入现有被动证据管线：记录轮次、工具起止、文件变化、预览与传输；
不为采集证据另起执行器。客户端通过全量目录快照与事件 replay 同步。

## 组件

| 组件 | 职责 |
|---|---|
| `claude-desktop-bridge.ts`（新薄中转层） | 通过本机 inspector 转发 `LocalSessions` 调用、renderer 单队列事件与权限请求 |
| `ConversationStateStore` | 保存新原生请求的幂等键与收据，不导入旧数据 |
| `SessionEventLog` | 追加式事件、单调 `seq`、delta 合并与 replay，不作为 Claude 历史回退源 |
| `EvidenceManager` | 每轮证据生命周期、工具脱敏、变更归因、预览和传输租约 |
| `EvidenceStore` | SQLite 清单、加密内容寻址快照、保留策略和按需重建 |
| `ArtifactPreview` | 图片缩放和隔离、禁网的 HTML 静态截图 |
| `packages/protocol` | 请求/响应/事件/证据/快照、AES-GCM、设备定向 ACK |
| `BridgeTransport` | 公网与局域网使用同一 Envelope、ACK、幂等和事件 cursor |
| `WebRtcTransport` | 加密信令、五秒直连竞争、DataChannel 分块、ACK 与无缝回退 |
| `apps/relay` | 鉴权、SQLite 离线密文、分块、撤销、指标、备份和无正文推送 |
| `apps/client` | 手机三层导航和电脑轻量控制台 |

## 跨 Desktop 串行接力（0.7，历史）

> 本节仅为历史说明。跨 Agent 接力、Registry、外部 adapter 与自动 goal 执行均已移除，不作为当前支持能力或重启恢复规则。

跨运行时接力由独立的 `RuntimeHandoffService` 编排，与 Claude 域内 lane 接力并行且
互不改写。它把「接力」建模为源会话到目标新建会话的**有向链接**，而不是任何意义上的
会话迁移：原生身份 `(runtimeId, nativeSessionId)` 不变，目标会话由目标运行时自己执行，
Bridge 只在两次用户确认之间传递接力包。

```mermaid
stateDiagram-v2
  [*] --> previewed: "选择目标运行时并生成预览"
  previewed --> preparing: "确认接力"
  previewed --> failed: "预览过期"
  preparing --> planning: "源任务已停止，目标新会话已创建"
  preparing --> failed: "源任务 10s 未停止 / 目标未就绪"
  planning --> plan_ready: "目标产出可读计划"
  planning --> failed: "计划失败或为空"
  plan_ready --> executing: "用户确认计划（可修改目标）"
  plan_ready --> cancelled: "用户取消"
  executing --> applied: "目标接受执行 turn，goal 已建立"
  executing --> failed
  previewed --> cancelled
  preparing --> cancelled
  planning --> cancelled
```

- **预览**：`runtime.handoff.preview` 构建加密接力包（目标草稿、有界近期对话、约束、
  未完成事项、工具/成果摘要、workspace git 状态、完整性哈希），与 0.5 lane 接力包共用
  同一套 compact/redact/workspace 采集实现（`handoff-package.ts`）。提示词上限仍为
  48,000 字符；预览 30 分钟过期。
- **确认接力**：源会话运行中先 `interruptTurn` 并有界等待 10 秒；未停止则失败且源任务
  保持原状。源队列中未发送项不迁移，仅以摘要进入未完成事项。目标会话以源 cwd 新建，
  标题为「接力自 <源标题>」。
- **计划阶段**：Codex 目标经 `thread/settings/update` 设 `collaborationMode: plan` 原生
  只读规划；Claude/Hermes 目标使用只读规划约定（写操作仍走既有审批）。计划 turn 的
  终稿 assistant 消息存为计划文本；空计划直接失败。
- **goal 执行**：用户确认计划后，Codex 目标调 `thread/goal/set` 建立原生 goal 并恢复
  default 模式，由运行时自动续跑；Claude/Hermes 目标执行带 `GOAL_STATUS:
  continue|done|blocked` 约定的指令，Bridge 在每轮结束解析标记并自动续跑（上限 20 次，
  持久化计数），done/blocked 分别进入完成/受阻。
- **停止语义**：用户在目标会话停止任务会同时暂停 goal（Codex 原生 `paused`，模拟侧停
  循环），goal 循环永不与用户停止对抗；`runtime.goal.pause/resume` 可显式控制。
- **故障闭合**：Host 重启后 `preparing` 与无 goal 的 `executing` 直接失败（绝不重发），
  `planning` 从目标历史恢复可读计划（否则失败），`applied` 的 goal 按 `runtime_goals`
  恢复监督并与 Codex `thread/goal/get` 对账。

接力状态持久化在 `conversation-state-v1.sqlite` 的 `runtime_handoffs` 与
`runtime_goals` 两表；接力链（`BridgeSessionInfo.relay`）、goal 状态
（`BridgeSessionInfo.goal`）与待确认接力（`pendingRuntimeHandoff`，快照中剥离计划
全文与原生 ID）作为增量快照字段下发。协议仍为 V3、配对 schema 仍为 V4，新增
`runtime.handoff.v1` capability 与 `runtime.handoff.*`/`runtime.goal.*` 方法事件，
旧客户端忽略并隐藏入口。

## Claude 域内逻辑对话与提供方接力（历史）

> 以下仅记录旧 provider lane 的设计。当前不导入旧数据、不建立逻辑 ID alias，也不提供旧历史入口；直接读取 Desktop 记录，旧文件不碰。

本节只描述 Claude 运行时内的 legacy provider lane。`BridgeSessionInfo.sessionId` 是稳定逻辑对话 ID。每个对话可以保留多个
`BridgeExecutionLane`，但 `conversations.active_lane_id` 始终只指向一个活动 lane。
原生会话唯一键为 `(providerProfileId, nativeSessionId)`，避免 Claude 与 Claude-3p
恰好出现相同原生 ID 时被错误合并。队列项在入队事务中固定 `laneId`，后续切换不会
把已排队指令偷偷改投其他 provider。

```mermaid
stateDiagram-v2
  [*] --> previewed
  previewed --> preparing: "用户确认"
  preparing --> activating: "可执行 lane 已准备"
  preparing --> awaiting_user_confirmation: "打开 Claude 官方 Deep Link"
  awaiting_user_confirmation --> activating: "唯一精确关联"
  awaiting_user_confirmation --> awaiting_target: "多个精确关联"
  awaiting_target --> activating: "用户选择"
  activating --> applied: "目标接受首条接力消息"
  previewed --> cancelled
  preparing --> failed
  activating --> failed
  awaiting_user_confirmation --> expired
```

`preview` 只生成本机加密包并把 route 标为切换中，不改变活动 lane。可执行 lane 只有
在 `user.message.accepted` 确认接力首条消息后才原子激活；断电恢复时处于
`preparing/activating` 的接力直接失败并取消未确认队列，绝不自动重发。Claude 官方
必须同时满足 official profile、`realpath` cwd、不透明 handoff ID、首条消息完整
哈希与十分钟窗口；零匹配继续等待，多匹配进入人工选择。

完整接力包只在 Host 本机以 AES-256-GCM 保存。它包含有界可见对话、明确目标、用户
约束、未完成事项、工具/成果摘要、文件与哈希、cwd、Git HEAD/分支/脏状态、源事件
序号和完整性哈希；不包含隐藏思维、OAuth/API Key/认证头、敏感正文、项目外内容或
无界输出。Agent SDK 提示上限 48,000 字符，官方 Deep Link 上限 12,000 字符。

本次原生重构不导入或改名旧 `sessions-v2.json`、`turn-queue-v2.json`，不恢复其中的
队列或草稿；旧文件不碰。

## 会话所有权（历史）

> 下方状态机属于旧 SDK/CLI Host 接管流程。当前 Claude 执行、队列与权限始终由 Desktop 持有，Bridge 不启动 writer、不退出原生执行器，也不重新排队自动续跑。

```mermaid
stateDiagram-v2
  [*] --> DESKTOP_OBSERVED
  DESKTOP_OBSERVED --> ACQUIRING: "桌面会话空闲且队列非空"
  ACQUIRING --> BRIDGE_IDLE: "Host 已启动"
  BRIDGE_IDLE --> BRIDGE_RUNNING: "会话接受消息"
  BRIDGE_RUNNING --> BRIDGE_IDLE: "turn 完成 / 失败 / 中断"
  BRIDGE_RUNNING --> OWNERSHIP_CONFLICT: "检测到外部用户写入"
  OWNERSHIP_CONFLICT --> DESKTOP_OBSERVED: "关闭 Bridge writer，原指令重新排队"
  BRIDGE_IDLE --> RELEASING: "空闲超时且无队列"
  RELEASING --> DESKTOP_OBSERVED: "释放既有桌面会话"
```

同一会话只允许一个实际写入者，但 Claude Desktop 的空闲会话进程可以作为只读
观察者与 Bridge Host 共存。打开、聚焦或查看会话只改变 Desktop 元数据，不会触发
冲突，也不会导致 Bridge 退出 Claude Desktop。Bridge 启动 Host 前会确认目标
transcript 已空闲并到达完成边界。

Host 启动时记录外部写入版本。`TranscriptObserver` 扫描全部近期用户分支，只有出现
无法归因给 Bridge 的新用户消息时才确认竞争写入；进程存在、文件句柄和 focus 变化
都不是写入证据。检测到真实双写时，Bridge writer 会静默关闭，原指令保持排队并在
所有权清晰后自动续跑。主机最多同时运行两个 Bridge turn。瞬态会话锁仅在消息尚未
被会话接受时重试，避免重复执行。

## 历史与事件

Claude 会话与历史直接通过 `LocalSessions` 原生接口读取，历史默认最近 50 条，
向上使用 Desktop transcript cursor 分页。原生会话 ID 保持不变；不关联旧逻辑会话，
也不回退到本地旧 JSONL 或 Bridge eventlog，Desktop 不可用时明确显示不可用。

Bridge 自身事件写入 `events-v2.jsonl`，高频 assistant delta 短时合并。客户端保存
最后 `seq`，重连后调用 `events.resume`；事件 replay 与原生历史分页分开。Relay ACK
只表示密文已保存或目标设备已收到；接收、运行和最终状态以 Desktop 原生事件为准。

## Claude Desktop 侧边栏登记（历史）

> 以下文件登记与重启说明仅记录旧方案；当前通过 `LocalSessions` 操作原生会话，不登记文件，不为 Bridge 重启 Desktop。旧“私有 CDP”禁用规则已由本次用户选择在上述本机边界内覆盖。

Bridge 只为自身创建、且已经有可信 JSONL 的会话登记侧边栏。登记器在 macOS 使用
`ps`、在 Windows 使用 PowerShell，从 Claude 主进程及其 Helper 的
`--user-data-dir` 动态识别当前 profile，不硬编码 `Claude-3p`；Windows 使用
`%APPDATA%\Claude\claude-code-sessions` 作为标准会话根目录。
随后要求本机仅有一个可识别的账号会话目录，并用现有 `local_*.json` 验证格式。

目标 Desktop ID 固定为 `local_<Bridge sessionId>`。写入前同时校验 transcript 位于
`~/.claude/projects`、记录中的 `sessionId` 与 `cwd` 一致、目标路径位于已知
`claude-code-sessions` 根目录，并拒绝符号链接、路径逃逸和同名冲突。新文件通过
临时文件加硬链接原子创建，权限为 `0600`，从不覆盖已有元数据。

登记事件只向客户端暴露状态、说明、Desktop ID 与时间，不暴露 profile、账号目录、
文件路径或哈希。状态为 `waiting-transcript / unavailable / restart-required /
registered / failed`；多 profile、多账号、未知格式与异常都 fail closed。Bridge
不写 Claude 的 LevelDB，不注入进程，不使用私有 CDP。当前进程必须重启一次才能
重新加载清单，重启由用户在 Bridge 中显式触发。

## 成果证据

证据管线被动接收原生 turn 与工具事件，建立证据占位和工作区基线；工具输入、进度、
结果和退出码只按实际事件记录，不为补证据启动任务。turn 结束后等待文件系统静默一秒，
最多五秒，再将结构化工具路径、命令提及路径和文件监听结果取并集。任务开始前已有的
脏改动不归入本轮；同目录并发任务、基线超限或监听不完整时，可信度降为 `partial`。

Claude 工具与成果线索来自 Desktop 原生事件，不扫描旧 JSONL 来补历史或证据，
明确忽略 `thinking`。用户打开产物时才通过当前项目根目录校验路径、读取文件并
缓存当时版本。

证据清单写入 SQLite WAL。可预览或下载的正文以 AES-256-GCM 加密为内容寻址 blob；
主密钥保存在权限受限的本地配置文件中，不由 Electron `safeStorage` 加密。正文达到
30 天或 1 GiB 时按 LRU 清理，清单继续保留；只有源文件哈希仍一致时才能重建失效快照。

事件 `evidence.started/updated/ready/failed` 只携带摘要和清单。`artifact.preview`
按需返回有界预览；`artifact.transfer.open/read/close` 使用 256 KiB 分块、十分钟
租约、缺块重试和最终 SHA-256 校验，单文件上限 20 MiB。产物响应为十分钟临时
消息，不进入 Relay 七天离线队列。

## 配对与推送

每次二维码生成一个十分钟有效的设备凭据。Relay 只允许该设备凭据首次绑定到一个
移动实例，之后不可复制使用，但 Relay claim 不等于端到端配对成功。手机先用临时
身份连接并发送加密 `snapshot.get`；桌面只有成功解密该请求后才记录 `pairedAt`，手机
再校验加密响应中的 `hostId` 与 `pairingEpoch`，随后才原子持久化新身份。替换配对在
确认前不会删除旧身份，失败或超时只清理本次设备 ID 的临时密文。

桌面收到 Relay `ready/presence` 时会把设备 ID 与本地非撤销设备密钥做交集。Relay
仍声称在线、但桌面已无密钥的旧设备会被立即 `device-revoke`；手机也只在成功解密
桌面消息后显示在线，不能再由 Relay presence 形成“顶部在线、会话为空”的假状态。
主机为每台设备保存独立密钥和鉴权令牌，信封带 `toDeviceId`，撤销一台设备不会影响
其他设备。

FCM/APNs 只发送 `bridge-wake` 或 `content-available`，不包含会话 ID、消息摘要或
正文。App 唤醒后再从 Relay 获取并端到端解密。

协议 V3 与配对 schema V4 继续拒绝 V0.3 设备；这是既有协议版本边界。本次 Claude
原生接入不迁移会话记录，不轮换 `hostId`、房间或设备密钥，也不改动既有配对。

Relay 端点仍与加密身份解耦，固定公网 WSS 优先，局域网端点作为候选。大信封先
加密再按 64 KiB 传输分块，Relay 不参与解密；目标端完成 SHA-256 校验、重组和
AES-GCM 解密后才发送最终 ACK。

可靠 Relay 之上同时提供 WebRTC DataChannel。手机通过加密 Envelope 发送
SDP/ICE，Relay 无法读取候选地址；STUN 只返回公网映射，不承载 Bridge 业务数据。
直连打开前仍使用 WSS，打开后相同 Envelope ID 直接传输；DataChannel 中断时，
未确认 outbox 使用原 ID 回退 Relay，因此不会重复执行指令。首版不使用 TURN，
ICE 五秒未成功即保持 WSS 路径。ICE 服务器为独立显式配置，不从 Relay 或
`serviceOrigin` 的主机名推导。

## 运行时发现

Claude 从本机 Node inspector 发现提供 `claude.web.LocalSessions` 的 `app://localhost`
WebContents；动态 WebSocket 路径每次由 `/json/list` 获取。macOS 的现有 inspector monitor
每3秒通过 PID、启动时间和完整可执行路径识别 Desktop 新进程，使用 System Events 触发
一次原生主进程调试菜单；已开放时跳过，菜单未就绪时等待。已处理身份及失败记录保存在
Bridge userData，跨后台重启尊重同进程手动关闭；自定义 inspector origin 禁用真实菜单动作。
端口开放后现有 Bridge 刷新自行重连。未开启、接口缺失或断连时显示不可用，不启动 CLI/SDK
Host、不切换 provider lane、不重启 Desktop。独立 Codex、Hermes、DSH 的发现与连接已移除。

## 明确不做

Bridge 不展示、存储或从行为推断隐藏 CoT，不自动故障转移，不代理官方 OAuth；
不合并各运行时的原生会话、历史、认证、模型或权限。Claude 本机 Node inspector
仅按本次用户选择用于明确的原生操作，不向 Relay 暴露任意 evaluate，不改 asar、
签 token、重启 Desktop、添加 LaunchAgent、发 SIGUSR1 或改调试启动参数；辅助功能仅用于
已授权的每次启动单次原生调试菜单操作，不恢复旧 Host、
inbox、lane、接管/交还或自动 goal 续跑。不提供远程编辑器、动态站点直播、自动启动
开发服务或超过 20 MiB 的文件传输。
