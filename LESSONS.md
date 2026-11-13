# Verified Lessons & Recipes

## Offline Consolidation (Dreaming) Loop
During scheduled consolidation (`bridge-tech-debt-patrol`) or pre-release retros, audit both recent `main` commits and recent Bridge session transcripts:
1. **Extract verified pitfalls & recipes**: Capture rework/reverts, boundary or selector regressions, weak verification, **and** non-obvious cross-session troubleshooting/testing patterns proven in practice.
2. **Verified-only admission**: Never record untested hypotheses or static file inventories that `glob`/`grep` already show. Every entry must cite the proving commit SHA or exact verification command.
3. **Staleness & link audit**: Verify every path, script, selector, and capability cited here and in `docs/subsystems/*.md` against `main`; repair or remove drifted entries immediately.
4. **Bidirectional promotion & zero graveyard**: When an entry reaches `Seen 3×` across **3 distinct calendar dates**, promote subsystem-specific rules downward into the owning `docs/subsystems/*.md` (`Critical Invariants`) and cross-cutting rules upward into `docs/code-standards.md`, then **delete the entry from `LESSONS.md`** (Git history preserves the full audit trail).

### Templates

```markdown
**[Pitfall] <One-sentence imperative rule>**
- Broken in: `<commit/issue>` — <what went wrong>
- Fixed in: `<commit>`
- Done right: <concrete positive example>
- Seen N× (YYYY-MM-DD, ...)

**[Recipe] <One-sentence actionable pattern>**
- Context: <non-obvious environment or cross-file constraint>
- Verified in: `<commit>`
- Pattern: <exact command, flag, or architectural recipe>
- Seen N× (YYYY-MM-DD, ...)
```

---

## Active Entries

**[Pitfall] Import source directly in probes that run before package builds, and test them without package dist.**
- Broken in: `f6c33d0932a3326eb9cd3ed15ae2836d71b172a2` / `Lycidas97/claude-desktop-bridge#61` — Windows infra ran before the protocol build; stale dist lacked the new export and the relay probe failed with SyntaxError.
- Fixed in: `dc9563366a0c4f52fdb83deb357c4a77fe1080c8`
- Done right: `scripts/relay-contract-probe.mjs` imports protocol source. The isolated no-dist HTTP/WS regression failed before the fix and passed afterward; exact-head full CI `ci-local-pr62-1d96688-20261113T112537Z-56909` passed.
- Seen 1× (2026-11-13)

**[Recipe] Run a short typecheck after merging main, before starting distributed CI, even after a clean textual merge.**
- Context: PR41's empty remerge diff missed a branch-only test fixture omitting PR37's newly required sectionManage prop; full CI on `f065d81f85338278059aca8046ca4625bc6d49eb` failed with TS2769.
- Verified in: `c5c898887096c0b48bcef1240dc4ddd2280ae407`
- Pattern: After syncing main, run Node26 `npm run ci:run -- run typecheck`. The fixture correction at `648a2bd8596607ab2d4f8153499ceda5a6657212` passed independent review and full CI. This is compile-interface evidence, not a runtime Red Check.
- Seen 1× (2026-11-13)

**[Pitfall] Persist deduplication receipts only after their log write succeeds, and preserve private permissions on new SQLite files.**
- Broken in: `57e0f197921fee3a9de6d6dbf4d85bba0256012d` / `Lycidas97/claude-desktop-bridge#52` — a failed JSONL append left a durable receipt that suppressed the missing event after reopening; umask022 created DB/WAL/SHM as0644 beside a0600 log.
- Fixed in: `f42a5a97383cf3fb8e667f19cd45220bbb76b30a`
- Done right: `session-event-log.ts` performs receipt upsert after successful JSONL write in the existing writeQueue, and creates/tightens the DB to0600 before opening SQLite/WAL. Its portable append-failure regression still fails on the old production code at the reopened ghost-receipt assertion; permissions and exact-head full CI `ci-local-pr63-78003db-20261113T142332Z-4103` passed.
- Seen 1× (2026-11-13)

**[Pitfall] Close SessionEventLog instances owned by a fixture before recycling their temporary directories.**
- Broken in: `b9beccde939a81a2a2cf7294f8207a744bd11e5e` / `Lycidas97/claude-desktop-bridge#52` —26 evidence fixtures closed the manager but left externally supplied SQLite logs open; real Windows directory rename failed with EPERM and native recycling returned124, then returned0 after log.close().
- Fixed in: `f42a5a97383cf3fb8e667f19cd45220bbb76b30a` (fixture correction `4686a8ac5f514b2996accecbf778f12fe0b1725d`)
- Done right: `evidence-manager.test.ts` records and closes the logs its fixture created before recycling roots. On the same owned Windows clone, old revision failed26/27 and corrected fixture passed27/27; final full CI passed. Production EvidenceManager retains its existing ownership contract.
- Seen 1× (2026-11-13)

