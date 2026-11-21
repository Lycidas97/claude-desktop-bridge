# Bridge 安全模型

Claude 部分描述当前分支的原生中转边界。macOS 已通过真实 Desktop 的创建、发送、事件、历史、请求去重与关闭验证；原生审批和子代理停止尚未对真实 Desktop 做端到端验证，具体验证范围见[重构记录](HOSTING-REFACTOR.md)。

## 已保护

- 正文与事件使用每设备独立的 AES-256-GCM 密钥端到端加密。
- 房间、发送设备、目标设备、时间、过期时间和临时投递标记属于认证数据，Relay
  不能静默改写。
- Relay 只保存鉴权摘要和密文；设备 ACK、离线队列和撤销均按 `deviceId` 隔离。
- 普通信封在端到端加密后分块，Relay 只能看到分块大小、序号和整体密文哈希。
- 成果事件只包含摘要和清单，不包含文件正文；预览与下载仅在用户请求后临时发送。
- 二维码十分钟内单次有效，并由 Relay 绑定到首次使用它的移动实例。
- Relay 绑定只代表传输层 claim；手机必须用二维码设备密钥完成一次加密
  `snapshot.get` 请求/响应并核对 `hostId` 与 `pairingEpoch` 后，双端才提交配对。
  握手失败不会覆盖手机旧身份；桌面发现本地无对应密钥的 Relay 设备会立即撤销。
- 在线撤销会立即移除 Relay 权限；手机删除主机时同时删除本地密钥和缓存。
- 主机与设备密钥保存在权限为 `0600` 的本地配置中，不调用系统钥匙串，避免临时
  签名或升级时弹出系统密码框。
- 证据正文使用独立 AES-256-GCM 主密钥加密为内容寻址 blob；主密钥保存在本机
  受限配置文件中，不复用传输身份密钥。
- Electron 渲染进程启用 sandbox、context isolation，关闭 Node integration，
  并限制导航和 IPC 来源。
- macOS Bridge 使用辅助功能和 System Events 自动化权限，仅在发现新的 Claude Desktop
  进程后触发一次原生 Enable Main Process Debugger 菜单；保留原生账号与工作区策略。
  不发送键鼠事件或读写剪贴板。独立 Codex、Hermes、DSH 适配已下线。
- Claude Desktop 是会话执行、队列和权限的唯一权威。手机提交原生权限请求的答复，
  Bridge 不安装 Host 权限 Hook、不自动批准，也不改写原生会话文件来升级授权。
- Claude 不再运行 SDK/CLI Host、standalone API Key lane、接管/交还、inbox、lane 或
  自动 goal 续跑。旧队列与手机 `bridgeExecutionRequested` 不能触发自动重发或恢复执行。
- 附件通过现有上传校验保存在会话 `.bridge-uploads`，新目录为 `0700`、文件为
  `0600`；读取仍服从原生工具与系统目录权限，不因来自手机自动放行。
- 账号凭据留在各原生应用内，不复制到手机、Relay、日志或诊断；不签发 Desktop token。
- Claude 直接使用原生会话 ID 与 Desktop 历史，不导入旧数据、不关联旧逻辑 ID，
  不提供旧只读入口或恢复旧队列草稿；不导入或改写旧会话数据，保留配对身份。
- 退役旧连接组件时先备份到 `.bridge-backup`，只移除旧 `claude-bridge` MCP、固定
  `http://127.0.0.1:8790/hooks/claude` HTTP Hook，以及匹配动态
  `http://127.0.0.1:<port>/hooks/claude-permission` 且同时带有
  `X-Bridge-Permission-Host: $BRIDGE_PERMISSION_HOST` 和 `allowedEnvVars` 中
  `BRIDGE_PERMISSION_HOST` 标记的 HTTP Hook；其他 Hook、MCP 和用户设置保留。
- 诊断导出只包含版本、平台、连接状态和数量统计，不包含正文、密钥或凭据路径。

## Relay 可见内容

Relay 必须看到房间 ID、设备 ID、时间、密文长度、在线状态和推送平台，才能路由、
限流和清理。它看不到消息正文、项目路径、会话标题、审批内容或工具结果。

恶意 Relay 仍可丢弃、延迟或重放密文。客户端通过事件 ID、请求幂等键和单调
`seq` 去重并发现缺口，但无法阻止服务端拒绝服务。

Android FCM 请求只包含无正文唤醒标记。推送服务不会收到会话 ID、标题、摘要、消息
文本或成果正文。

