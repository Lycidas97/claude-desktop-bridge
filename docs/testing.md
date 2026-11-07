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
required. Eight independent contexts cover list/chat rename, delivery/approval/
reconnect, and native permission requests in light and dark at 375×812. The actual
mobile App, hooks, crypto and local relay run normally. The native approval case
uses a real `ClaudePermissionHook`, `PermissionBroker`, and the controller's
`permission.resolve` handler, with synthetic native Hook events and temporary
settings. It verifies allow/deny and single/multiple-choice answers on the waiting
Hook request, including phone identity and reconnect, without sending a chat turn.
Transcript-only native confirmations and unmatched questions remain non-actionable.
Other desktop RPCs and model responses are simulated. These checks do not launch a
native Desktop executor, an Android WebView or an IME; they do not prove which
requests a particular installed Desktop version emits.

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

CI retains Linux verification, Windows/Linux installers, Android, and iOS builds,
and adds macOS unit tests and browser E2E. Native Desktop unit fixtures explicitly
simulate macOS while mocking their process and inbox dependencies. POSIX mode-bit
assertions apply on macOS/Linux; Windows skips the two real child-process tests
that require POSIX signal reporting in exit events. Test reports and build artifacts upload
with `if: always()`, including after failures. The fixed `Quality gate` check passes
only when all seven jobs succeed; failed, cancelled, and skipped jobs fail it.
Repository administrators can select that check as required after the workflow is
published. Branch protection and release workflows are configured separately.