**[Pitfall] Do not use chmod0400 alone to trigger a write failure under privileged CI identities.**
- Broken in: `4686a8ac5f514b2996accecbf778f12fe0b1725d` / `Lycidas97/claude-desktop-bridge#52` — WSL uid/euid0 with CAP_DAC_OVERRIDE successfully appended to the0400 file, invalidating the test's EACCES premise.
- Fixed in: `f42a5a97383cf3fb8e667f19cd45220bbb76b30a` (test correction `78003db3986fea5ba7bff1d29320d2a3f1bef87b`)
- Done right: After real log initialization, inject one EACCES at writeFile, assert its exact JSONL path and append/UTF8/0600 arguments, then close/reopen real SQLite and verify no ghost receipt. The same new test fails on old production code; it executes on Mac, Windows and root WSL without changing the CI identity or skipping the regression. Full CI passed.
- Seen 1× (2026-11-13)

**[Pitfall] Propagate destination-stream errors from creation onward, and keep the source pending in the regression.**
- Broken in: `e40ca7e0eff75a47c6e65147d84b4c75fb7c65a2` / `Lycidas97/claude-desktop-bridge#16` — download.part was a directory while the HTTP body stayed pending; createWriteStream emitted uncaught EISDIR and the updater remained downloading.
- Fixed in: `379078277a9f0228e7228a376a2b50f36798a552`
- Done right: `desktop-updater.ts` passes the response pipeline and newly created destination stream to pipeline; the real-filesystem regression reaches updater error and cancels the source. Original reviewer returned CLEAN and full CI `ci-local-pr40-retry1-20261113T143356Z-48766` passed; this test does not prove an actual installation or upgrade.
- Seen 1× (2026-11-13)

