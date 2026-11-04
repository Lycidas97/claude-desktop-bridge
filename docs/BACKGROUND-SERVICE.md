# Bridge 后台会话服务

Bridge 桌面窗口与会话运行时使用独立进程。窗口重新打开时连接同一后台服务，保留运行中的 Claude CLI、排队指令、权限等待及手机连接。

执行进程由 Bridge 后台服务通过现有 Agent SDK 启动，仍使用原来的模型与网关配置。此架构不通过 Claude Desktop 的私有调试入口启动进程，不生成或使用 `CLAUDE_CDP_AUTH`。

## 进程与数据所有权

- `main.ts` 的默认入口运行桌面窗口、托盘、renderer IPC 校验和文件保存对话框。
- 同一可执行文件以 `--bridge-service` 运行后台入口，不创建常驻窗口或托盘；HTML 预览仍可使用隐藏的 Electron 窗口。
- `service-runtime.ts` 装配唯一的 DesktopController、SessionBroker、PermissionBroker、TranscriptObserver、事件日志、SQLite 状态与证据存储、原生运行时适配器及 Relay/WebRTC。
- `service-connection.ts` 提供经过令牌认证的本机 WebSocket 调用。只监听 `127.0.0.1` 的随机端口，拒绝浏览器 Origin；连接描述文件以 0600 写入原 userData 的 `background-service/connection.json`。
- 后台 Chromium profile 位于原 userData 的 `background-service/profile`，使用独立的 Electron 单实例锁。业务数据仍使用原 userData；`BRIDGE_USER_DATA` 仍仅覆盖原有配置文件路径。
- 后台保持应用名称，继续使用 Electron safeStorage。没有把现有加密密钥改存为明文，也不修改模型、网关或用户凭据。

UI 优先连接现有服务。只有连接文件不存在或监听端口明确拒绝连接时才启动后台；版本不兼容、认证失败和超时会显示错误。UI 连接断开只移除订阅，后台继续运行。意外断线重连后按事件序号补发，并刷新完整快照；请求不会自动重发，原有业务幂等键继续生效。

## 命令、任务与恢复

- 命令进入 SDK 前持久化输入标识和提交意图，提交不代表 CLI 已接收；CLI 回显相同输入 UUID（或可归因的结果）才确认接收和开始执行。
- `session-event-log.ts` 保存独立于界面分页的命令收据；日志压缩保留提交、接收、完成、失败、中断及输入标识。`command-evidence.ts` 将收据与精确的 transcript 后代链合并。其他用户输入及其结果不能替本轮确认完成。
- 恢复与所有权冲突共用证据判断。未提交的队列可继续；已经提交但没有终态的执行记为中断，不自动重复执行，不伪造成功。旧 managed 队列保留待确认状态，不占用执行额度；生产 Broker 不再调用私有 Desktop/CDP 传输。
- `ClaudeSessionHost` 转换 SDK 初始化、任务集合、任务开始/进度/通知与流退出；`SessionTaskState` 按进程代次统一列表、历史和停止目标。停止控制请求成功只表示请求已发送，终态由 SDK 通知或进程退出确认。
- 主轮结果不代表 Host 可以关闭。后台任务、未消费输入和待审批仍存活时保留 Host。任务被 SDK 集合移除而没有终态时显示“状态未知”；外部 Desktop 会话保持只读观察，不能用空闲时长推断任务完成；用户在手机上确认停止时，Bridge 向该会话最新的 Desktop 进程发送 SIGINT，CLI 中止请求并写入中断记录，进程内的子代理和后台任务随之结束。
- 调度为每会话保留独立启动位置，同时遵守全局额度；一个会话的占用检查或配置等待不会阻塞其他可执行会话。取消、退出及释放期间的执行由对应回归约束。
- `session-history.ts` 负责 transcript／事件／SDK 任务的历史合并和游标；`session-desktop-registration.ts` 负责 Desktop 登记任务与持久化；`session-model-catalog.ts` 负责模型目录、名称映射与能力元数据。Broker 保留命令去重、调度、取消和执行编排。
- SDK 任务以工具调用标识区分每次执行；同一个任务 ID 再次运行会保留各次历史。前台任务的明确运行事件与后台任务集合分别处理；`skip_transcript` 任务不进入对话卡片。SDK 初始化取消、强制停止及所有权冲突均须完成进程和持久化清理后才释放服务。
- 历史合并保留原 transcript 时间戳，跨来源分页使用一致排序；事件历史继续读取来源游标，不受单页一万条限制。压缩后的内容摘要用于去重，后台任务事实不会被普通工具心跳覆盖。

## 启动与故障

启动窗口显示配置、数据库、会话扫描、权限回调和运行时连接等实际阶段，失败保留阶段与错误。后台日志位于 `background-service/service.log`，权限为 0600。每项资源在初始化前登记清理，失败时逆序释放已建立资源；单项清理失败不会跳过剩余清理，也不会静默丢弃错误。

## 退出与更新

- **退出窗口（任务继续）**：退出桌面 UI，后台及手机连接继续工作。系统退出应用和 UI 崩溃也不主动停止后台。
- **停止后台服务并退出…**：确认后关闭手机连接、会话宿主和后台进程；会中断 Bridge 托管的任务及子代理。
- 打开新版本 UI 会继续连接现存的兼容后台。因此更新后的后台代码要在任务结束后，通过停止后台服务再重新打开 Bridge 才生效。
- 此保证覆盖 UI 的退出和重启。后台服务被杀死、系统关机或断电仍会中断 CLI；不承诺把已经死亡的 SDK 进程恢复为原来的执行现场。
- 从旧版单进程 Bridge 升级，已经运行的 CLI 不能无损迁移给新服务。首次部署应等旧版任务完成后退出旧版。

手机仍使用原来的加密协议。新增的本机服务端口不监听公网，也不要求额外部署 Web UI。

## 验证

`npm run typecheck -w @bridge/desktop` 检查类型。

`npx vitest run --root apps/desktop src/service-connection.test.ts src/claude-session-host.test.ts src/session-broker.queue.test.ts` 验证连接、权限、事件回放与会话生命周期。连接测试还覆盖回放中再次断线时仅重连一次、关闭仍在握手的客户端，以及同步期间收到的新快照不被旧响应覆盖。

`npm run test:desktop:service`（`scripts/service-restart-qa.mjs`）创建全新的 `output/service-restart-*` 目录，从当前源码构建主进程、preload 和客户端，启动隔离的真实 Electron。测试专用 bootstrap 将 home/userData 指向临时目录；假 CLI 通过真实 Agent SDK 的 stream-json 管道处理请求，不调用模型。脚本覆盖正常退出、强制结束 UI、重新打开、同一待审批请求回答、无窗口时任务完成与下一条排队任务启动、幂等请求、明确停止后台，以及不同 Chromium profile 之间的 safeStorage 测试密文解密。

`npm run test:desktop:service -- --mobile` 增加仅监听本机的真实 Relay 和独立手机尺寸客户端，完成界面配对、加密消息与权限审批。后台任务在桌面窗口关闭超过释放延迟后仍保持运行；手机在不刷新的情况下收到任务和停止能力，停止确认后须等 CLI 终态通知；CLI 退出、重新启动及手机重连后的终态历史也纳入断言。该客户端使用 Electron 中的移动页面，不能替代 Android 设备原生权限、通知或系统保活验证。

测试不连接公网中继，不复制真实用户配置，不重启已安装应用。结果和截图保留在各次隔离目录。当前进程驱动针对 macOS；需预先安装项目依赖。
