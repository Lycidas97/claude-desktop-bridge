# Testing

Use Node.js 26 LTS from [`.nvmrc`](../.nvmrc) and the dependencies from `npm ci`.
The minimum compatible Node.js version remains 22.13. Dependency installation runs
without a cleanup preload. Validation requires `/usr/bin/trash` on macOS,
`trash-put` (`trash-cli`) on Linux, or Windows PowerShell and the system Recycle Bin.

| Command | Coverage |
| --- | --- |
| `npm test` | Desktop, client, protocol, relay, then `plugins/magpie-quota`; sequential Vitest runs, at most two workers each |
| `npm run typecheck` | All workspace typechecks, then the quota plugin explicitly |
| `npm run verify` | Typecheck, five test suites, then the full root build; stops at the first failing stage |
| `npm run test:infra` | Small fixtures for runner failure propagation and recycle-bin behavior |
| `npm run test:browser` | Builds protocol and relay, then runs the self-contained browser fixture |
| `npm run ci:run -- run test:desktop:service` | After a current Desktop build: real compiled Electron UI/service with isolated Native fixture; on macOS also verifies developer settings, real random TCP/lsof/proc_pidpath, ASAR helper, injected warning UI, and completed background scans after window close |
| `npm run ci:local` | Concurrent local distributed CI across Mac (`test:infra`, `audit:runtime`, `verify`, `test:browser`, `test:desktop:service`) and `ssh win` (`D:\work\ci-worktree`: Windows tests, NSIS installer + packaged QA, Android API 36 debug APK + DEX/cert + WHPX emulator WebView pairing smoke, and WSL2 `Ubuntu-24.04` `.deb`/`.rpm`/`.zip`) |
| `npm run ci:run -- run build -w @bridge/protocol` | Example of wrapping another npm command with Trash-only Node cleanup |

The quota plugin is outside the `apps/*` and `packages/*` workspaces; root test and
typecheck include it explicitly. These commands do not enable real model sessions
or the opt-in native WebRTC tests. Unit tests use their existing mocks and fixtures.
Browser testing uses its own local fixture rather than a production service.
Unit tests ignore the client's local env files and clear inherited `VITE_*` values;
application build commands continue to use their configured build environment.
CI tests the checked-out source under `apps/`, `packages/`, and the quota plugin.
Snapshots under the ignored `output/` directory are not CI inputs; fixes must be
integrated into the normal source before their candidates can be covered by CI.

## Reports

`npm test` writes `artifacts/tests/<suite>.xml` (JUnit), `<suite>.log` (stdout,
stderr, and runner errors), and `summary.json`. The suite names are `desktop`,
`client`, `protocol`, `relay`, and `quota`. A failed process, launch error, or missing
or empty JUnit report fails the command. Later suites still run and retain evidence.
A suite's previous JUnit report is sent to Trash before that suite starts, so it
cannot satisfy the new run. Logs are replaced and the summary is updated after
each suite. Reports are local artifacts; avoid including them in source commits.

Browser evidence is written to `artifacts/browser-e2e`. To install the Chromium
version matching the existing `playwright-core` dependency, run:

```bash
node node_modules/playwright-core/cli.js install --with-deps chromium
```

```bash
npm run test:browser
```

Alternatively set `CHROME_PATH` to an installed Chrome/Chromium executable. The
browser script owns fixture startup and shutdown; no separately running relay is
required. Seven scenarios run in both themes at 375×812, giving 14 independent
contexts: list/chat rename, delivery/approval/reconnect, Native approvals, Native
messages, history pagination, and Native boundaries. The actual mobile App, hooks,
crypto and local relay run normally. The Native fixture uses the real
`ClaudeDesktopBridge`, controller and evidence transfers with synthetic LocalSessions,
including permission IDs, image references, saved model labels and runtime aliases,
worktree file paths, compact/sidechain filtering and task-plan updates.
These checks do not attach to real Claude Desktop, launch an Android WebView or
exercise an IME; they do not establish which events a particular installed Desktop
version emits.

The service QA uses an owned random-port inspector fixture and passes its origin
through `BRIDGE_CLAUDE_INSPECTOR_URL` to the background process. On macOS it operates
only temporary Claude/Claude-3p developer settings, checks real monitor scans after
window close, and separately measures random TCP connections with lsof/proc_pidpath.
The warning UI receives that measured status through renderer IPC injection; this
is component integration evidence, not proof of automatic monitor-to-UI alert
delivery or real macOS notification authorization. ASAR helper execution is checked
separately from the signed application package.

