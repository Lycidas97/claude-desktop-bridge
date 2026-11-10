# Bridge · Lycidas97 Fork

[English](README_EN.md) · [下载](https://github.com/Lycidas97/claude-desktop-bridge/releases) · [更新记录](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md)

<img src="apps/client/public/bridge-mark.svg" width="84" alt="Bridge logo" align="right" />

**在 Android 手机上继续电脑里的 Claude 工作。**

Bridge 将电脑上的会话、任务进度、授权提问和工作区文件带到手机。你可以继续已有会话、排队发送下一条指令、创建 Fork、查看子代理和成果，也可以在离开电脑后处理等待中的授权。

这是独立维护的 fork，主要围绕 **macOS + Android + Claude** 完善日常使用。安装包与发布状态以本仓库的 [Releases](https://github.com/Lycidas97/claude-desktop-bridge/releases) 为准。保留上游 Codex、Hermes、DSH 适配器，默认只显示 Claude，其他 Agent 可在设置中启用。

**1.3.0 改用 Claude Desktop 原生接入**：会话执行、队列和权限由 Desktop 管理，Bridge 通过 `LocalSessions` 转发操作，不再启动 Claude SDK/CLI Host 或提供旧的接管/交还入口。新版加入原生 Send now、撤回与回退，改善大历史加载、网络重连、流式阅读和工具显示。macOS 已通过真实 Desktop 的会话与历史验证，更多边界使用隔离夹具验收；完整范围见[重构记录](docs/HOSTING-REFACTOR.md)。

## 开始使用

1. 从本 fork 的 Releases 下载电脑端和 Android 客户端，尽量使用同一版本。上游安装包不包含本 fork 的全部改进。
2. 在电脑上运行 Claude Desktop，使用用户自行开启的 Node inspector（`127.0.0.1:9229`），再启动 Bridge。未开启时 Claude 显示不可用；Bridge 不会修改安装包、重启 Desktop 或自动开启 inspector。
3. 在 Android 安装 APK，通过电脑端的一次性二维码或配对链接添加电脑。
4. 打开手机的会话目录，选择已有会话，或用右上角“+”创建会话。
5. 在对话中发送文本、图片或文件，查看执行进度，并处理授权与提问。

跨网络连接时，两端需要使用相同的可达中继。可在电脑端“状态”和手机端“电脑 → 连接与电脑设置”修改中继地址；它是 WebSocket 中继地址，支持 `ws://`、`wss://`、端口和路径。

已保存的中继设置优先于安装包默认值，升级保留配对身份和手动配置。电脑端需保持运行并联网；手机退到后台不会停止电脑上的任务。

## 会话与任务

### 继续已有工作

- 直接浏览 Desktop 的原生会话与历史，使用 Desktop 返回的会话 ID，查看 Markdown、工具调用、任务计划、子代理进度和完整报告。
- Claude 输入通过 Desktop 的 `claude.web.LocalSessions` 原生接口提交；接收与完成分别记录，投递结果不确定时保留状态，不自动重发或另起执行器。
- 区分主轮执行、等待授权、后台 Agent / Bash 与进程存活，避免把后台任务或 Fork 子进程误算为父会话一直忙碌。
- 运行中可通过原生接口排队下一条指令；支持的运行时还可立即调整当前任务。Claude 队列由 Desktop 管理，Bridge 保留请求幂等、附件身份、收据和事件 replay。旧 Bridge 队列与手机缓存的 `bridgeExecutionRequested` 不会自动重发。
- 授权与 `AskUserQuestion` 在手机和电脑之间同步，已处理的请求及时收起。停止任务、删除会话等操作保留确认。

Bridge 的后台服务负责连接和事件转发；Claude 任务和队列由 Desktop 执行。关闭再打开 Bridge 窗口会重新连接服务；**关闭窗口与停止后台服务是不同的操作**。

### 排队与回退

- 对尚未开始处理的已提交、已接收或排队消息，使用 **Send now** 或撤回；操作始终指向原生消息，由 Desktop 判断是否仍可执行。
- 消息旁的回退入口分别预览对话和文件资格。确认对话回退会停止当前任务，移除所选消息及之后的对话；文件恢复仍受原生检查点和忙碌状态限制。原文回填输入框，附件需重新添加。
- 输出期间上翻会暂停跟随，回到底部后恢复；顶部补页保留阅读位置。工具完成和历史重放保留调用名称与参数。

### 整理与创建会话

- 按项目浏览、搜索和归档会话；Fork 按直接父子关系逐层展开，支持从分支继续创建分支。父会话归档后，活跃后代仍可查看。
- Claude Fork 通过 Desktop 原生接口创建，历史边界由 Desktop 决定；分支共享工作目录，创建分支不会回滚文件。
- 在会话列表或对话操作中重命名；Claude 会话更新通过 Desktop 原生接口提交。
- 新建会话时，在同一入口选择最近工作文件夹或浏览电脑目录。点击子目录先进入，确认当前目录后才选中；项目分组与实际工作目录分别设置。
- 返回目录再打开会话时保留未发送草稿。新建表单在浏览目录、取消文件夹选择和从文件夹选择返回时保留已填内容。

### 模型、上下文与大会话

- Claude 模型、思考强度和上下文用量通过 Desktop 原生接口读取或设置，能力以当前 Desktop 实际提供的接口为准。
- 长回复可折叠并展开全文，保留压缩前后的历史与子代理报告。
- 目录、历史和成果按需加载；逐步补页、延迟加载媒体，并合并频繁进度更新，减少大 JSONL、大回复与重连时的重复读取和传输。

实际上下文容量、立即调整和模型设置生效方式取决于各原生运行时。Claude 权限请求与回答通过 Desktop 原生通道转发，Bridge 不安装 Host 权限 Hook，也不替 Desktop 作审批决定；历史问答不能作为实时审批提交。

Claude 历史直接读取 Desktop 记录，不迁移旧数据、不关联旧逻辑 ID，也不提供旧历史入口或从旧队列恢复草稿；既有数据与配对 identity 不碰。退役旧连接组件时先写 `.bridge-backup`，只清理旧 `claude-bridge` MCP、固定 Bridge URL，以及带专有 header/env 标记的动态权限 Hook；无关 Hook、MCP 和用户设置保持原样。

## 手机端怎么操作

一级页面为**会话、电脑、设置**，通过顶栏左上角菜单切换。进入电脑或从菜单选择“会话”时打开会话目录，选择具体会话后才进入对话。

| 要做的事 | 入口 |
| --- | --- |
| 新建会话、选择工作文件夹 | 会话目录右上角“+” |
| 重命名、模型与会话设置、Fork、归档 | 会话行或对话顶栏“⋯” |
| 查看成果与文件变化 | 对话“⋯”中的成果入口 |
| 切换电脑、修改连接、管理配对 | 电脑页与电脑行“⋯” |
| 外观、Agent 显示、Magpie 额度、诊断 | 设置页 |

Android 系统返回键按页面层级工作：

- 软键盘显示时，先由系统收起键盘；菜单、弹窗和底部面板先关闭。
- 成果返回对话，对话返回原目录或项目列表；项目和归档列表返回会话目录。
- 电脑详情返回电脑列表，电脑和设置返回会话目录。
- 会话目录根页再返回，应用退到后台；再次打开可以继续工作。

返回和切页不发送草稿，也不停止电脑端任务。完整页面规范见 [手机导航](docs/MOBILE-NAVIGATION.md)。

## 预览与文件传输

| 类型 | 支持范围 |
| --- | --- |
| 图片 | 对话和成果内预览，手机端使用缩放图像减少等待 |
| PDF | 客户端内嵌查看，通过加密分块通道读取 |
| 文本与代码 | 完整 UTF-8 文件，最大 **1 MiB**；Markdown 支持渲染 / 源码切换，常见代码支持高亮 |
| 文件下载 | 从成果或对话中的工作区路径下载，单文件最大 **20 MiB**，保留工作区和敏感路径检查 |
| 文件上传 | 图片和普通文件，单文件最大 **20 MiB**；显示进度，按 **256 KiB** 分块加密传输并核验 SHA-256 |

超限、二进制或无效 UTF-8 文本会明确报错，不以截断内容代替全文。上传文件保存在会话工作目录的 `.bridge-uploads/<uploadId>/<filename>`，发送时附上相对路径；可以只发送文件。从输入区移除附件不会删除已保存在电脑上的文件。

## Claude Desktop 开发者工具

macOS 电脑端打开“设置 → 诊断与关于 → Claude Desktop 开发者工具”，检查 `Claude` 或 `Claude-3p` 标准配置目录。两个目录都存在时需要选择目标；“一键开启”仅将该目录下 `developer_settings.json` 的 `allowDevTools` 设为 `true`，保留其他字段。检查不写入，已开启不重复改写，JSON 格式错误会显示错误并保留原文件。

修改后需重启 Claude Desktop 才会加载。需要主进程调试时，再手动点击 **Developer → Enable Main Process Debugger**；菜单仍受账号与 workspace 策略限制。此功能不自动重启应用或打开调试端口。

Bridge 后台每 3 秒检查当前用户可见的 9229 TCP 连接，用 macOS `proc_pidpath` 读取连接进程的完整可执行路径。当前 Bridge 应用包、`/Applications/Bridge.app/` 和 `/Applications/Google Chrome.app/` 内的进程属于认可路径；其他位置或路径无法识别时触发系统通知及窗口内告警。设置页显示 PID、完整路径和最近 20 条告警（当前后台运行期间）；同一进程持续连接不重复通知，断开后再次连接会再次提醒。关闭 Bridge 窗口后监测继续，停止后台服务后监测停止。

这是按路径提醒的轮询监测，短连接可能漏检，不会阻止其他进程连接，也不会自动关闭调试端口。升级到带监测的版本时，需要在任务结束后停止旧后台服务再打开新版 Bridge；设置页会提示后台尚未提供监测状态。

## Magpie 接入与额度

Magpie 额度插件保留，Claude 的账号、模型与执行配置由 Desktop 管理。旧“提供方 → Magpie 连接”中的 Host 执行器配置与 standalone API Key lane 不再用于 Claude 执行；已有配置保留，凭据不会发送到手机或 Relay。

使用兼容的 Magpie Gateway 时，可在“设置 → Magpie 额度”查看账号、套餐、各额度窗口、余额和重置时间；会话模型选择中也会显示相应额度信息。

- 按需读取，看板和模型设置共用读数；没有后台定时轮询。
- 点击刷新会主动请求当前网关可见的本机账号重新采样。远端来源保留原采样并标明状态，不转发本机认证。
- 区分 Bridge 读取时间和上游采样时间；冷却、旧读数和失败都有对应提示，HTTP 成功不等于取得了新采样。
- 断线或离开页面后不自动重放主动刷新。刷新额度不会切换账号、模型或路由。

详见 [插件说明](plugins/magpie-quota/README.md)。

## 连接与数据边界

```mermaid
flowchart LR
  Phone[Android 客户端] <-->|WebRTC| Host[本机 Bridge]
  Phone <-->|WS / WSS| Relay[自托管中继]
  Host <-->|WS / WSS| Relay
  Host -->|本机 Node inspector| Claude[Claude Desktop LocalSessions]
  Host --> Runtime[Codex / Hermes / DSH 原生接入]
```

手机与 Bridge 之间的业务正文使用每设备 AES-256-GCM 端到端加密。中继可见连接、路由、密文与队列元数据。支持 WebRTC 直连和中继回退，实际连接方式取决于网络与 ICE 配置。

本 fork 的日常部署是**本机 Bridge + Android 客户端，服务器只运行中继**，无需向公网部署 WebUI。Web/PWA 保留供开发使用，各运行时的账号和会话保持隔离。

Claude 接入从 `http://127.0.0.1:9229/json/list` 动态取得 WebSocket，通过 `process.mainModule.require('electron')` 找到 `app://localhost` WebContents，再以 `executeJavaScript` 调用 `claude.web.LocalSessions`。用户已选择常开该本机 inspector，本次选择覆盖旧文档“绝不 CDP / 不附着”的 Claude 限制；不改 asar、不签 token、不添加 LaunchAgent、不用辅助功能自动点菜单。Relay 不提供任意 evaluate 入口，也不接收账号凭据。

| 文档 | 内容 |
| --- | --- |
| [架构](docs/ARCHITECTURE.md) | Host、协议、运行时与数据流 |
| [安全模型](docs/SECURITY.md) | 加密、配对、权限与文件边界 |
| [中继部署](docs/RELAY-REDEPLOY.md) | 自托管中继与迁移 |
| [后台服务](docs/BACKGROUND-SERVICE.md) | 窗口、后台进程与状态恢复 |

## 自建中继

服务器使用 Docker Engine 与 Docker Compose，从本 fork 的 `main` 源码构建中继镜像。提供独立的 [仅中继 Compose](deploy/relay-only.compose.yml) 和 [自动 TLS 配置](deploy/relay-only.Caddyfile)：只有 Relay 与 Caddy，公网 TCP 80 / 443，Relay 的 8788 只在 Docker 网络内使用。HTTPS 根路径和 `/metrics` 返回 404。

在已克隆的仓库根目录创建配置：

```bash
cp deploy/relay-only.env.example .env
```

将 `.env` 中的 `BRIDGE_DOMAIN` 改为自己的域名，确保 DNS 指向服务器、80 / 443 可达，再构建并启动：

```bash
docker compose --env-file .env -f deploy/relay-only.compose.yml up -d --build
```

两端中继地址均填写 `wss://你的域名/ws`。数据库、备份与 TLS 证书使用持久化卷。完整的首次安装、WSS 探测、两端配置、备份与升级步骤见 [自建中继指南](docs/RELAY-REDEPLOY.md)。已有反向代理或旧中继部署时，先按指南确认端口与原数据卷。

## 开发与验证

开发与 CI 使用 **Node.js 26 LTS** 和 npm，版本选择见 [.nvmrc](.nvmrc)；安装了 nvm 时，可先运行 `nvm install` 和 `nvm use`。最低兼容版本仍为 Node.js 22.13。Electron 使用其自带的 Node.js 运行时。Android 构建另需 JDK 21 与 Android SDK，桌面和 iOS 构建需要对应平台工具链。

```bash
git clone https://github.com/Lycidas97/claude-desktop-bridge.git
```

```bash
cd claude-desktop-bridge
```

```bash
npm ci
```

```bash
npm run build -w @bridge/protocol
```

```bash
npm run dev:desktop
```

开发模式启动本地 Relay（`ws://127.0.0.1:8788/ws`）、React 客户端（`http://localhost:5188`）和 Electron Host。构建默认连接参数见 [.env.example](.env.example)，安装后的手动设置优先。

| 命令 | 用途 |
| --- | --- |
| `npm run verify` | 全部类型检查、五组回归测试和完整构建 |
| `npm test` | 桌面、客户端、协议、中继、Magpie 插件回归 |
| `npm run test:infra` | 测试入口、失败传播与回收站清理约定 |
| `npm run test:browser` | 实际 App、加密协议和本地中继上的八个场景，分别验证明暗主题 |
| `npm run ci:run -- run build:android:debug` | 构建 Android APK，并检查原生插件注册和全部 DEX |
| `npm run ci:run -- run make:adhoc -w @bridge/desktop` | 构建 macOS ad-hoc 测试安装包 |

验证入口通过系统回收站清理 Node 临时文件；Linux 需安装 `trash-cli`。浏览器测试的桌面响应和模型输出为模拟数据，不访问生产会话。浏览器准备、报告位置与覆盖范围见 [测试说明](docs/testing.md)。

本 fork 主要在 macOS + Android 上验证。Android 系统返回已在 Android 16 模拟器中验收；Windows、Linux、iOS 保留构建和 CI 入口，但构建通过不代表各平台实机体验已完成验收。macOS ad-hoc 包未经 Apple 公证，iOS 无签名构建也不等于可直接安装的 IPA。

版本统一后由 `main` 自动创建 Release 草稿，平台产物任务全部成功才公开发布。完整规则见 [贡献指南](CONTRIBUTING.md#release-rules)，历次功能与修复见 [Changelog](CHANGELOG.md)。

## 目录与来源

| 目录 | 内容 |
| --- | --- |
| `apps/client` | 手机与桌面共享 React 界面 |
| `apps/desktop` | Electron Host、后台服务、会话与文件传输 |
| `apps/mobile` | Android / iOS Capacitor 壳 |
| `apps/relay` | 密文中继与推送唤醒 |
| `packages/protocol` | 协议、配对、加密与可靠传输 |
| `plugins/magpie-quota` | 额度读取、主动刷新与展示 |
| `scripts` / `deploy` / `docs` | 验证、构建、部署与技术文档 |

感谢 [czhmartinez/claude-desktop-bridge](https://github.com/czhmartinez/claude-desktop-bridge) 的原始项目与多运行时基础。本 fork 保留 **MIT** 许可证，见 [LICENSE](LICENSE)。
