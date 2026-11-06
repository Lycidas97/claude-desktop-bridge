# Contributing to Bridge

Thanks for helping Bridge grow. The project is small but production-shaped: every change is
expected to keep the typecheck, tests, and packaged builds honest.

## Development setup

Bridge is an npm workspace with four runnable parts:

```text
apps/client        React UI shared by desktop and mobile
apps/desktop       Electron host, session kernel, adapters
apps/mobile        Capacitor shell for Android/iOS
apps/relay         Ciphertext relay and push wake
packages/protocol  Protocol V3, crypto, reliable transports
```

Requirements: Node.js 22.13+, npm, and a checkout of the repository.

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

Keep changes scoped. Bridge intentionally does not merge native sessions, credentials, or
model settings between runtimes; review proposals that weaken those boundaries carefully.

## Release rules

Releases are controlled by automation on `main`:

1. Code and README changes are committed and pushed normally.
2. A synchronized version bump across all manifests triggers `release.yml`.
3. After validation, the workflow creates a draft GitHub Release for that version, then starts the platform asset jobs.
4. The Release and its tag are published only after the desktop, Android, and iOS asset jobs all succeed.

Do not create tags or GitHub Releases manually, and do not bump only one workspace. The
release workflow validates that `package.json`, every workspace, `package-lock.json`,
Android `versionName`, and iOS `MARKETING_VERSION` match exactly.

## Security

Security issues should be reported privately through the repository's security policy in
[SECURITY.md](docs/SECURITY.md) rather than opened as public issues. The security model is a
core product boundary: do not weaken encryption, add clipboard or accessibility access,
attach to native windows, or forward credentials to the relay.

## Code of conduct

Be constructive, patient, and specific. This project supports multiple competing desktop
ecosystems on purpose; disagreements about Claude, Codex, or Hermes belong in the issue
tracker only when they help a user complete a task.
