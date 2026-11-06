# Bridge · Lycidas97 Fork

[中文](README.md) · [Downloads](https://github.com/Lycidas97/claude-desktop-bridge/releases) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

<img src="apps/client/public/bridge-mark.svg" width="84" alt="Bridge logo" align="right" />

**Continue your computer's Claude work from an Android phone.**

Bridge brings desktop sessions, task progress, approvals, questions and workspace files to your phone. Continue an existing conversation, queue the next instruction, create a fork, inspect subagents and results, or answer an approval while away from your computer.

This independently maintained fork focuses on **macOS + Android + Claude**. This guide describes **v1.2.0**; see this repository's [Releases](https://github.com/Lycidas97/claude-desktop-bridge/releases) for available installers and publication status. Upstream Codex, Hermes and DSH adapters remain available. Only Claude is shown by default; enable other Agents in settings.

## Get started

1. Download desktop and Android packages from this fork's Releases, preferably from the same version. Upstream installers do not include all changes in this fork.
2. Set up a working Claude Desktop / Claude-3p host environment on your computer and start Bridge.
3. Install the Android APK and add the computer using its one-time QR code or pairing link.
4. Open the session directory on your phone. Select an existing session or use “+” to create one.
5. Send text, images or files, follow execution progress, and respond to approvals and questions.

For access across networks, configure the same reachable relay on both devices. Change it in desktop Status or mobile Computers → connection and computer settings. This is a WebSocket relay address supporting `ws://`, `wss://`, ports and paths.

Saved relay settings override packaged defaults. Upgrades preserve pairing identities and explicit settings. Keep the computer running and connected; moving the phone app into the background does not stop desktop tasks.

## Sessions and tasks

### Continue existing work

- Browse native Desktop and Bridge-managed sessions, with Markdown, tool calls, task plans, subagent progress and complete reports.
- On supported macOS Claude Desktop environments, deliver input to the verified original executor and track acceptance and completion by input UUID. Uncertain delivery retains its state instead of automatically resending or starting a second executor.
- Distinguish the main turn, pending approvals, background Agent / Bash work and process liveness. Background tasks and forked child processes no longer incorrectly keep a parent session marked busy.
- Queue another instruction while a turn is running, or adjust the current task where the execution source supports it. Preserve queue entries, attachments and message receipts across reconnects.
- Synchronize approvals and `AskUserQuestion` between phone and computer, dismissing requests once handled. Stopping work and deleting sessions retain confirmation steps.

A background service owns Bridge's connections, queues and tasks. Reopening the desktop window reconnects to that service. **Closing the window and stopping the background service are separate actions.**

### Organize and create sessions

- Browse projects, search and archive sessions. Expand forks by their immediate parent/child relationships, including deeper forks. Active descendants remain accessible after a parent is archived.
- Rename from the session list or conversation actions. Bridge persists the display name across restarts without rewriting native Claude Desktop titles or transcript files.
- Choose a recent working folder or browse the computer through one session-creation entry point. Enter a subdirectory before confirming it; choose the project group separately from the actual working directory.
- Preserve unsent drafts when returning to the directory and reopening a session. The session-creation form retains entered values while browsing folders, canceling folder selection, or returning from the folder picker.

### Models, context and large histories

- Read model names and advertised context capacity from the current Gateway, retain model and effort settings, and recognize compaction records and post-compaction token information.
- Fold long replies with access to the full text, preserving history across compaction and complete subagent reports.
- Load directories, history and evidence on demand. Page older content, defer media loading and coalesce frequent progress updates to reduce repeated work on large transcripts, responses and reconnects.

Context capacity, immediate steering and when model settings take effect depend on the execution source. Existing Claude Desktop processes may need a restart to load settings written only to disk. Native windows and sidebars do not necessarily reflect all Bridge changes immediately.

## Mobile navigation

The three main pages are **Sessions, Computers and Settings**, selected through the top-left header menu. Opening a computer or choosing Sessions opens the directory; a conversation opens when you select a session.

| Action | Location |
| --- | --- |
| Create a session and choose a working folder | “+” in the session directory |
| Rename, configure a model, fork or archive | “⋯” on a session row or conversation header |
| View evidence and file changes | Evidence entry in conversation “⋯” |
| Switch computers, edit connections and manage pairing | Computers and each computer's “⋯” |
| Appearance, Agent visibility, Magpie quota and diagnostics | Settings |

Android system back follows the current page hierarchy:

- The system dismisses an open keyboard first; menus, dialogs and sheets close before their underlying page.
- Evidence returns to the conversation, which returns to its directory or project list. Project and archive lists return to the session directory.
- Computer details return to the computer list; Computers and Settings return to the session directory.
- Back from the root session directory moves the app into the background. Reopen it to continue.

Back navigation and page changes neither send drafts nor stop desktop tasks. See the [mobile navigation guide](docs/MOBILE-NAVIGATION.md) for the full layout and interaction rules.

## Previews and file transfer

| Type | Support |
| --- | --- |
| Images | Preview in conversations and evidence, with scaled mobile previews |
| PDF | View inside the client through encrypted chunked transfers |
| Text and code | Complete UTF-8 files up to **1 MiB**; rendered/source Markdown and syntax highlighting for common languages |
| Downloads | Evidence and workspace paths from conversations, up to **20 MiB** per file, with workspace and sensitive-path checks |
| Uploads | Images and ordinary files, up to **20 MiB** per file, with progress, encrypted **256 KiB** chunks and SHA-256 verification |

Oversized, binary and invalid UTF-8 text produces an explicit error instead of a truncated preview. Uploads are stored under `.bridge-uploads/<uploadId>/<filename>` in the session's working directory, and sending appends relative paths. Files can be sent without additional text. Removing an attachment from the composer does not delete the saved file on the computer.

## Magpie quota dashboard

With a compatible Magpie Gateway, open Settings → Magpie quota to view accounts, plans, quota windows, balances and reset times. Session model settings also show the corresponding quota information.

- Read on demand and share readings between the dashboard and model settings, without background polling.
- Explicit refresh requests new readings for visible local accounts on the current Gateway. Remote-source readings retain their samples and status; local credentials are not forwarded to other sources.
- Distinguish Bridge fetch time from upstream sample time. Show cooldowns, retained readings and failures; a successful HTTP response does not guarantee a new sample.
- Do not replay active refresh after disconnecting or leaving the page. Refreshing quota does not change accounts, models or routing.

See the [plugin documentation](plugins/magpie-quota/README.md).

## Connections and data boundaries

```mermaid
flowchart LR
  Phone[Android client] <-->|WebRTC| Host[Local Bridge]
  Phone <-->|WS / WSS| Relay[Self-hosted relay]
  Host <-->|WS / WSS| Relay
  Host --> Runtime[Claude Desktop / local runtime]
```

Phone-to-Bridge payloads use per-device AES-256-GCM end-to-end encryption. The relay can see connection, routing, ciphertext and queue metadata. WebRTC direct connections and relay fallback depend on network reachability and ICE configuration.

This fork's everyday deployment uses **a local desktop host and Android client, with only the relay on the server**. A public WebUI is not required. Web/PWA support remains available for development. Model credentials stay on the computer, runtime accounts and sessions remain isolated, and cross-runtime handoff requires explicit confirmation.

| Document | Contents |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | Host, protocol, runtimes and data flow |
| [Security](docs/SECURITY.md) | Encryption, pairing, permissions and file boundaries |
| [Relay deployment](docs/RELAY-REDEPLOY.md) | Self-hosting and migration |
| [Background service](docs/BACKGROUND-SERVICE.md) | Desktop windows, background processes and state recovery |

## Development and validation

Requires **Node.js ≥ 22.13** and npm. Android builds also need a JDK and Android SDK. Desktop and iOS builds need the corresponding platform toolchains.

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

Development mode starts a local relay (`ws://127.0.0.1:8788/ws`), React client (`http://localhost:5188`) and Electron host. See [.env.example](.env.example) for packaged connection defaults; installed-app settings take priority.

| Command | Purpose |
| --- | --- |
| `npm run verify` | All typechecks, five regression suites and the full build |
| `npm test` | Desktop, client, protocol, relay and Magpie plugin regressions |
| `npm run test:infra` | Runner behavior, failure propagation and recycle-bin contracts |
| `npm run test:browser` | Six isolated browser scenarios using the actual App, crypto and a local relay |
| `npm run ci:run -- run build:android:debug` | Build an Android APK and check native plugin registration and every DEX |
| `npm run ci:run -- run make:adhoc -w @bridge/desktop` | Build a macOS ad-hoc test installer |

Validation entry points send Node temporary files to the system recycle bin; Linux requires `trash-cli`. Browser fixtures simulate desktop responses and model output without accessing production sessions. See [Testing](docs/testing.md) for browser setup, reports and coverage boundaries.

Validation primarily targets macOS and Android. Android system back has been exercised on an Android 16 emulator. Windows, Linux and iOS retain build and CI entry points, but a successful build does not establish physical-device acceptance on each platform. macOS ad-hoc packages are not Apple-notarized; unsigned iOS builds are not directly installable IPAs.

A synchronized version update on `main` creates a Release draft automatically. Publication waits for every platform asset job to succeed. See the [release rules](CONTRIBUTING.md#release-rules) and [Changelog](CHANGELOG.md).

## Repository layout and attribution

| Directory | Contents |
| --- | --- |
| `apps/client` | Shared mobile and desktop React UI |
| `apps/desktop` | Electron host, background service, sessions and file transfer |
| `apps/mobile` | Android / iOS Capacitor shells |
| `apps/relay` | Ciphertext relay and push wake |
| `packages/protocol` | Protocol, pairing, encryption and reliable transport |
| `plugins/magpie-quota` | Quota reading, active refresh and presentation |
| `scripts` / `deploy` / `docs` | Validation, builds, deployment and technical documentation |

Built on [czhmartinez/claude-desktop-bridge](https://github.com/czhmartinez/claude-desktop-bridge). This fork retains the **MIT** license; see [LICENSE](LICENSE).