**[Pitfall] Never execute production-`appId` NSIS installers or uninstallers during local Windows QA on shared hosts.**
- Broken in: `b5a2300` / `#28` — `scripts/windows-packaged-qa.ps1` ran `Bridge-*-Setup.exe /S /D=$installRoot` and `Uninstall*.exe /currentuser /S` under the developer's Windows user account; NSIS `uninstallOldVersion` read `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<appId>`, killed live `D:\Tools\Bridge\Bridge.exe`, and wiped `D:\Tools\Bridge` even with `/D=$installRoot` and isolated `APPDATA`.
- Fixed in: `#28`
- Done right: Stage `win-unpacked` into `$installRoot` whenever `$env:RUNNER_ENVIRONMENT -ne "github-hosted"`, restrict NSIS `Setup.exe` / `Uninstall*.exe` execution to ephemeral `github-hosted` VMs, and terminate only `[IO.Path]::GetFullPath($installRoot)\`-prefixed detached processes before Recycle Bin cleanup (`scripts/windows-native-qa-contract.test.mjs`).
- Seen 1× (2026-11-12)

**[Pitfall] Update packaged Desktop QA selectors and contract tests whenever Desktop Settings section titles or diagnostic labels change.**
- Broken in: `5f5c76f` — reorganized Desktop Settings sections (`连接与设备` split into `连接与启动` and `诊断与关于`) without updating `scripts/packaged-desktop-qa.mjs` or `scripts/windows-native-qa-contract.test.mjs`, breaking packaged Desktop QA assertions.
- Fixed in: `c6aa944`
- Done right: `c6aa944` updated `scripts/packaged-desktop-qa.mjs` and `scripts/windows-native-qa-contract.test.mjs` in lockstep and verified with `npm run test:infra`.
- Seen 1× (2026-11-11)

**[Pitfall] Declare new host capabilities in browser E2E synthetic fixtures when gating client requests on `host.capabilities`.**
- Broken in: `75b170e` — gated pre-preview file size metadata checks on `artifact.transfer.stat.v1` in `DesktopController` and `MediaPreviewProvider` without adding `"artifact.transfer.stat.v1"` to `createMockHost` in `scripts/browser-e2e.mjs`.
- Fixed in: `79e5700`
- Done right: `79e5700` added `"artifact.transfer.stat.v1"` to `createMockHost` in `scripts/browser-e2e.mjs` and asserted in `verifyNativeBoundaries` that `purpose: "stat"` precedes `purpose: "text-preview"`.
- Seen 1× (2026-11-11)

**[Pitfall] Pass explicit target platform arguments to OS-specific output parsers instead of defaulting to `process.platform`.**
- Broken in: `326dc80` — `parseInspectorDesktopProcesses` parsed macOS `ps` output using `desktopAppPathCandidates(CLAUDE_DESKTOP_APP)` with implicit `process.platform`, causing unit tests to fail on Linux and Windows CI runners.
- Fixed in: `1251ddb`
- Done right: `1251ddb` passed explicit `"darwin"` to `desktopAppPathCandidates` in `parseInspectorDesktopProcesses` and parameterized `claude-inspector-startup.test.ts` across `["darwin", "linux", "win32"]`.
- Seen 1× (2026-11-10)

**[Pitfall] Update synthetic Node inspector `require(...)` sandboxes in `scripts/service-restart-qa.mjs` whenever `ClaudeDesktopInspector` probes a new builtin module.**
- Broken in: `978ec59` — added `process.mainModule.require('module')._cache` section probing in `claude-desktop-inspector.ts` and updated `claude-desktop-inspector.test.ts`, but left `assert.equal(name, 'electron')` in `scripts/service-restart-qa.mjs`, breaking `test:desktop:service` session discovery.
- Fixed in: `0482dd3`
- Done right: `0482dd3` stubbed `if (name === 'module') return { _cache: {} }` in `scripts/service-restart-qa.mjs` and verified all 8 service lifecycle checkpoints pass via `npm run ci:run -- run test:desktop:service`.
- Seen 1× (2026-11-11)

**[Recipe] Use `[STAThread]` native `SHFileOperationW(0x0454)` (`scripts/win-recycle.cs`) and `SetThreadExecutionState` for Windows OpenSSH Session 0 test runs.**
- Context: Cold-spawning `powershell.exe` per `fs.rm()` inside Windows OpenSSH `Session 0` takes `~1.05s` and triggers 30.9s DCOM `{8CFC164F-4BE5-4FDD-94E9-E2AF73ED4A19}` stalls during Vitest `afterEach`, while 15 minutes of idle console input triggers Windows Modern Standby and drops SSH mid-suite.
- Verified in: `b5a2300`
- Pattern: Compile `scripts/win-recycle.cs` with `csc.exe` (`BRIDGE_WIN_RECYCLE_EXE` -> `0.22s` per Recycle Bin move), hold `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` in `scripts/win-local-ci.ps1`, and pass `-o ServerAliveInterval=15 -o ServerAliveCountMax=3` on `ssh`/`scp`.
- Seen 1× (2026-11-12)

**[Recipe] Stamp deferred pushes and tree-identical squash-merged `main` commits via `npm run ci:local -- --publish` instead of re-running multi-host CI.**
- Context: `scripts/local-ci.mjs` records both `<sha>.json` and `tree-<HEAD^{tree}>.json` receipts under `<git-common-dir>/local-ci/` after a clean full run. Pushing after verification or merging via `gh pr merge --squash` produces a new commit or remote ref with the identical Git tree.
- Verified in: `b5a2300`
- Pattern: After `git push` or fast-forwarding local `main` to a squash-merged PR commit whose `HEAD^{tree}` matches the verified branch, run `npm run ci:local -- --publish` to post `ci/local-distributed = success` directly to `Lycidas97/claude-desktop-bridge`.
- Seen 1× (2026-11-12)

**[Pitfall] Give concurrent WSL Electron Packager builds a separate TMPDIR per CI slot.**
- Broken in: `45229d5` / `Lycidas97/claude-desktop-bridge#46` — Electron Packager 18.4.4 clears its shared `<os.tmpdir()>/electron-packager` root on startup, deleting another process’s existing Linux template before `LinuxApp.initialize()` consumes it.
- Fixed in: `2b51a7e`
- Done right: In the WSL Bash script emitted by `scripts/win-local-ci.ps1`, export `TMPDIR="$CI_DIR-tmp"` and create it before Linux builds. The Linux-only regression in `scripts/windows-native-qa-contract.test.mjs` executes two real Packager processes in a fixed create→second-startup→consume sequence: shared root fails with template ENOENT; slot-specific roots pass. Run `npm run test:infra` under WSL Ubuntu24.04; the final four-way full run also passed with isolated roots.
- Seen 1× (2026-11-12)

**[Pitfall] Set BOM-free PowerShell Console.InputEncoding before piping a strict Bash script into WSL.**
- Broken in: `6f35763` / `Lycidas97/claude-desktop-bridge#46` — after `chcp 65001`, the input pipe began with EF BB BF, so the first `set -euo pipefail` was invalid and later successful commands concealed a prior Git failure.
- Fixed in: `2b51a7e`
- Done right: Set `[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)` before `wsl.exe ... bash -s`. The actual Windows→WSL regression in `scripts/windows-native-qa-contract.test.mjs` pipes `false` followed by a success sentinel: original returns 0 and prints the sentinel; fixed returns 1 before the sentinel. Run `npm run test:infra` on Windows; both red and green execute with zero skips.
- Seen 1× (2026-11-12)
