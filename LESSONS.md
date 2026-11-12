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
