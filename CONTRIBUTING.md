# Contributing to Bridge

Thanks for helping Bridge grow. The project is small but production-shaped: every change is
expected to keep the typecheck, tests, and packaged builds honest.

## Development setup

Bridge is an npm workspace with four runnable parts:

```text
apps/client        React UI shared by desktop and mobile
apps/desktop       Electron bridge, native adapters, transport and evidence
apps/mobile        Capacitor shell for Android/iOS
apps/relay         Ciphertext relay and push wake
packages/protocol  Protocol V3, crypto, reliable transports
```

Use Node.js 26 LTS (selected by [`.nvmrc`](.nvmrc)), npm, and a checkout of the repository.
With nvm installed, run `nvm install` and `nvm use` before installing dependencies.
The minimum compatible Node.js version remains 22.13; Electron runs its bundled Node.js.
CI build jobs select Node.js from `.nvmrc`. Official JavaScript Actions use their own
Node.js 24 runtime and require an Actions runner version of at least 2.327.1.

The scoped `@electron/packager` override uses Electron's maintained native ZIP
extractor. Its older `extract-zip` dependency leaves the Electron 43 macOS archive
unfinished on Node.js 26, so Forge can exit without producing an app bundle.

```bash
npm ci
```

```bash
npm run build -w @bridge/protocol
```

```bash
npm run dev:desktop
```

## Useful commands

```bash
npm run typecheck
npm test                # five sequential suites; artifacts/tests
npm run test:infra      # runner and recycle-bin contract fixtures
npm run test:browser    # local browser fixture; optional CHROME_PATH
npm run verify          # typecheck + tests + full build
npm run probe:relay     # relay contract probe
npm run test:visual     # browser visual QA
npm run audit:runtime   # production dependency audit
npm run build:android:debug
```

`npm test`, `npm run verify`, and `npm run test:browser` use Trash-only Node cleanup.
Linux needs `trash-put` from `trash-cli`; macOS uses `/usr/bin/trash`, and Windows uses
PowerShell with the system Recycle Bin. Run `npm ci` without the cleanup preload.
See [Testing](docs/testing.md) for suite boundaries, browser setup, and report paths.

## What to include in a PR

- A focused description of the user-visible behavior and why the change is needed.
- Tests for new protocol, state, or UI behavior. Existing packages use Vitest and
  Playwright-backed QA scripts.
- Documentation updates when a capability, permission, or protocol contract changes.
- No unrelated refactors, formatting churn, or generated file changes.

Keep changes scoped. This branch adapts Claude Desktop, including Claude-3p. Native sessions, credentials,
models, queues and permissions remain under Desktop control.

For the approved Claude refactor, `claude-desktop-bridge.ts` is a thin forwarding layer;
Claude Desktop alone owns session execution, queues, and permissions. Discover the dynamic
WebSocket from the user-authorized Node inspector at `http://127.0.0.1:9229/json/list`, use
`process.mainModule.require('electron')` to locate the `app://localhost` WebContents, and
call `claude.web.LocalSessions` through `executeJavaScript`. Events use one renderer queue
and a waiting Promise. Do not restore SDK/CLI Hosts, standalone API Key provider lanes,
Claude takeover/release, inbox, lanes, or automatic goal continuation. Independent Codex,
Hermes and DSH integrations and cross-Agent handoff are retired. Preserve their saved
configuration and history without starting adapters or replaying old requests. Claude
Desktop model providers such as Gemini, Antigravity and Magpie remain in scope.

Keep pairing, E2EE Relay/WebRTC, request idempotency and receipts, event replay, and passive
attachment/evidence collection. Use Desktop's native session IDs and transcript APIs directly;
do not import legacy data, map old logical IDs, offer legacy history fallback, or restore old
queue entries as drafts. Leave old data untouched and never automatically resend mobile
`bridgeExecutionRequested` intents. Retired connector cleanup backs up settings before
removing only Bridge-owned MCP/hooks. Dynamic hooks
must match the old installer's exact loopback path `/hooks/claude-permission`,
`X-Bridge-Permission-Host: $BRIDGE_PERMISSION_HOST`, and `allowedEnvVars` marker; preserve
unrelated hooks and settings. Use isolated fixtures, never real user settings, for tests:

```bash
npm run ci:run -- test -w @bridge/desktop -- src/connector.test.ts
```

The new inspector and relay facade have been exercised against the installed macOS
Desktop: empty session creation, sending, native lifecycle events, transcript history,
request deduplication, and session retention after Bridge closes. Native permissions and
individual subagent stopping have contract coverage, but have not been exercised end to
end against the installed Desktop. See [HOSTING-REFACTOR.md](docs/HOSTING-REFACTOR.md)
for current verification and its separately marked historical Host acceptance record.

## Release rules

Releases are controlled by automation on `main`:

1. Code and README changes are committed and pushed normally.
2. A successful complete `CI` run on `main` starts `release.yml`, which checks the synchronized version at that run's commit.
3. If the version is unpublished, the workflow creates or resumes its draft GitHub Release and starts all platform asset jobs at that exact commit.
4. The Release and its tag are published only after the desktop, Android, and iOS asset jobs all succeed. Failed drafts can be retried; manual retries also require successful CI for the selected commit.

Do not create tags or GitHub Releases manually, and do not bump only one workspace. The
release workflow validates that `package.json`, every workspace, `package-lock.json`,
Android `versionName`, and iOS `MARKETING_VERSION` match exactly.

## Security

Security issues should be reported privately through the repository's security policy in
[SECURITY.md](docs/SECURITY.md) rather than opened as public issues. The security model is a
core product boundary: do not weaken encryption, add clipboard access, or forward
credentials to the relay. The user has explicitly chosen to keep Claude's local Node
inspector on port 9229 enabled; this supersedes the previous blanket “no CDP / no
attachment” rule for Claude. It permits the fixed `LocalSessions` integration described
above, not a Relay-accessible arbitrary evaluate endpoint. On macOS, Accessibility and
System Events Automation access is limited to the native Enable Main Process Debugger
menu once per newly discovered Desktop process, respecting native account/workspace
policies. Skip already-open ports and custom inspector origins; persist attempts and
failures across Bridge service restarts, respect manual closure, and show failures in
diagnostics. The user must grant the required macOS permissions. Do not automate other
menus, send keyboard/mouse events, patch asar, mint tokens, restart Desktop, add a
LaunchAgent, send SIGUSR1, or change debugging launch arguments. If inspector remains
unavailable, report Claude as unavailable.

## Code of conduct

Be constructive, patient, and specific. This project supports multiple competing desktop
ecosystems on purpose; disagreements about Claude, Codex, or Hermes belong in the issue
tracker only when they help a user complete a task.