WebRTC 的 SDP、ICE candidate 与断线 ACK 也封装在设备 AES-GCM 信封中，Relay
只能看到短时密文。直连数据同时受 WebRTC DTLS 和 Bridge AES-GCM 双层保护。
STUN 能看到发起 Binding 的公网 IP 和端口，但不接收 Claude 指令、回复或附件。
当前版本不使用 TURN；无法直连时继续使用端到端加密 WSS Relay。

成果预览和传输响应使用经过端到端认证的临时投递标记与十分钟 TTL。Relay 只向
当前在线设备转发并跳过 SQLite 入队，因此它们不进入七天持久离线队列。Relay
仍可观察加密响应的长度、时间与目标设备，但不能解密文件正文、文件名、项目路径
或 SHA-256。客户端只在完整分块通过最终哈希校验后保存或分享文件。

## 本机边界

### 退役的独立 Agent

当前只接入 Claude Desktop（含 Claude-3p）。Codex、Hermes、DSH 的启动、连接、探测、
轮询和执行代码已移除，跨 Agent 接力和 goal 续跑已停用；旧请求明确返回 `UNSUPPORTED`。
旧配置、SQLite 历史和配对身份保留，不清空用户磁盘数据，也不把旧任务送到 Claude 执行。
Claude Desktop 内部的 Gemini、Antigravity、Magpie 等模型与额度设置不属于退役范围。

### Claude Node inspector

用户已明确选择常开 `127.0.0.1:9229` Node inspector；本次选择覆盖旧“绝不 CDP / 不附着”
规则中针对 Claude 的限制。该本机调试端口具有进程求值能力，边界依赖本机访问控制，
不得映射到公网或 Relay。macOS 后台复用连接监测轮询，以真实 PID、启动时间和精确
主可执行路径识别新启动，仅触发原生 Enable Main Process Debugger 菜单一次；需要用户
授予辅助功能与 System Events 自动化权限，原生账号/工作区策略仍由菜单回调执行。
该回调可能打开 Chrome 调试页。已开放的端口跳过并记录；同进程手动关闭或实际操作失败
不反复触发，已处理身份和错误写入 Bridge userData 的启动记录，跨后台重启保留。
菜单尚未构建时等待；开启结果由实际端口扫描确认，失败显示在现有诊断状态中。
自定义 BRIDGE_CLAUDE_INSPECTOR_URL 时不操作真实菜单。不修改 asar、不签 token、
不重启 Desktop、不安装 LaunchAgent、不发 SIGUSR1 或修改调试启动参数。

接入从 `http://127.0.0.1:9229/json/list` 动态取得 `webSocketDebuggerUrl`，不固定 WebSocket
路径。通过 Node inspector 的 `Runtime.evaluate` 调用 `process.mainModule.require('electron')`，
定位 `app://localhost` WebContents，再以 `executeJavaScript` 调用 `claude.web.LocalSessions`。
这是本机受限的原生接口中转；Relay/手机请求只能映射到明确的会话操作，不能提供任意
JavaScript、任意 evaluate 或任意 WebContents 访问入口，不提取账号凭据。

新 `claude-desktop-bridge.ts` 只负责转发。事件与权限订阅在 renderer 使用单队列和等待
Promise 返回，不启动另一套执行或审批循环。Desktop 决定会话、队列、工具权限与授权模式；
Bridge 不发送执行器退出信号、不登记侧边栏文件，也不以旧 Host 或 provider lane 兜底。
请求幂等、收据和事件 replay 用于同步状态；投递不确定不能推导已执行或自动重发。

Claude 历史通过 Desktop transcript 接口读取，不以旧 JSONL 或 Bridge eventlog 补页；
Desktop 不可用时明确显示不可用。附件与成果继续使用现有路径和敏感文件检查，
证据只被动采集原生事件，不能触发执行。

### 外部邮件自动投递门禁

