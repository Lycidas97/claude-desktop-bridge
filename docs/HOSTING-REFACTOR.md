# Claude 原生中转与历史验收记录

## Claude 原生中转（2026-11-08）

当前分支通过用户已开启的本机 Node inspector 调用 `claude.web.LocalSessions`，
由 `claude-desktop-bridge.ts` 转发业务调用与原生事件。Desktop 独占会话执行、队列和
权限；退出旧 Host、standalone API Key lane、接管/交还、inbox、Claude lane 与自动
goal 续跑。直接使用原生会话 ID 与 Desktop 历史，不导入旧数据、不建立旧 ID 关联、
不回退旧历史或恢复旧草稿；旧会话数据与配对身份保留。旧队列和手机缓存的
`bridgeExecutionRequested` 不自动重发。精准卸载 Hook/MCP 只清理退役的连接组件。

本次验证使用 macOS、Node.js 25.6.1；仓库开发与 CI 推荐版本仍是 Node.js 26。

| 验证 | 结果与边界 |
| --- | --- |
| `npm run verify` | 边界修复后类型检查与完整构建通过；Desktop 766、客户端 644、协议 44、Relay 27、插件 62 项，共 1543 项通过。DSH 真实环境和原生 WebRTC 两项可选测试未启用。 |
| 真实已安装 Claude Desktop（初次冒烟） | 新 inspector 与中转门面通过空会话创建、发送、原生 UUID 生命周期及完成收据、终态索引、历史回复、重复请求不重发、关闭 Bridge 不发送 interrupt/stopTask、原生会话保留。只捕获专用测试会话，结束后归档。证明：`output/native-check/facade-proof.json`。 |
| 浏览器联合测试 | 真实客户端、加密业务 RPC、Controller 与中转门面，LocalSessions 边界为模拟；Chrome 明暗主题共 8 项通过，覆盖重命名、投递、重连、原生审批/提问与授权模式设置。报告：`artifacts/browser-e2e/2026-11-08T18-35-29.943Z/report.json`。 |
| `npm run test:desktop:service` | 真实编译 Electron Bridge UI/服务与模拟 Node inspector/LocalSessions；UI 正常退出、崩溃与重连保留任务和原生审批 ID；服务关闭只退订，interrupt/stopTask 为 0；服务重启恢复收据，同幂等请求不重发（sendMessage 共 1 次），原 requestId 回复审批，原生结果完成原 commandId，历史与 UI 正确。证明：`output/service-restart-UXORjS/proof.json`；其构建 SHA-256 与最终 `dist/main.cjs` 一致，测试进程均已退出。 |

真实 Desktop 冒烟不代表所有 LocalSessions 操作均已完成真实端到端验证；原生审批、
提问及单个子代理停止仍以契约/模拟测试为依据。重构与边界回归未包含 Android 真机
或其他平台原生接入验收；后续本机安装及 APK 构建见生产测试部署记录。改动尚未提交
或推送。

