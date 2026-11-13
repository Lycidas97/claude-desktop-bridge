# Bridge · Lycidas97 Fork

[中文](README.md) · [Downloads](https://github.com/Lycidas97/claude-desktop-bridge/releases) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

<img src="apps/client/public/bridge-mark.svg" width="84" alt="Bridge logo" align="right" />

**Continue your computer's Claude work from an Android phone.**

Bridge brings local Claude Desktop Code sessions to your phone: continue a conversation, queue the next instruction, answer approvals and questions, follow subagents, and view workspace files. Tasks still run on your computer.

This independently maintained fork primarily targets **macOS + Android + Claude Desktop, including Claude-3p**. It depends on Desktop's local `LocalSessions` interface. Available operations depend on the installed Desktop version and account/workspace policies; ordinary web chat history is outside this integration.

Android is the native phone client. The generic mobile Web client remains available; the native iOS product line is retired.

## Versions and downloads

**The current public release is [v1.3.1](https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.1). The setup steps below describe that release.** Download desktop and mobile packages from this fork, preferably from the same version.

| Platform | v1.3.1 download | Installation and validation |
| --- | --- | --- |
| macOS | [Desktop ZIP](https://github.com/Lycidas97/claude-desktop-bridge/releases/download/v1.3.1/Bridge-1.3.1-macos-adhoc.zip) | Extract and use the enclosed installer. Ad-hoc signed, without Apple notarization; the main desktop validation platform |
| Android 8.0+ | [APK](https://github.com/Lycidas97/claude-desktop-bridge/releases/download/v1.3.1/Bridge-1.3.1-android-debug.apk) | Uses the repository's fixed debug signing key; allow installation from the app used to download it |
| Windows | [Installer ZIP](https://github.com/Lycidas97/claude-desktop-bridge/releases/download/v1.3.1/Bridge-1.3.1-windows-installer-ci.zip) | CI build; see the included `windows-release-evidence.json` for signing status. Native connectivity has not completed live-device validation |
| Linux | [Installer ZIP](https://github.com/Lycidas97/claude-desktop-bridge/releases/download/v1.3.1/Bridge-1.3.1-linux-installers-ci.zip) | CI build; this alone does not establish a usable native Claude Desktop environment |

The release also includes `SHA256SUMS.txt` and `SOURCE_COMMIT.txt`. Successful builds do not establish live-device validation on every platform. Android system back navigation has been tested in an Android 16 emulator.

The source is preparing a **1.3.2 candidate**: focusing on Claude Desktop only, fixing task completion notifications, confirming size before previews larger than 1 MiB, keeping connection status visible beside long computer names, showing actual subagent response models, displaying live session context usage, remembering font size, creating and moving native Sections from mobile (plus optional folder creation inside the Browse Computer picker), and fixing the disabled Mac configuration button while reorganizing desktop and mobile Settings by task. These changes are not in the 1.3.1 packages; file-size checks, Section moves and directory creation also require a desktop update. Version 1.3.1 still contains independent Codex / Hermes / DSH adapters, which are outside this recommended setup path. Gemini, Antigravity and Magpie models and quota features inside Claude Desktop belong to the Desktop integration, rather than those independent agents.

Until 1.3.2 is tagged, the steps below retain the controls of the published 1.3.1 packages (the candidate reorganizes desktop Settings under **Claude Integration / Connection and Startup**) alongside the manual setup fallback. See the [Changelog](CHANGELOG.md) for details. Technical documents track the source and may describe candidate changes.

## What you need

| Location | Role and prerequisites |
| --- | --- |
| Computer | Install and sign in to Claude Desktop or Claude-3p, and confirm a local Code session works on the computer. Install Bridge and keep the computer awake, online and running Desktop |
| Phone | Install Android Bridge to control a paired computer; no model API key is needed on the phone |
| Relay | Both devices must reach the same WebSocket relay for pairing, connectivity and fallback when direct connections fail. Use an existing trusted relay or [host your own](docs/RELAY-REDEPLOY.md) |

The packaged apps do not need a separate Node.js, npm or Android SDK installation. A server only needs the relay, without a public WebUI. Tasks continue when the phone leaves the foreground; computer sleep, network loss or quitting Desktop affects connectivity and work.

## First connection

The app's current controls use Chinese labels, included below to help you find them.

### 1. Install and open the desktop app

Download Bridge above, extract it and use the enclosed installer. On macOS, place Bridge in Applications and open it. If macOS blocks the unnotarized app, verify its source and use the system's Open Anyway option where available.

Launch Claude Desktop / Claude-3p at least once and finish signing in, then open Bridge. Its **Status (状态)** page separates the **Claude channel (Claude 通道)** from the **connection path (连接路径)**: the first connects to Desktop, while the second connects to the phone and relay. Check both.

### 2. Enable Desktop's local connection on macOS

This requires two settings: allowing Desktop developer tools, then enabling its main-process debugger.

1. In Bridge, open **Settings → Diagnostics and About → Claude Desktop developer tools (设置 → 诊断与关于 → Claude Desktop 开发者工具)**. If both `Claude` and `Claude-3p` are detected, select the profile you actually use.
2. Check whether `allowDevTools` is `true` in `developer_settings.json`. **Enable (一键开启)** only writes this field; **it does not open the inspector or guarantee a macOS permission prompt**. If the button is disabled or the check fails, use the manual instructions below.
3. Desktop loads the changed configuration on its next launch. Wait for active tasks to finish, then quit and reopen Claude Desktop / Claude-3p. Bridge does not restart it for you.
4. In Desktop's native menu, choose **Developer → Enable Main Process Debugger**. The default local address is `127.0.0.1:9229`. Account/workspace policies may restrict the menu, and the native action may open a Chrome debugger page.
5. In Bridge's Status page, check that the Claude channel is **Ready (已就绪)** or **Running (运行中)**, and inspect errors under **Diagnostics and About → Debug connection monitoring (调试连接监测)**. An open port alone does not establish a working `LocalSessions` connection.

<details>
<summary>Manually configure developer_settings.json if the button is unavailable</summary>

Use the file belonging to the application you run:

- Claude: `~/Library/Application Support/Claude/developer_settings.json`
- Claude-3p: `~/Library/Application Support/Claude-3p/developer_settings.json`

Launch that application once so its configuration directory exists. After tasks finish, quit Desktop, back up the existing file, and use a text editor to set `allowDevTools` to `true` in its JSON object, preserving other fields. If the file does not exist, create it in the existing configuration directory:

```json
{
  "allowDevTools": true
}
```

Check that the JSON is valid, reopen Desktop, then enable the main-process debugger from its native menu. Do not overwrite `claude_desktop_config.json` with this content; that is a different configuration file. Resolve any file permission or JSON errors first. Rechecking the button does not repair the file.

</details>

**Automatic attempt in 1.3.1:** on macOS, the background service attempts the same native menu once per newly discovered Desktop process. Grant Bridge access under **System Settings → Privacy & Security → Accessibility**, and allow Bridge to control System Events under **Automation**, if that entry appears. These permissions concern menu automation and are separate from JSON file access. An already-open port is skipped. After an actual action fails, or you close the debugger manually, Bridge does not repeat the attempt within that Desktop process, even if Bridge restarts. You can still use Desktop's native menu directly. First-time permission prompts and a full restart cycle have not completed installed-app end-to-end validation.

**Keep port 9229 local.** This debugger can evaluate code in the process. It is not the phone's connection address and must not be forwarded to the internet or exposed through the relay. Connection monitoring provides alerts; it does not block other local processes.

### 3. Check the relay address

In desktop Bridge, check **Status → Relay address (状态 → 中继地址)**. To use your own relay or change servers, enter the full WebSocket address, such as `wss://relay.example.com/ws`, then save and reconnect. Use plaintext `ws://` only on a trusted local network.

Initial pairing passes the computer's connection information to the phone. To change the address for an existing pairing, also update **Computers → computer row “⋯” → Connection and computer settings → Relay address (电脑 → 连接与电脑设置 → 中继地址)** on the phone to the same address.

**Explicitly saved relay addresses override packaged defaults.** An upgrade does not overwrite manual settings or recreate pairing identities. For a LAN relay, the phone must reach the computer or server's LAN address; `127.0.0.1` cannot address another device. Access across networks needs a relay reachable from both ends. If WebRTC direct connectivity is unavailable, Bridge falls back to the encrypted relay.

### 4. Pair your phone and open a session

1. In desktop Bridge, open **Devices → Add phone (设备 → 添加手机)** to generate a one-time QR code.
2. On first launch, choose **Scan QR code (扫描二维码)** on the phone, allow camera access and scan it. Alternatively, paste the pairing link copied on the computer. To add another computer later, use “+” on the phone's Computers page.
3. The QR code is valid for ten minutes and binds to the first phone installation that uses it. Generate another code after expiry or for another phone. Pairing links contain device authorization information; do not share them publicly.
4. After pairing, select an existing desktop Code session in the session directory. Confirm that its history loads before sending an instruction.
5. To start new work, use “+” in the session directory, enter a title and choose a working folder on the computer. Browse into the folder before confirming it; project grouping and the actual working directory are separate choices.

The top-left menu switches between **Sessions (会话), Computers (电脑) and Settings (设置)**. Computers manages connections and pairings, Sessions is for work, and Settings contains appearance, quota and diagnostics.

## Everyday use

| Task | Operation and limits |
| --- | --- |
| Continue a conversation | Send text, images or files in a native session. Desktop executes the work; Bridge synchronizes progress, tool calls, plans and subagent reports |
| Prepare the next instruction | Queue input during a task, or steer it immediately when Desktop supports that operation. Use **Send now** or withdraw eligible native messages before processing starts; Desktop decides whether an action is still valid |
| Answer questions and approvals | Respond through the session's live question or approval controls. Single choice, multiple selection, text and approval options depend on the request. Resolved requests are dismissed across devices; historical cards cannot be resubmitted as live approvals |
| Change model or effort | Session row or conversation header “⋯” → Session settings (会话设置). Models, context capacity and how changes take effect come from Desktop |
| Rewind a conversation or files | Choose Rewind (回退) beside a sent message, preview and select the scope. Conversation rewind stops active work, removes the selected message and later conversation, and returns the text to the composer; add attachments again. Conversation-only rewind keeps current files. File restoration depends on Desktop checkpoints and busy state, and overwrites the files listed in the preview |
| Create a branch | Session “⋯” → Fork. Desktop decides the history boundary. **Branches share the working directory; a fork does not copy or roll back project files** |
| View files and results | Open Evidence (成果) from conversation “⋯”, or a workspace path in a message. Preview and download limits are listed below |
| Organize sessions | Search, browse projects, expand forks, rename or archive. Git project grouping recognizes worktrees. Deletion applies to the native Desktop session and records; read the confirmation |
| Read earlier content | Scrolling up pauses following; returning to the bottom resumes it. Returning to the directory preserves unsent drafts. Navigation neither sends drafts nor stops tasks |

Desktop owns Claude tasks, queues and approvals. Bridge does not start another Claude SDK / CLI executor. Uncertain delivery is not automatically resent. Check session history and status before deciding what to do next, to avoid duplicate instructions.

Closing the Bridge window leaves background connectivity running, so the phone can still connect. Stopping the Bridge service disconnects the phone; Desktop still controls native Claude task lifecycles. After a desktop upgrade, wait for tasks to finish, choose **Stop background service and quit… (停止后台服务并退出…)** from the tray, then reopen Bridge to update the background code too. See [Background service](docs/BACKGROUND-SERVICE.md).

## Files and quota

| Type | Support in 1.3.1 |
| --- | --- |
| Images | Previews in conversations and evidence, including scaled images |
| PDF | Embedded viewer using encrypted chunked transfers |
| Text / code | Complete, valid UTF-8 files up to **1 MiB**. Rendered/source Markdown and highlighting for common languages; download oversized or binary files instead |
| Upload / download | Up to **20 MiB** per file, transferred in encrypted **256 KiB** chunks; complete-file hash verification before saving or sharing downloads |

Remote reads are subject to workspace and sensitive-path checks. Pairing does not grant access to files outside the workspace, `.env` files or private keys. Uploads are stored in `.bridge-uploads/<uploadId>/<filename>` under the session's working directory, and sending includes relative paths. Files can be sent without text. Removing an attachment from the composer does not delete the uploaded copy on the computer.

With a compatible Magpie Gateway, open **Settings → Magpie quota (设置 → Magpie 额度)** on the phone to view accounts, plans, balances, quota windows and reset times. Model settings also show relevant readings. Explicit refresh requests new samples from the gateway; retained samples, cooldowns and failures are identified separately. Refresh does not switch accounts or models. Claude accounts and model execution settings remain managed by Desktop. See the [Magpie plugin guide](plugins/magpie-quota/README.md) for connection settings and requirements.

## Troubleshooting

| Symptom | Check first |
| --- | --- |
| Enable (一键开启) stays disabled on Mac | Has the matching Desktop app launched once? Is the right `Claude` / `Claude-3p` profile selected? Is it already enabled, or is there a read/JSON error? Use manual setup above. A disabled button does not mean the app is waiting for system approval |
| No Developer menu, or debugger cannot be enabled | Quit and reopen Desktop after changing `allowDevTools`; check account/workspace policies. Use the native menu after a failed automatic attempt. Bridge does not bypass native restrictions |
| Port is open, but sessions or actions are unavailable | Read the Claude channel error on Status. Check that Desktop is running, the Code session exists, and that Desktop build exposes the required `LocalSessions` methods. Ordinary web chats are not imported |
| Pairing fails or QR code expires | Generate a fresh code and confirm desktop Bridge is connected to a reachable relay. Paste the link if scanning is unavailable |
| Phone shows the computer offline | Check computer sleep, network access, the Bridge background service, matching saved relay addresses, TLS and the `/ws` path |
| Updated window still shows old capabilities | The old background service may still be running. Wait for tasks to finish, stop it and reopen Bridge. Prefer matching versions on both devices |
| Message remains queued or delivery is unconfirmed | Check Desktop's active task, pending approvals, native queue and history before resending after a network timeout |
| File preview fails | Check that the file is still readable in the workspace, is not a sensitive path, and fits the 1 MiB text-preview or 20 MiB transfer limit |
| No immediate notification while locked | Check system notification permission. Online local notifications are separate from background push. Android FCM require application and service credentials; the minimal relay setup does not guarantee immediate lock-screen wakeups |

For further investigation, export diagnostics from desktop Status or **Settings → Diagnostics and About**. On mobile, open **Settings → Connection diagnostics and logs (设置 → 连接诊断与日志)**. Include versions, platform, steps and the exact error when reporting a problem; leave out pairing links, keys and conversation content. Report reproducible issues in [this fork's issue tracker](https://github.com/Lycidas97/claude-desktop-bridge/issues).

## Deployment, internals and development

Phone-to-computer payloads use per-device AES-256-GCM end-to-end encryption. The relay forwards ciphertext and can see connection, routing, size and queue metadata; account credentials are not sent to the phone or relay. WebRTC and relay connections use the same pairing identity, without exposing the computer's inspector to the phone.

| Document | When to read it |
| --- | --- |
| [Self-host a relay](docs/RELAY-REDEPLOY.md) · [Deployment configuration](deploy/README.md) | Set up WSS, migrate, back up or upgrade. Includes a minimal Relay + Caddy setup |
| [Security model](docs/SECURITY.md) | Understand pairing, debugger access, file access and data boundaries |
| [Architecture](docs/ARCHITECTURE.md) · [Native integration validation](docs/HOSTING-REFACTOR.md) | Inspect `LocalSessions`, data flow and actual validation coverage; historical implementations are marked separately |
| [Background service](docs/BACKGROUND-SERVICE.md) | Distinguish windows from the service and investigate startup, disconnections or upgrades |
| [Contributing](CONTRIBUTING.md) · [Testing](docs/testing.md) | Develop, build and validate from source |

Development and CI use **Node.js 26 LTS**, selected by [.nvmrc](.nvmrc), and npm. Clone this fork, then run these commands in the repository root:

```bash
npm ci
```

```bash
npm run build -w @bridge/protocol
```

```bash
npm run dev:desktop
```

Development mode starts a local relay, React client and Electron Bridge. A phone cannot reach the computer's services through its own `127.0.0.1`. See [.env.example](.env.example) for build defaults; saved manual connection settings take priority. Android packaging also needs the Android toolchain. See Contributing for tests and release rules.

Built on [czhmartinez/claude-desktop-bridge](https://github.com/czhmartinez/claude-desktop-bridge). This fork retains the **MIT** license; see [LICENSE](LICENSE).
