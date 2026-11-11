# Bridge 后台服务

本文说明 Claude Desktop 原生接入下的后台行为，适用于 1.3.1 和当前源码。Claude 会话、任务、队列与权限由 Desktop 的 `LocalSessions` 管理；Bridge 后台负责本机中转、手机连接、事件同步和文件传输，不再启动 Claude SDK / CLI 执行器。旧 Host 架构的验收记录见[重构记录](HOSTING-REFACTOR.md#旧-sdkcli-host-记录历史)。

## 窗口、后台与 Desktop

- **Bridge 窗口**显示会话和设置，通过经过令牌认证的本机 WebSocket 连接后台。关闭窗口或断开 UI 订阅不会停止后台，也不会向 Claude 发送 interrupt / stopTask。
- **Bridge 后台服务**使用同一可执行文件的 `--bridge-service` 入口，独立于窗口运行；通过本机 Node inspector 转发固定的 `LocalSessions` 操作，并同步原生事件。停止服务会断开手机与转发连接。
- **Claude Desktop / Claude-3p**拥有 Claude 原生任务与队列。Bridge 退出不等于 Desktop 退出；Desktop 的关闭、崩溃或电脑关机造成的执行中断不能由 Bridge 恢复为原现场。手机上的“停止任务”是单独的原生操作，需要用户确认。

重新打开窗口会连接现有的兼容后台。只有连接文件不存在或监听端口明确拒绝连接时才启动后台；版本不兼容、认证失败与超时会显示错误。窗口意外断线后重连、补发事件并刷新快照，不会借此重新提交业务请求。

## 进程与数据位置

- `main.ts` 管理窗口、托盘与后台启动；`service-runtime.ts` 装配原生中转、Controller、存储、Relay / WebRTC 和调试连接监测。
- 本机服务监听 `127.0.0.1` 随机端口，拒绝浏览器 Origin。连接描述文件位于 Bridge userData 的 `background-service/connection.json`，权限为 `0600`；该端口与 Desktop 的默认 inspector 端口 `9229` 是两条不同的连接。
- 后台 Chromium profile 位于 userData 的 `background-service/profile`，使用独立单实例锁。配对、事件和成果等业务数据仍使用原 userData；`BRIDGE_USER_DATA` 仅覆盖原有 Bridge 配置文件位置。
- 后台保留 Electron safeStorage 用于已有本机凭据配置。配对身份与成果主密钥使用权限受限的本地配置文件，具体存储边界见[安全模型](SECURITY.md)。

服务启动阶段与错误显示在启动窗口中。后台日志位于 userData 的 `background-service/service.log`，权限为 `0600`；初始化失败会释放已建立的资源并报告错误。

## 请求与恢复

Claude 输入通过 Desktop 原生接口发送，接收、排队与完成是不同状态。Bridge 持久保存请求幂等键和原生消息收据，重连后按原生事件与历史核对状态；投递未确认时不会自动重发，也不会另起执行器。

历史分页直接读取 Desktop transcript 接口。Desktop 不可用时，不从旧 Bridge 历史或事件日志伪造回退。旧队列和手机缓存的 `bridgeExecutionRequested` 不会恢复执行。重启 Bridge 可以恢复连接和可核验状态，不能复活已退出的 Desktop 进程。

1.3.1 仍保留独立 Codex / Hermes / DSH 适配器，其执行与退出规则不属于本文的 Claude 原生任务保证。当前候选源码已移除这些适配器；版本范围见[首页](../README.md#版本与下载)。

## 退出与更新

| 操作 | 结果 |
| --- | --- |
| 关闭窗口 / 托盘“退出窗口（任务继续）” | 后台继续连接手机，Claude 原生任务仍由 Desktop 管理 |
| 托盘“停止后台服务并退出…” | 确认后关闭 Bridge 后台与手机连接；Claude 原生中转关闭只退订并断开，不发送 interrupt / stopTask |
| 在会话中确认停止任务 | 通过 Desktop 原生接口请求中断对应工作，与退出 Bridge 分开 |
| 退出 Desktop / 电脑关机 | 影响原生会话的执行与连接；Bridge 不提供进程现场恢复 |

旧版退出确认框可能仍显示“会中断 Bridge 托管的任务及后台子代理”的通用文案，不能据此将 Claude 原生任务当作 Bridge 托管进程。

更新安装包后，新窗口可能仍连着旧后台。等任务结束，通过托盘停止后台服务，再打开新版 Bridge，后台代码才会更新。升级保留手动连接设置与配对身份，不需要清空数据或重新配对。

## 验证范围

`npm run test:desktop:service` 使用隔离 home / userData、编译后的真实 Electron Bridge 和模拟 Node inspector / `LocalSessions` 边界，验证窗口退出与崩溃、重连、原生请求身份、权限等待、收据恢复，以及退出 Bridge 时不调用 interrupt / stopTask。该脚本不启动手机客户端或 Relay，不验证手机配对与重连。

这些测试不连接生产会话或公网中继，不调用真实模型，不更改已安装 Desktop，也不覆盖 Android 真机的通知、系统权限或后台保活。已安装 macOS Desktop 的独立冒烟范围与历史验收结果见[重构记录](HOSTING-REFACTOR.md)；测试入口与准备见[测试说明](testing.md)。
