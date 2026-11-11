# Subsystem: CI, Release & Packaged QA

## Owned Paths
- `.github/workflows/`
  - `ci.yml`, `release.yml`, `release-assets.yml`
- `scripts/`
  - Cleanup & runners: `recycle-cleanup.cjs`, `ci-run.mjs`, `test.mjs`, `clean.mjs`
  - Infrastructure contract suites: `ci-infrastructure.test.mjs`, `windows-native-qa-contract.test.mjs`, `release-workflow.test.mjs`
  - Synthetic Native fixtures: `fixtures/native-approval-host.ts`, `fixtures/native-section-store.ts`, `fixtures/inspector-startup-host.cjs`, `fixtures/fake-claude.mjs`
  - E2E & packaged QA scripts: `browser-e2e.mjs`, `packaged-desktop-qa.mjs`, `windows-packaged-qa.ps1`, `desktop-pairing-e2e.mjs`, `service-restart-qa.mjs`, `claude-inspector-startup-qa.mjs`, `html-preview-qa.mjs`, `media-preview-qa.mjs`, `visual-qa.mjs`, `android-installed-e2e.mjs`, `verify-android-dex.py`

## Responsibilities
- Enforces the 7-job CI matrix (`verify`, `desktop-windows`, `desktop-linux`, `android-debug`, `ios`, `macos-unit`, `browser-e2e`) gated by the `Quality gate` job in `.github/workflows/ci.yml`.
- Orchestrates immutable single-revision draft creation and multi-platform release publishing across `.github/workflows/release.yml` and `.github/workflows/release-assets.yml`.
- Enforces Trash-only file removal in Node processes (`recycle-cleanup.cjs`) and isolates all automated QA from real user profiles, production relays, and live Claude Desktop sessions.

## Critical Invariants
1. **Non-cancellable `main` CI**: `ci.yml` sets `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`. Stale runs on an open PR cancel on new pushes, while every `push` to `main` runs to completion so rapid merges never cancel a release candidate's `CI` run.
2. **Completed-and-successful Release CI gate**: Both `release.yml` (`Require successful CI for manual retry`) and `release-assets.yml` (`Resolve source and require successful CI before publication`) query `gh run list ... --json headSha,status,conclusion` and pipe to `jq --arg rev ... 'any(.[]; .headSha == $rev and .status == "completed" and .conclusion == "success")' | grep -qx true`. Never reference unexported shell variables via `jq 'env.VAR'`, and never accept `in_progress`, `cancelled`, or mismatched-SHA runs.
3. **Synchronized manifests & pinned Android debug key**: Root `package.json`, all workspaces, `package-lock.json`, Android `versionName`, and iOS `MARKETING_VERSION` must match exactly. Android debug builds must match SHA-256 certificate digest `8b4e8a0ed8e506dde6ff65f92b9bd526d2fcaf10d35089d381a02d9ed23a18db`.
4. **Windows QA isolation & hosted runner retention**: `windows-packaged-qa.ps1` must explicitly set both `BRIDGE_RELAY_URL` and `BRIDGE_PUBLIC_RELAY_URL` to the local test relay (empty env vars on Windows may drop and fall back to production defaults) and isolate `USERPROFILE`/`APPDATA`/`LOCALAPPDATA`. On GitHub-hosted Windows Server runners (`RUNNER_ENVIRONMENT=github-hosted`), retain packaged QA directories instead of invoking unavailable Recycle Bin directory moves, and skip NTFS junction Recycle Bin subtrees (`DE_ACCESSDENIEDSRC`).
5. **Fixture honesty**: Synthetic fixtures (`native-approval-host.ts`, `browser-e2e.mjs`) prove Bridge wiring and UI state transitions; never claim they prove live Claude Desktop, macOS TCC, or physical mobile behavior.

## Minimum Verification
```bash
npm run test:infra
npm run verify
npm run test:browser
```