2026-11-19，用户在 [Issue 222](https://github.com/Lycidas97/claude-desktop-bridge/issues/222#issuecomment-7011727311)
撤销旧实机启用门禁，决定推进事件唤醒。

主动投递默认关闭。Bridge 只向当前托管绑定投递，要求 `stage1-fenced-workspace` 配置可用、Native `turn.start` 可用、会话仍在绑定路径并经 Native 回读为 `dontAsk`。观察到白名单外工具时暂停投递。尚无工具目录样本属于未观测状态。

系统触发只携带宿主签发的批次号、事件类型、内部引用和固定指令。模型通过既有 MCP 工具读取带不可信来源标记的邮件内容。压缩 hook 使用当前托管会话令牌和 Native `cliSessionId` 认证，网关只接收 hook 类型和触发来源等必要字段。恢复文本按本机业务库生成，仅含宿主标识。压缩 hook 失败以非阻断错误退出。

以下记录为旧门禁的实测证据与缺口。

[Issue 162](https://github.com/Lycidas97/claude-desktop-bridge/issues/162)
阶段 0 的结论是**不满足当时的自动投递启用条件**；当时只允许独立收件及展示卡片。

2026-11-14，Desktop 5.11492.5 / Claude Code 2.1.325 的自有测试会话中：

- `dontAsk` 拒绝了配置为 ask 的 Bash 调用，指定 deny 的 Bash 也被拒绝；允许的
  Read、Bash 和无害 MCP fixture 实际成功。它决定是否等待权限答复，不定义工具白名单。
- 项目 allow 列表之外的 `printf GATE162_UNLISTED`、继承的会话查询 MCP 实际成功，
  后者能查询另一个自有测试会话。指定 deny 的 Write、Edit、跨会话发送/创建及 MCP
  fixture 工具未被暴露；未暴露不等同于完成了对所有其他工具的拒绝验证。
- Agent 仍可启动，子代理报告指定 deny 的 Bash 被拒绝。此单次对照不证明所有
  子代理、继承 MCP、跨会话写入或其他工具都受到同一套完整限制。
- 项目规则确实加载；`autoMemoryEnabled: false/true` 的新会话对照分别未获得/获得
  预置自动记忆。关闭后显式 Read 同一自有记忆文件仍然成功，且它位于 cwd 之外。
  关闭自动记忆只控制自动使用，不替代文件权限。独立目录、规则和 Section 都不是
  OS 沙盒。

当时的验收清单要求在目标 Desktop、实际模型与最终合并配置上验证内建工具、继承 MCP、
子代理及跨会话能力的允许和拒绝，验证项目规则和自动记忆策略，并验证关窗后的新投递、
锁屏投递和原 UUID 断线对账。模型口头承诺与 synthetic fixture 都不是实机证据。
阶段 0 的矩阵与未运行项见[测试文档](testing.md#desktop-自动邮件投递门禁)。

[Issue 222](https://github.com/Lycidas97/claude-desktop-bridge/issues/222) 的阶段 1 实机复核
在隔离工作区确认了打包守卫允许工作区内读取和 `outputs/` 写入，并拒绝指定的越界读写。
同一打包版本在当前托管绑定只读了真实 IMAP 的一封自有测试邮件，Native 工具回执与本机
网关的主会话归因一致。隔离会话观察到的原生工具目录未见白名单外名称，但目录不是调用
授权或最终合并配置的证据。Native 在普通关窗、退出窗口与真实锁屏状态下按原 UUID 接收
并完成了实体手机的测试消息；本轮没有独立记录手机点击发送的时刻。后续一次实机短停确认了
Bridge 后台进程退出并重新启动；新标记未见首收，重启后仅收到带旧标记的一条正常投递。
真实 `uncertain` 后的原 UUID 对账未验收。Sleep/Wake 依据用户日常休眠使用、未单独取证；其余隔离
用例也未验收，该次实测未开启自动投递。证据与缺口见[阶段 1 实测](testing.md#阶段-1-托管工作区实机复核)。

### 阶段 3 受控记忆

`stage3-fenced-memory` 默认不启用。该档位仍由 Desktop 原生权限和 `PreToolUse` 执行，不是 OS 沙盒。主会话只写 `outputs/`；`memory-curator` 只写 `memory/threads/`、`memory/notes/`；`mail-triager`、`schedule-planner` 不可写文件。挂钩识别 Native 子代理身份，拒绝角色之外的业务调用、非专职委派、链接逃逸及嵌套的原生指令文件。专职子代理只能草拟各自范围内的提案，不能列出整个会话的提案。邮件分拣可更新分析，处理状态仍由主会话更新。`Glob`、`Grep` 缺省路径按 Native cwd 检查；若递归范围含凭据配置或链接，整次拒绝。`autoMemoryEnabled` 保持关闭。

宿主管理 `CLAUDE.md`、`PROFILE.md` 和 `memory/INDEX.md`。只有 `PROFILE.md` 随项目规则导入。笔记、线程及文件名都是按需读取的低信任资料，即使来自人工回合或以前的邮件。宿主在托管 Native 回合完成后刷新索引。索引仅含宿主计算的条目标识和修改时间。按标识查找返回低信任路径。压缩恢复只增加规则版本哈希和这些标识。

Stage 1 托管主会话也可草拟 `memory.rule_upsert`。新建或恢复托管工作区时，Bridge 只导入原始规则模板或能从模板追溯到审批结果的 `PROFILE.md`；恢复不更换原生会话或令牌，已有 Native 进程在下次冷启动时加载项目规则。草拟和写入都核对文件基准。文件不匹配、缺失或无权读取时不导入、不覆盖，托管邮件仍可用。Stage 1 不开放资料目录写入、索引、查找、压缩资料注入或专职子代理。常规助手子代理不能草拟或修订规则提案；其 MCP 列表与主会话共用会话身份，因此 Stage 1 的 MCP 提案列表不返回规则提案，用户可在双端客户端查看。解绑后仍可在客户端查看和忽略旧提案，写入仍需要当前绑定和显式确认。

`memory.rule_upsert` 只创建不可变提案。客户端须显式请求规则提案，看到前后差异后以规则确认参数提交。旧客户端仍可审批其支持的提案类型。宿主将前后规则和基准哈希一起冻结；审批消耗提交版本后，记录的目标哈希在同目录临时文件写入、`fsync` 和原子重命名前已持久化。外部变更记为冲突。文件系统操作失败会结束本次提案并记录失败。启动恢复按结果哈希、基准哈希或第三种状态分别记为已写入、未写入或冲突，且无自动重放。笔记中的导入语法不能随规则提案获得递归载入权限。

实机证据和未通过的启用条件见[阶段 3 门禁](testing.md#阶段-3-受控记忆门禁)。

## 提供方与接力边界

Claude 的 provider 配置和授权由 Desktop 管理，Bridge 不再提供 standalone API Key
lane、Claude provider lane 切换或接力执行。旧配置、历史与加密接力包不导入新原生会话，
旧队列及手机 `bridgeExecutionRequested` 不转成新请求或恢复草稿。

不抽取、复制或代理官方 OAuth、第三方 Host 凭据或 API Key；各运行时会话与账号域
继续隔离。遗留数据中的敏感内容不进入事件、手机快照或 Relay；收据和 replay 只恢复
可验证的状态，不自动确认或重发不确定投递。

## 成果边界

Bridge 任务只快照本轮归因到的变化，不镜像整个项目。Claude 工具、命令和路径线索
来自 Desktop 原生事件，不为补历史扫描旧 JSONL，也不读取 `thinking`。用户打开
预览或下载时才读取源文件。

所有远程文件请求只接受服务端生成的 `artifactId`。实际读取前必须通过 `realpath`
确认目标仍位于该会话项目根目录；路径穿越、项目外绝对路径和符号链接逃逸一律
拒绝。默认阻止 `.env*`、私钥、凭据文件、认证配置和 `.git` 内部数据，V0.6 没有
远程绕过开关。工具输出中的令牌、密钥和认证头在持久化前脱敏。

单文件硬上限为 20 MiB。文本 diff 每文件最多 1 MiB、每轮最多 5 MiB；工具输出
每次最多 256 KiB、每轮最多 2 MiB，并记录截断。图片预览最长边不超过 2048 像素
且不超过 2 MiB。HTML 在独立、只读、无 Node 的临时会话中渲染，禁用网络、导航、
弹窗和权限请求，固定 1440 x 900，五秒超时后只返回静态截图。

证据清单长期保留；加密快照和预览在 30 天或总量超过 1 GiB 时按 LRU 清理。缓存
失效后，只有源文件仍在项目根内且 SHA-256 与清单一致时才允许重建。

Bridge 不展示、存储或推断隐藏 CoT，不提供任意进程求值、远程编辑、动态服务启动
或大文件绕过。Claude 本机 Node inspector 的使用范围以本节边界为准。

### 邮件附件

Bridge 在收件时将有界的附件清单与正文摘要写入助理 SQLite。分页和大小预检只查询这些元数据。原始附件保留在宿主私有的 `raw-mail/*.eml`，按邮件引用与 MIME 部件 ID 按需读取，独立于成果库和会话目录。文件名在投影时清洗。

邮件附件使用每设备最多四路的内存租约、20 MiB 单附件上限、十分钟临时密文交付和下载 SHA-256 校验。超过 1 MiB 的预览需要确认。普通图片经宿主缩放，PDF 经客户端画布显示，HTML 与 Markdown 附件只显示原始文本。无法预览的文件可以显式下载。Android 只写入用户选定的保存位置。

`mail.read_event` 返回不含字节的附件清单。当前托管会话可按需调用 `mail.read_attachment`，读取 1 MiB 以内的纯文本、Markdown、CSV、JSON 或可提取文本的 PDF。文本按声明的受支持编码解码。工具只返回有界纯文本，并标记 `untrusted_external` 和 `authorizesActions: false`。附件解码过程不向助理工作区写入文件，也不执行脚本、宏或自动投递。

### 日历与待办提案

托管会话的令牌仅授权创建、修订和读取该会话的提案。无论由聊天还是外部事件触发，模型工具只生成提案引用。内联卡要求 Native 工具调用、工具结果与账本会话一致。模型修订需要自己的回执；用户手动修改可沿用它所基于的模型版本的回执。无法关联的修订只在待确认页查看。

已配对手机通过 E2EE RPC 确认，本机桌面通过受信任的 IPC 确认。宿主从认证连接取得操作者身份，在 SQLite 事务内核对提案 ID、修订号与规范化载荷哈希，并记录唯一一次执行。编辑生成新修订。本地议程写入与执行结果在同一事务内完成，修改已有记录还需匹配原版本。

CalDAV/VTODO 创建使用固定资源地址与 `If-None-Match: *`。修改和删除使用提案保存的强 ETag 与 `If-Match`。宿主在请求前持久化执行记录，响应丢失或宿主中断后只读核对原资源，无法证实时保留「结果不确定」。提案变更经 E2EE 传输，手机推送沿用无正文的 `bridge-wake`。外部事件自动投递仍受独立开关控制。

### 邮件外发提案

`mail.reply` 和 `mail.send` 沿用同一不可变账本。宿主核对原邮件属于所选账号，从原信解析线程头，并从配置取得发件地址；不接受 `Bcc`。省略回复收件人时使用原信 `From`，不自动改投 `Reply-To`。二次确认抽屉展示规范化发件账号、地址、全部 `To/Cc`、主题、正文和版本，并醒目标记异域 `Reply-To`。发信只接受明确确认同一提案三元组的已配对客户端或受信任 IPC；没有发信能力的旧请求不能预览或提交邮件提案。MCP 不能配置发信通道、消费批准或调用 SMTP。

SMTP 通道可独立关闭，只使用验证服务端证书的 TLS 或强制 STARTTLS，并要求 SMTP 认证。新账号的收发信共用同一个系统 Keychain 条目，旧账号继续使用原独立发信凭据，直到用户明确切换。启用发信、更换发信主机、端口或加密方式，以及切换授权来源，都必须本次提交凭据。共用授权下，仅更新发件地址时可保留原凭据；不会把已有收信密码直接用于新端点。密码不写入账号文件或同步快照。更换通道、发件身份或授权来源后，先修订再确认。发信前，同一 SQLite 事务消费批准并写入 `send_attempts`；实际信封只使用已批准的地址。邮件服务器可能接受部分收件人，Bridge 保留接受与拒绝名单，不会补发。

断线而无法确认结果，或消费后宿主中断，保留 `delivery_uncertain`；重启不重放。请核查「已发送」，找不到副本不等于未发出。SMTP 接受也不等于送达收件人邮箱。Bridge 不承诺跨 SQLite 和 SMTP 的 exactly-once。

## 生产要求

- 公网只允许 HTTPS/WSS，并设置严格的 `BRIDGE_ALLOWED_ORIGINS`。
- 默认公共 STUN 不承载业务数据。自托管 STUN/TURN 时只开放实际使用的端口并设置
  速率保护；TURN 长期密钥只能留在服务端，客户端只接收短期凭据。
- Relay 使用 SQLite WAL 持久卷，密文默认保留七天，每房间最多 2,000 条或 128 MB；
  每日备份保留七份；成果临时响应不得进入该持久队列。
- Relay 数据目录和 FCM 服务账号不得进入镜像或源码。
- 配置 macOS notarization、Windows code signing 和 Android keystore。
- Windows 安装包必须使用 Authenticode 签名；Bridge 的 `safeStorage` 在 Windows
  由 DPAPI 保护。旧凭据不迁移到手机、Relay 或安装包，Claude 不恢复 standalone API Key lane。
- 为桌面安装包建立签名自动更新源；升级必须保留设备配置与事件日志。
- 单机自签只允许存放在 Bridge 专用钥匙串中，信任策略必须限定为 `codeSign`，不得
  复用为 TLS/邮件证书或把私钥、钥匙串密码、`.p12` 放入仓库和发布产物。
- 丢失手机时，从另一台已授权设备或电脑“设备”页立即撤销。

## 仍需外部条件

仓库已实现 Android FCM 通道，但真实后台推送需要 Firebase 项目、
`google-services.json`、应用标识和已签名安装包。未提供这些外部
凭据时，App 前台与重新打开后的离线恢复可用，但不能宣称锁屏即时唤醒已发布。
