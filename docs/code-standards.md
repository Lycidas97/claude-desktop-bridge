# Code Standards & PR Verification Gates

Every pull request on `Lycidas97/claude-desktop-bridge` is checked against these five rules before merge.

## 1. Anti-Defensive Programming & Keep It Simple
- **No speculative concurrency or edge-case layers**: Never introduce locks, retry loops, fallback queues, or defensive guards for a hypothetical race condition without first stating the exact failure sequence and writing a deterministic failing reproduction test.
- **Inline over premature abstraction**: Keep logic in the calling function unless a helper is genuinely reused, isolates an external I/O boundary, or carries a clear domain name that simplifies the caller. Do not extract single-use helpers or single-read local variables.
- **Validate once at the boundary**: Parse and validate untrusted wire, IPC, or filesystem inputs at the boundary that owns them (`packages/protocol/src/validation.ts`, RPC entrypoints, inspector payloads). Pass typed values inward without redundant re-checks.
- **Never swallow errors silently**: Avoid blanket `try/catch` blocks that hide programming bugs. Only catch expected operational errors (e.g., `ENOENT`, `EPERM`, `InspectorDisconnectedError`) when handling them explicitly.

## 2. Native-Only Runtime Boundary
- Claude Desktop (`claude.web.LocalSessions` accessed via the user-authorized local Node inspector) is the sole authority for session creation, turns, message queues, permissions, and transcript pagination.
- Never reintroduce standalone SDK/CLI Hosts, provider execution lanes, session takeover/handoff, automatic goal loops, or legacy history fallbacks.
- `apps/desktop/src/legacy/` holds quarantined pre-1.3 modules solely for backward-compatible storage schemas and retired-connector cleanup (`removeLegacyConnector`). Never wire new features into `apps/desktop/src/legacy/`.
- Never expose arbitrary inspector `evaluate` over Relay or transmit credentials/plaintext through `apps/relay`.

## 3. Recycle-Bin-Only File Deletion
- Permanent deletion (`rm`, `/bin/rm`, raw `fs.rmSync` / `fs.unlink` without the recycle preload, or `Remove-Item`) is strictly forbidden across local shells, SSH hosts, Python, PowerShell, and Node scripts.
- Move deleted files and directories to the OS Recycle Bin:
  - **macOS**: `/usr/bin/trash <path>`
  - **Linux**: `trash-put <path>` (`trash-cli`)
  - **Node tests & scripts**: preload `scripts/recycle-cleanup.cjs` (automatic in `npm test`, `npm run test:infra`, `npm run verify`, `npm run test:browser`, and `npm run ci:run -- ...`). Standalone test files that remove temporary directories must load `scripts/recycle-cleanup.cjs` explicitly.
- If the OS recycle command is unavailable or fails, surface the error and retain the path (as hosted Windows Server QA does); never fall back to permanent deletion.

## 4. Deliberate UX & Visual Restraint
- Avoid redundant subtitles, secondary descriptions, explanatory callouts, and helper paragraphs. Communicate structure through visual hierarchy, spacing, alignment, typography, and concise control labels.
- Preserve essential labels, units, accessibility roles, error states, and confirmation dialogs for destructive actions (such as native session deletion).
- Never reverse deliberate product or UI layout decisions without explicit owner direction. When changing Desktop Settings or workspace labels, update `scripts/packaged-desktop-qa.mjs`, `scripts/windows-native-qa-contract.test.mjs`, and `scripts/browser-e2e.mjs` in the same commit.

## 5. Verification, Memory Hygiene & PR Evidence Gates
- **Red Check**: For every bug fix, temporarily revert the fix and run the new or updated test to confirm it fails for the **exact broken behavior**. Compile errors, syntax errors, and skipped tests do not satisfy the Red Check. Pure structural refactors and documentation-only PRs must explicitly record `N/A — pure structural refactor` (or `N/A — docs only`).
- **Real Surface Check**: Reproduce bugs and verify fixes on the runtime surface actually affected:
  - macOS packaged app (`make:local-signed` / `make:adhoc` + `test:desktop:service` / real Claude Desktop Inspector)
  - Windows 11 physical/SSH test host (`ssh win` or `test:desktop:packaged:windows`)
  - Android APK (`build:android:debug` / `test:android:installed`)
  - Browser mobile viewport E2E (`npm run test:browser`)
  Never claim synthetic fixture or unit tests prove live Claude Desktop, MSIX, TCC, or mobile WebView behavior.
- **Explicit `Not Run` accounting**: Every PR body must list unexecuted checks under `## Not Run` with the concrete reason (e.g., `Windows 11 live MSIX check — not touched by client CSS change`). Silent omission is a review blocker.
- **Lean Subsystem Docs & Verified Memory**: Keep `docs/subsystems/*.md` focused on directory boundaries, cross-file contracts, and non-obvious invariants — never hand-copy static file lists that `glob` provides. Record only empirically verified pitfalls and recipes in `LESSONS.md`, and respect single-writer ownership across parallel forked worktrees.
- **Head SHA Lock on Merge**: Push branches and open PRs only on `Lycidas97/claude-desktop-bridge`. Merge only after `ci/local-distributed` (or manual `Quality gate`) succeeds on the exact reviewed commit using the command below; docs-only PRs (all paths match `docs_only` in `.github/workflows/ci.yml`) skip `ci:local` and record `ci:local — docs only` under `## Not Run`:
  ```bash
  gh pr merge <pr-number> --repo Lycidas97/claude-desktop-bridge --squash --match-head-commit <reviewed-sha>
  ```
