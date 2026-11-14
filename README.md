# Bridge · Lycidas97 Fork

[English](README_EN.md) · [下载](https://github.com/Lycidas97/claude-desktop-bridge/releases) · [更新记录](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md)

<img src="apps/client/public/bridge-mark.svg" width="84" alt="Bridge logo" align="right" />

**在 Android 手机上继续电脑里的 Claude 工作。**

Bridge 把 Claude Desktop 的本地 Code 会话带到手机：接着聊、排队发送下一条指令、回答授权与提问、查看子代理进度和工作区文件。任务仍在你的电脑上运行。

这是独立维护的 fork，日常使用与验证主要围绕 **macOS + Android + Claude Desktop（含 Claude-3p）**。它依赖 Desktop 的本地 `LocalSessions` 接口，具体操作取决于已安装的 Desktop 版本与账号 / 工作区策略；普通网页聊天记录不属于这条接入路径。

原生手机端支持 Android，通用手机 Web 客户端继续保留；原生 iOS 产品线已退役。

## 版本与下载

**当前正式版是 [v1.3.1](https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.1)，下方上手步骤以该版为准。** 请从本 fork 下载电脑端和手机端，尽量使用同一版本。

| 平台 | v1.3.1 下载 | 安装与验证范围 |
| --- | --- | --- |
| macOS | [电脑端 ZIP](https://github.com/Lycidas97/claude-desktop-bridge/releases/download/v1.3.1/Bridge-1.3.1-macos-adhoc.zip) | 解压后使用内含安装包。ad-hoc 签名，未经 Apple 公证；主要验证平台 |
| Android 8.0+ | [APK](https://github.com/Lycidas97/claude-desktop-bridge/releases/download/v1.3.1/Bridge-1.3.1-android-debug.apk) | 使用仓库固定 debug 签名；需允许当前下载来源安装应用 |
| Windows | [安装包 ZIP](https://github.com/Lycidas97/claude-desktop-bridge/releases/download/v1.3.1/Bridge-1.3.1-windows-installer-ci.zip) | CI 构建；签名状态见包内 `windows-release-evidence.json`，原生连接未完成实机验收 |

发布页同时提供 `SHA256SUMS.txt` 与 `SOURCE_COMMIT.txt`。构建成功不代表所有平台均完成实机验证；Android 系统返回流程已在 Android 16 模拟器中验证。

当前源码正在准备 **1.3.2 候选版**：收敛为仅适配 Claude Desktop、修复任务完成通知、增加大于 1 MiB 文件预览前的大小确认、长电脑名下的连接状态展示、子代理实际响应模型、会话实时上下文水位展示、保存字号、手机端新建与移动原生 Section（含浏览电脑目录时按需新建文件夹），以及修复 Mac 新用户配置按钮置灰并按任务归类重排桌面 / 手机设置。这些还不是 1.3.1 发布包的能力；其中文件大小检查、Section 移动与按需新建文件夹需要同时升级电脑端。1.3.1 仍含独立 Codex / Hermes / DSH 适配器，本文不将其作为推荐上手路径。Claude Desktop 内部的 Gemini、Antigravity、Magpie 模型与额度功能属于 Desktop 接入，不等同于这些独立 Agent。

在 1.3.2 正式发布前，下方上手步骤仍保留已发布 1.3.1 的界面入口（候选版桌面设置已归入“设置 → Claude 接入 / 连接与启动”等分组）与手动回退方式。完整变更见 [Changelog](CHANGELOG.md)；技术文档随源码维护，可能描述候选版。

## 开始前准备什么

| 位置 | 职责与前置条件 |
| --- | --- |
| 电脑 | 安装并登录 Claude Desktop 或 Claude-3p，确认能在电脑上正常使用本地 Code 会话；安装 Bridge，保持电脑开机、联网且 Desktop 运行 |
| 手机 | 安装 Android Bridge，作为已配对电脑的操作界面；无需在手机配置模型 API Key |
| 中继 | 两端能访问同一个 WebSocket 中继，用于配对、连接与直连失败时的转发；可以使用已有可信中继或[自行部署](docs/RELAY-REDEPLOY.md) |

使用安装包不需要另外安装 Node.js、npm 或 Android SDK。服务器只需运行中继，不需要部署公网 WebUI。手机离开前台后，电脑任务继续；电脑休眠、断网或退出 Desktop 会影响连接与工作。

## 第一次连接

### 1. 安装并打开电脑端

从上方下载 Bridge，解压并按包内安装方式安装。macOS 将 Bridge 放入“应用程序”后打开；若系统拦截未经公证的应用，请在核对来源后使用系统提供的“仍要打开”等入口。

先启动一次 Claude Desktop / Claude-3p 并完成登录，再打开 Bridge。Bridge 的“状态”页会分别显示 **Claude 通道**和**连接路径**：前者连接 Desktop，后者连接手机与中继，需要分别检查。

### 2. 开启 Claude Desktop 的本机连接（macOS）

这一步包含两个设置：允许 Desktop 显示开发者工具，以及开启主进程调试端口。

1. 在 Bridge 打开 **设置 → 诊断与关于 → Claude Desktop 开发者工具**。如果同时检测到 `Claude` 与 `Claude-3p`，选择实际使用的配置目录。
2. 检查 `developer_settings.json` 中的 `allowDevTools` 是否为 `true`。“一键开启”只负责写入这个字段；**它不等于开启 inspector，也不保证弹出 macOS 权限请求**。按钮置灰或检查失败时，按下方手动配置。
3. 配置变更需要在 Desktop 下一次启动时加载。等当前任务结束，退出并重新打开 Claude Desktop / Claude-3p；Bridge 不会替你重启它。
4. 在 Desktop 的原生菜单选择 **Developer → Enable Main Process Debugger**。默认连接地址为本机 `127.0.0.1:9229`。菜单可能受账号 / 工作区策略限制，原生操作也可能打开 Chrome 调试页。
5. 回到 Bridge 检查“状态”中的 Claude 通道是否“已就绪”或“运行中”，并查看“诊断与关于 → 调试连接监测”的错误。端口开放本身不代表 `LocalSessions` 已可用。

<details>
<summary>按钮不可用时，手动配置 developer_settings.json</summary>

使用与你运行的应用对应的文件：

- Claude：`~/Library/Application Support/Claude/developer_settings.json`
- Claude-3p：`~/Library/Application Support/Claude-3p/developer_settings.json`

先启动一次对应应用，让它创建配置目录。等任务结束并退出 Desktop，备份现有文件，再用文本编辑器将 JSON 对象中的 `allowDevTools` 设为 `true`，保留其他字段。若文件不存在，在已有配置目录中新建：

```json
{
  "allowDevTools": true
}
```

确保文件是有效 JSON，再重新打开 Desktop，并从原生菜单开启主进程调试。不要将这段内容覆盖到 `claude_desktop_config.json`，那是另一份配置。出现文件权限或 JSON 错误时先处理具体错误，重新检查按钮不会代替修复文件。

</details>

**1.3.1 的自动开启尝试：** macOS 后台发现新的 Desktop 进程后，会尝试通过同一个原生菜单开启一次 inspector。它需要你在 **系统设置 → 隐私与安全性 → 辅助功能**中允许 Bridge，并在**自动化**中允许 Bridge 控制 System Events（若系统显示了此项）。这些是菜单自动化权限，与 JSON 文件写入分开。已开放的端口会跳过；实际操作失败或你手动关闭后，同一个 Desktop 进程中不会反复尝试，重启 Bridge 也不会重试。此时可直接使用 Desktop 原生菜单。首次授权弹窗与完整重启流程尚未完成已安装应用的端到端验收。

**请保持 9229 仅供本机访问。** 它是有进程求值能力的调试端口，不应作为手机连接地址、转发到公网或暴露给中继。连接监测只提供提醒，不会阻止其他本机进程连接。

### 3. 确认中继地址

在电脑 Bridge 的 **状态 → 中继地址**检查当前值。如果需要自建或切换中继，填入完整的 WebSocket 地址，例如 `wss://relay.example.com/ws`，保存并重连；仅在可信局域网中使用明文 `ws://`。

首次配对会把电脑的连接信息交给手机。已有配对要切换地址时，也在手机 **电脑 → 电脑行“⋯” → 连接与电脑设置 → 中继地址**修改为相同地址。

**显式保存的中继地址优先于安装包默认值。** 升级不会自动覆盖手动设置，也不会自动重建配对身份。使用局域网中继时，手机必须能访问那台电脑或服务器的局域网地址，`127.0.0.1` 不能指向另一台设备。跨网络使用需要两端都可达的中继；WebRTC 直连不可用时会回退到加密中继。

### 4. 配对手机并打开会话

1. 电脑 Bridge 打开 **设备 → 添加手机**，生成一次性二维码。
2. 手机首次启动选择“扫描二维码”，允许相机访问并扫描；也可将电脑复制的配对链接粘贴到手机。已有电脑时，从手机“电脑”页右上角“+”添加。
3. 二维码十分钟内有效，并绑定首次使用它的手机安装；过期或换手机时重新生成。配对链接包含设备授权信息，请勿公开分享。
4. 配对成功后进入会话目录，选择电脑上已有的 Code 会话。确认能加载历史，再发送一条指令。
5. 需要新工作时，点会话目录右上角“+”，填写名称并选择电脑上的工作文件夹。浏览目录后确认当前目录，项目分组与实际工作目录分别选择。

手机左上角菜单切换**会话、电脑、设置**。电脑列表负责切换与管理配对，会话页负责工作，设置页负责外观、额度与诊断。

## 日常怎么用

| 要做的事 | 操作与边界 |
| --- | --- |
| 继续对话 | 打开原生会话发送文本、图片或文件；Desktop 负责执行，Bridge 同步进度、工具调用、任务计划和子代理报告 |
| 提前写下一步 | 任务运行中可排队发送，或在 Desktop 支持时“立即调整”；对尚未开始处理的原生消息，可用 **Send now** 或撤回，是否仍可操作由 Desktop 判断 |
| 回答提问与授权 | 在会话的实时提问或授权入口答复；单选、多选、文本与可用的授权选项依请求而定，已处理请求会同步收起。历史卡片不能重新作为实时授权提交 |
| 换模型或思考强度 | 会话行或对话顶栏“⋯” → 会话设置；可用模型、上下文容量和设置生效方式由 Desktop 提供 |
| 回退对话或文件 | 已发送消息旁点“回退”，先预览并选择范围。对话回退会停止当前任务、移除所选消息及之后的对话，原文回填输入框、附件需重新添加；仅对话回退保留当前文件，文件恢复则受 Desktop 检查点与忙碌状态限制，会覆盖预览列出的文件 |
| 开一个分支 | 会话“⋯” → Fork；历史边界由 Desktop 决定。**分支共享工作目录，Fork 不复制或回滚项目文件** |
| 查看文件与成果 | 对话“⋯”中的成果入口，或消息里的工作区路径；支持预览和下载，限制见下表 |
| 整理会话 | 搜索、按项目浏览、展开 Fork、重命名或归档；Git 项目分组可识别 worktree。删除会话会作用于 Desktop 原生会话与记录，请看清确认框 |
| 阅读较早内容 | 上翻暂停自动跟随，回到底部恢复；返回目录保留未发送草稿，切页不发送草稿或停止任务 |

Claude 的任务、队列和审批由 Desktop 管理，Bridge 不另起 Claude SDK / CLI 执行器。投递状态不确定时不会自动重发；先核对会话历史与状态，再决定下一步，避免重复指令。

关闭 Bridge 窗口不会停止后台连接，手机仍可访问；停止 Bridge 后台服务会断开手机，Claude 原生任务的生命周期仍由 Desktop 管理。升级桌面端后，等任务结束，从托盘选择 **停止后台服务并退出…**，再打开新版，使后台代码也更新。详见[后台服务](docs/BACKGROUND-SERVICE.md)。

## 文件与额度

| 类型 | 1.3.1 支持范围 |
| --- | --- |
| 图片 | 对话与成果内预览，可使用缩放图像 |
| PDF | 客户端内嵌查看，通过加密分块通道读取 |
| 文本 / 代码 | 完整、有效 UTF-8 文件，最大 **1 MiB**；Markdown 渲染 / 源码切换，常见语言高亮；超限或二进制文件请下载查看 |
| 上传 / 下载 | 单文件最大 **20 MiB**，按 **256 KiB** 分块加密传输；下载 / 分享前校验完整文件哈希 |

远程文件读取受工作区与敏感路径检查约束，项目外文件、`.env`、私钥等不会因配对而开放。上传文件保存在会话工作目录的 `.bridge-uploads/<uploadId>/<filename>`，发送时附上相对路径；可以只发送文件。从输入框移除附件不会删除电脑上已上传的副本。

使用兼容 Magpie Gateway 时，手机 **设置 → Magpie 额度**可查看账号、套餐、余额、额度窗口与重置时间，模型设置中也会显示相关读数。主动刷新会请求网关重新采样；旧读数、冷却和失败会单独显示，刷新不会切换账号或模型。Claude 的账号与模型执行配置仍在 Desktop 管理。连接配置与插件要求见 [Magpie 插件说明](plugins/magpie-quota/README.md)。

## 常见问题

| 现象 | 先检查 |
| --- | --- |
| Mac 的“一键开启”一直置灰 | 是否先启动过对应 Desktop、选对 `Claude` / `Claude-3p` 目录、已经开启，或存在具体读取 / JSON 错误；使用上方手动配置路径。不要把按钮置灰当成等待系统授权 |
| 没有 Developer 菜单，或无法开启调试 | `allowDevTools` 修改后是否完整退出并重开 Desktop；查看账号 / 工作区策略。自动尝试失败后可手动使用菜单，Bridge 不会绕过原生限制 |
| 端口开了但没有会话 / 无法操作 | 查看“状态 → Claude 通道”的具体错误；Desktop 是否仍运行、对应 Code 会话是否存在、当前构建是否提供所需 `LocalSessions` 方法。普通网页聊天不会从这里导入 |
| 配对失败或二维码过期 | 重新生成二维码，确认电脑 Bridge 已连上可达中继；扫描不可用时粘贴链接 |
| 手机显示电脑离线 | 电脑是否休眠 / 断网，Bridge 后台是否运行，两端保存的中继地址是否一致且可达，TLS 与 `/ws` 路径是否正确 |
| 更新了窗口，仍显示旧能力 | 旧后台服务可能仍在运行；等任务结束后停止后台并重新打开 Bridge，两端尽量同版 |
| 消息一直排队或投递未确认 | 先看 Desktop 的当前任务、授权等待和原生队列，再核对历史；不要因为网络超时重复发送 |
| 文件预览失败 | 文件是否在工作区、仍存在且可读；是否触及敏感路径、1 MiB 文本预览或 20 MiB 传输限制 |
| 锁屏后收不到即时通知 | 先检查系统通知权限；在线本地提醒不等于后台推送。Android FCM 需要另配应用与服务凭据，最小中继部署不提供锁屏即时唤醒保证 |

继续排查时，电脑可在“状态”或“设置 → 诊断与关于”导出诊断；手机在 **设置 → 连接诊断与日志**查看连接问题。反馈版本、平台、出错步骤与具体提示，勿附配对链接、密钥或聊天正文。可以在[本 fork 的 Issues](https://github.com/Lycidas97/claude-desktop-bridge/issues)反馈可复现问题。

## 部署、原理与开发

手机与电脑之间的业务正文使用每设备 AES-256-GCM 端到端加密。Relay 转发密文，可见连接、路由、大小和队列元数据；账号凭据不发送到手机或 Relay。WebRTC 与中继使用同一配对身份，电脑无需将 inspector 暴露给手机。

| 文档 | 适合什么时候看 |
| --- | --- |
| [自建中继](docs/RELAY-REDEPLOY.md) · [部署配置](deploy/README.md) | 首次部署 WSS、迁移地址、备份或升级；提供 Relay + Caddy 的最小方案 |
| [安全模型](docs/SECURITY.md) | 理解配对、调试端口、文件访问与数据边界 |
| [架构](docs/ARCHITECTURE.md) · [原生接入验收记录](docs/HOSTING-REFACTOR.md) | 了解 `LocalSessions`、数据流和实际验证范围；历史实现另有标记 |
| [后台服务](docs/BACKGROUND-SERVICE.md) | 区分窗口与服务，排查启动、断线和更新 |
| [贡献指南](CONTRIBUTING.md) · [测试说明](docs/testing.md) | 从源码开发、构建与验证 |

开发与 CI 使用 [.nvmrc](.nvmrc) 指定的 **Node.js 26 LTS** 和 npm。克隆本 fork 后，在仓库根目录依次运行：

```bash
npm ci
```

```bash
npm run build -w @bridge/protocol
```

```bash
npm run dev:desktop
```

开发模式启动本地 Relay、React 客户端和 Electron Bridge；手机不能通过自己的 `127.0.0.1` 访问电脑服务。构建默认参数见 [.env.example](.env.example)，安装后的手动连接设置优先。Android 打包还需要 Android 工具链；测试与发布规则见贡献指南。

感谢 [czhmartinez/claude-desktop-bridge](https://github.com/czhmartinez/claude-desktop-bridge) 的原始项目。本 fork 保留 **MIT** 许可证，见 [LICENSE](LICENSE)。