On macOS, the inspector startup QA exercises the real System Events menu path in
an isolated Electron app with a random inspector port and synthetic LocalSessions:

```bash
npm run ci:run -- exec -- node scripts/claude-inspector-startup-qa.mjs output/inspector-startup-qa
```

The launching host needs Accessibility and System Events Automation permission.
It checks late menu construction, one actual checkbox action, real Node discovery,
fixture LocalSessions access, checked-menu protection, manual closure across a
recreated startup object, a new process, native policy rejection, already-open
skip behavior, and persistent errors from a disabled native menu. Permission rejection is covered by unit injection; the QA does not
revoke system consent or approve dialogs. Evidence is `result.json` plus per-process
Electron logs. It never targets real Claude Desktop, port 9229, or its event stream.
The fixture validates the native automation path in the current host context;
it does not establish installed Bridge TCC authorization or formal notarized signing.

`native-phone-approval.integration.test.ts` additionally checks stale IDs, duplicate
responses, native local answers, lifecycle cancellation, and disconnected Hook
requests. Native manual-only requests remain pending through full-access policy
changes. No test changes real Claude settings or calls a model.

Browser failures retain screenshots, HTML, traces, console errors and RPC records;
passing native scenarios also retain screenshots and a correlated request trace.

After the protocol and relay builds exist, a local debug fixture can be kept open:

```bash
BRIDGE_E2E_PORT=18909 node --require ./scripts/recycle-cleanup.cjs scripts/browser-e2e.mjs --serve
```

It listens only on loopback and prints a temporary test pairing URL. Use that
exact origin, including its hostname, so the App's same-origin CSP remains valid.
Stop the command to close its owned relay and HTTP server.

## Fork boundaries

`fork-boundary.test.ts` and the broker lifecycle/history tests use synthetic DAG
transcripts and fake hosts. They check complete-turn cutoffs, selected-parent-chain
filtering, persisted ancestry after restart, and separation of inherited Agent
history from tasks owned by the child's current host generation. Child background
tasks remain live when the main turn ends. Metadata-only first-turn forks start a
new native session; forks with their own native history resume that history.
These checks do not call a model or alter the parent's transcript or working files.

## Cleanup boundary

The runners append the checkout's `scripts/recycle-cleanup.cjs` to `NODE_OPTIONS`,
keeping existing options and environment variables. Paths are resolved at runtime
and quoted for checkouts containing spaces. The preload redirects Node's sync,
promise, and callback `rm`, `unlink`, and `rmdir` APIs to the operating system's
recycle command. Missing paths are ignored only with `force: true`. Unsupported
systems, missing recycle commands, and recycle failures surface as errors; there
is no permanent-delete fallback. The preload selects the host platform at startup,
so application tests that mock `process.platform` do not change the recycle command.

This covers Node processes that inherit `NODE_OPTIONS`. It does not intercept
native tools, shell deletion commands, browser internals, or processes that discard
the environment. Use the operating system's Trash command for manual cleanup.

## CI

CI runs on pull requests, pushes to `main`, and manual dispatch. Feature branches
are checked through their pull requests, avoiding duplicate push and PR runs that
cancel each other for the same commit.

CI uses tiered checks on `pull_request` (`test:infra` for docs-only PRs; Ubuntu
`verify` and `browser-e2e` for code PRs, plus `ios` when `apps/mobile/ios/` changes),
paired with pre-PR multi-platform local verification via `npm run ci:local`. On pushes
to `main` and manual dispatch, CI runs the full 8-job matrix (`changes`, Linux `verify`,
Windows/Linux installers, Android, iOS, macOS unit tests, and browser E2E). Native Desktop unit fixtures explicitly
simulate macOS while mocking their process and inbox dependencies. POSIX mode-bit
assertions apply on macOS/Linux; Windows skips the two real child-process tests
that require POSIX signal reporting in exit events. Test reports and build artifacts upload
with `if: always()`, including after failures. On `main` pushes and manual dispatch,
the fixed `Quality gate` check passes only when all eight jobs succeed (failed,
cancelled, and skipped jobs fail it); on pull requests, it requires every non-skipped
job in the PR tier to succeed without failures or cancellations.
Repository administrators can select that check as required after the workflow is
published. Branch protection and release workflows are configured separately.