完整实现边界见[架构](ARCHITECTURE.md#claude-原生接入)与[安全模型](SECURITY.md#claude-node-inspector)。

### 边界回归（2026-11-08）

新增 34 个隔离回归用例：中转门面 17 个、inspector 10 个、手机连接与待发箱 7 个。
测试通过延迟 RPC、可控事件顺序、真实 HTTP/WebSocket 连接和模拟 LocalSessions 注入
故障；SQLite 与手机内存存储均使用测试数据，未连接真实 Desktop 或 Relay。

| 失败序列 | 修正后的行为 |
| --- | --- |
| `sendMessage` 尚未返回 → 原生接收/开始/完成/失败/中断事件已到 → RPC 随后断连 | 保留原生证据，不降回 uncertain，也不重发。 |
| 原生 result 已确认终态 → 迟到 queued/started/completed；或 started 后收到旧 queued | 生命周期消息不覆盖已有终态，也不把 running 降回排队。 |
| 未确认投递发起历史核对 → 等待期间收到 result → 较旧历史不含 UUID；或完成后收到旧确认操作 | 返回已确认的终态，清除旧传输错误，不以旧历史降级或误报未确认。 |
| 只收到原生权限事件，尚未刷新会话列表 | 对应会话立即显示 waiting；未知会话不生成审批，回复只处理选定的原生 requestId。 |
| 第一个事件订阅成功 → 第二个权限订阅缺失或抛错 | 回收已建立的订阅，再报告初始化失败；重连后每条流只有一个订阅。 |
| 事件 next 已在旧页面等待 → 页面消失 → 下一次普通 RPC 首先观察到失效 | 转入已有 renderer-reloaded 断连路径，撤销 ready，后续发送被阻止。 |

另确认：20 个并发重复请求只调用一次原生发送；崩溃时 dispatching 收据重启后保留
uncertain；相同 UUID 不会跨会话认领结果；断线历史不回退 eventlog；超时后的迟到
成功/失败响应不影响后续 RPC；已执行而丢失回包的发送不自动重放。手机缓存能力不能
代替实时快照，旧 `bridgeExecutionRequested` 不阻塞后续 native start/steer，重复
flush 复用原信封与幂等键，传输确认后停止重发，旧消息和附件保持原样。

当前仍未覆盖 WebSocket 握手一直挂起、unsubscribe 自身抛错、connect/close 并发，
以及真实手机持久化故障；这些情形未计为通过。

### 本机生产测试部署（2026-11-08）

按用户授权正常停止旧 Bridge 窗口与后台服务，备份旧应用后通过系统废纸篓替换安装
`/Applications/Bridge.app`。本机没有稳定代码签名身份，沿用原安装的 ad-hoc 签名方式；
未修改或重启 Claude Desktop。新版窗口与生产服务均已启动。

生产环境实际检查通过：原有 8 个设备的配对身份与密钥摘要保持一致，pairing epoch
仍为 1；Relay 已连接且健康。230 个 Claude 会话全部来自原生接口，运行状态为
working。通过已安装应用的真实 Electron 窗口点击会话页并查看截图，渲染错误为 0；
随后以正常方式重新打开窗口，继续连接生产后台服务。安装包中的主程序与已验证构建
哈希一致，包含 native-relay 能力，不含旧 Claude SDK 执行依赖。

Android 产物为 `Bridge-1.2.1-native-v106.apk`，包名 `com.localbridge.mobile`，
versionName 1.2.1、versionCode 106，沿用仓库固定 debug 证书。APK 签名、ZIP、
原生插件与全部 10 个 DEX 校验通过；34 个前端资源与已安装桌面包逐字节一致。
SHA-256：`ddabbbc3327304759e7d4c39d0b333e4be7b5c71a71cbc7fd452a260770aaeb2`。
安装包已通过会话文件附件交付，未上传外部文件服务器；尚未安装到 Android 真机。
源码与 APK 资源均未提供 Firebase app/sender 配置，因此 FCM 远程后台推送未启用。

部署证明保存在 `output/production-native-fKw6Dp/production-after.json`、
`production-ui-proof.json`、`apk-verification.json` 与 `deployment-verification.json`；
旧应用备份为同目录下的 `previous-Bridge.app`。用户数据库与配置没有复制到仓库。

## 旧 SDK/CLI Host 记录（历史）

> 以下原记录属于旧 SDK/CLI Host 托管架构，原样保留；勾选项与 v45 验收不代表当前 Claude 原生接入的验证结果。

本任务是整个底层托管流程重构。移动端 UI 测试、单独进程拆分或中间构建均不能作为整体交付依据。完成实现与集成验证之前，不安装或交付 v44，也不替换正在使用的 Bridge。

## 验收范围

- [x] 命令提交、CLI 接收、执行终态各有明确证据；已送达不能推导成功完成。
- [x] 重启和所有权冲突使用相同完成证据；未确认的执行不自动重发、不伪造完成。
- [x] 长会话与日志压缩后仍能查询当前命令收据，查询不依赖 UI 分页上限。
- [x] Host 直接接入 SDK 初始化、后台任务完整列表、任务开始/进度/终态与进程退出。
- [x] 主轮完成而后台任务或授权仍存活时保留 Host；停止请求和停止确认分开。
- [x] 列表、历史、实时事件、手机状态使用同一任务事实；外部 Desktop 观察与 Bridge 自有进程分离。
- [x] 移出已停用 managed/CDP 执行分支；旧持久队列有明确恢复处理。
- [x] 调度保持每会话串行、全局额度和公平推进，一个会话慢启动不阻塞其他会话。
- [x] Broker 只保留命令与执行编排；完成证据、状态投影及 Desktop 集成职责有明确边界。
- [x] 启动显示阶段与失败原因；初始化失败关闭已建立资源，退出释放资源。
- [x] 单元与集成回归通过，并独立审查改动。
- [x] 真实 Electron + Agent SDK 管道验收：退出/崩溃UI、恢复审批、队列推进、后台任务保活/停止、服务退出。
- [x] 手机与新服务链路验证，真实 CLI 能力差异如实记录；不得用旧 QA 主机替代新架构验收。

## 当前基线

独立服务入口（main.ts / service-runtime.ts / service-connection.ts）及上述托管范围已完成，v45 从最终当前源码构建。当前安装仍是旧版，本轮没有替换正在使用的应用。

针对竞态和生命周期变化先写可重现失败测试，随后实施。测试使用隔离数据，真实用户数据库/配置不复制到仓库；文件删除只用系统废纸篓。

## 最终验收记录

- 全工作区 TypeScript 检查通过；桌面 524 项、客户端 273 项、中继 27 项、协议 35 项回归通过。完整桌面套件采用串行执行并为系统废纸篓清理预留时间；先前修改过程中的测试结果不作为最终依据。
- 额外启用真实本机 WebRTC DataChannel 验证，1 项通过。仍未启用真实账户 Claude M0 与 DSH 环境测试，不把它们计为通过。
- 独立 `code-review` 审查与后续 Broker 审查发现的问题均经过失败复现与修复，包括初始化异步清理、强制停止保留执行额度、排队取消的证据归属、压缩恢复、任务重复执行与历史游标。
- 最终真实 Electron + Agent SDK + 测试 CLI + 本机加密 Relay 联合测试：`output/service-restart-4bV9GJ/proof.json`，18 项断言全部通过；无桌面窗口 20,537 ms 后两个后台任务仍运行；停止请求与终态通知分离；CLI 退出与重新启动、手机重连、服务关闭均通过，所有测试进程已退出。
- 最终打包 app 实际启动与界面操作通过：`output/hosting-final-v45/packaged-smoke/proof.json`。使用隔离 HOME/userData；UI 退出后服务继续响应，显式关闭后服务退出。
- 桌面 build 10377 与 Android versionCode 77 使用同一份 238 个前端资源；161 个合并源码输入哈希与冻结源码匹配。Android 原生 Gradle 构建、签名连续性、ZIP、10 个 DEX 及必需类检查通过。核验记录：`output/hosting-final-v45/delivery-verification.json`。

## 验证范围与交付限制

联合测试的手机页面运行在独立 Electron 移动尺寸窗口，通过真实加密 Relay 连接新服务；不是 Android 真机原生通知或系统保活验收。SDK 为已安装版本，后台任务由测试 CLI 确定性驱动；较早真实 CLI 2.1.309 的提交/接收/结果冒烟记录保留在 `output/hosting-real-cli-20261101/proof.json`，最终验证没有再次调用真实账户。

macOS 包为本机 ad-hoc 签名，签名完整性已验证，未做 Developer ID 公证；Android 为沿用原证书的 debug APK。本轮没有安装、上传、提交或推送代码，也没有部署公网 Web UI。
