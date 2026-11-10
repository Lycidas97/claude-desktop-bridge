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
  不发送键鼠事件或读写剪贴板；Codex、Hermes、DSH 的原生接入不变。
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

FCM/APNs 请求只包含无正文唤醒标记。推送服务不会收到会话 ID、标题、摘要、消息
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

### 多 Desktop adapter

Bridge 0.6 统一操作体验，不合并原生会话域。每个会话的本机身份是
`(runtimeId, nativeSessionId)`；运行时相同的原生 ID 不会相互覆盖，Bridge 也不会在
Claude、Codex、Hermes 间复制历史、认证、模型选择、权限规则或自动故障转移。

`CodexAppServerAdapter` 只启动 Bridge 自己拥有的官方 `codex app-server --stdio` 子进程，
不附着已有 app-server 或 Codex Desktop 进程。`HermesGatewayAdapter` 只连接 `localhost` /
`127.0.0.1` / `::1` WebSocket；未配置 Gateway 时由 Bridge 启动 Hermes sidecar，并为该进程
生成随机会话令牌。Bridge 不读取 Hermes Desktop 的 token、keychain 或远端 Gateway 地址。DSH Desktop 经其宿主自带的回环 /api 契约接入（Host 头信任栅栏），Bridge 不读取 DSH 的凭据文件。
adapter 启动超时、关闭或重试时必须关闭其自有子进程，不能保留后台访问通道。

Codex/Hermes 的账号、凭据、token、keychain 和全局配置只在相应 Desktop 内管理。Bridge 可以在
adapter 显式声明能力后，通过原生接口修改当前会话的模型、provider、思考强度和快速模式；这类操作
不提取、不记录或传输凭据，也不执行跨运行时迁移。外部 adapter 的图片附件和其他非共同能力默认关闭，
只有显式能力声明才能在 Bridge UI 开放。

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

## 生产要求

- 公网只允许 HTTPS/WSS，并设置严格的 `BRIDGE_ALLOWED_ORIGINS`。
- 默认公共 STUN 不承载业务数据。自托管 STUN/TURN 时只开放实际使用的端口并设置
  速率保护；TURN 长期密钥只能留在服务端，客户端只接收短期凭据。
- Relay 使用 SQLite WAL 持久卷，密文默认保留七天，每房间最多 2,000 条或 128 MB；
  每日备份保留七份；成果临时响应不得进入该持久队列。
- Relay 数据目录、FCM 服务账号和 APNs 私钥不得进入镜像或源码。
- 配置 macOS notarization、Windows code signing、Android keystore 和 iOS
  provisioning profile。
- Windows 安装包必须使用 Authenticode 签名；Bridge 的 `safeStorage` 在 Windows
  由 DPAPI 保护。旧凭据不迁移到手机、Relay 或安装包，Claude 不恢复 standalone API Key lane。
- 为桌面安装包建立签名自动更新源；升级必须保留设备配置与事件日志。
- 单机自签只允许存放在 Bridge 专用钥匙串中，信任策略必须限定为 `codeSign`，不得
  复用为 TLS/邮件证书或把私钥、钥匙串密码、`.p12` 放入仓库和发布产物。
- 丢失手机时，从另一台已授权设备或电脑“设备”页立即撤销。

## 仍需外部条件

仓库已实现 FCM/APNs 通道，但真实后台推送需要 Firebase 项目、
`google-services.json`、APNs Key、应用商店标识和已签名安装包。未提供这些外部
凭据时，App 前台与重新打开后的离线恢复可用，但不能宣称锁屏即时唤醒已发布。
