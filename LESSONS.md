# Verified Lessons & Recipes

Non-obvious rules an agent needs **before** editing, each proven by a commit. Consolidation, staleness audit, and promotion (`Seen 3×` on 3 distinct dates) follow the **Offline consolidation** row in `AGENTS.md`.

Do not add an entry when:
- a regression test already fails if someone undoes the fix (the test is the lesson);
- the rule is already in `AGENTS.md`, `docs/code-standards.md`, or a `docs/subsystems/*.md` invariant;
- it describes how existing tooling works (read the script) or a one-off event that cannot recur.

Keep each entry to the rule, one line of what broke, and the commits. No CI run IDs, review IDs, or caveats about what the test does not prove.

```markdown
**[Pitfall|Recipe] <One-sentence imperative rule>**
- Why: <what broke, or the non-obvious constraint> (`<broken sha>` / #N)
- Fixed/verified in: `<sha>`
- Seen N× (YYYY-MM-DD, ...)
```

---

## Active Entries

**[Pitfall] Probes and scripts that run before package builds import workspace source, and their tests run without package `dist`.**
- Why: Windows infra ran before the protocol build; stale `dist` lacked a new export and `scripts/relay-contract-probe.mjs` failed with SyntaxError (`f6c33d0` / #61). `ci:local` prebuilding protocol `dist` hid the same class in #72.
- Fixed/verified in: `dc95633`, `b1df825`
- Seen 2× (2026-11-13, 2026-11-14)

**[Pitfall] Create new SQLite files (and their WAL/SHM) with mode `0600` before opening them.**
- Why: umask `022` created DB/WAL/SHM as `0644` beside a `0600` log (`57e0f19` / #52).
- Fixed/verified in: `f42a5a9` (`apps/desktop/src/controller/session-event-log.ts`)
- Seen 1× (2026-11-13)

**[Pitfall] Test fixtures close every file handle they opened (SQLite logs included) before recycling their temp directories.**
- Why: on Windows an open SQLite log makes the directory rename fail with EPERM and the recycle exit 124; Mac and Linux pass (`b9beccd` / #52).
- Fixed/verified in: `4686a8a` (`apps/desktop/src/evidence/evidence-manager.test.ts`)
- Seen 1× (2026-11-13)

**[Pitfall] Inject write failures with a mock; `chmod 0400` does not fail under root.**
- Why: WSL CI runs as uid 0 with `CAP_DAC_OVERRIDE` and appended to the `0400` file (`4686a8a` / #52).
- Fixed/verified in: `78003db`
- Seen 1× (2026-11-13)

**[Pitfall] Renaming Desktop Settings sections or diagnostic labels requires updating `scripts/packaged-desktop-qa.mjs` and `scripts/windows-native-qa-contract.test.mjs` in the same change.**
- Why: splitting `连接与设备` into `连接与启动` / `诊断与关于` broke packaged QA (`5f5c76f`).
- Fixed/verified in: `c6aa944`
- Seen 1× (2026-11-11)

**[Pitfall] Gating a client request on a new `host.capabilities` entry requires adding it to `createMockHost` in `scripts/browser-e2e.mjs`.**
- Why: `artifact.transfer.stat.v1` gating shipped without the mock capability and browser E2E broke (`75b170e`).
- Fixed/verified in: `79e5700`
- Seen 1× (2026-11-11)

**[Pitfall] Parsers of OS-specific output take the target platform as an argument instead of reading `process.platform`.**
- Why: `parseInspectorDesktopProcesses` parsed macOS `ps` output with the host platform and failed on Linux/Windows runners (`326dc80`).
- Fixed/verified in: `1251ddb`
- Seen 1× (2026-11-10)

**[Pitfall] When `ClaudeDesktopInspector` probes a new builtin module, stub it in the inspector `require(...)` sandbox of `scripts/service-restart-qa.mjs`.**
- Why: probing `module._cache` left the sandbox asserting `name === 'electron'`, breaking `test:desktop:service` (`978ec59`).
- Fixed/verified in: `0482dd3`
- Seen 1× (2026-11-11)

**[Recipe] Standalone Node QA gets the Electron binary from `electron`'s default export, never a reconstructed `dist` path.**
- Why: Electron 43 has no postinstall; its entry downloads the binary on first import, so a hand-built path fails with spawn ENOENT after a fresh `npm ci`.
- Fixed/verified in: `4098aaa` (`scripts/service-restart-qa.mjs`)
- Seen 1× (2026-11-13)
