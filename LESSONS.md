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
- Why: Windows infra ran before the protocol build; stale `dist` lacked a new export and `scripts/relay-contract-probe.mjs` failed with SyntaxError (#61). `ci:local` prebuilding protocol `dist` hid the same class in #72.
- Fixed/verified in: `dc95633`, `b1df825`
- Seen 2× (2026-11-13, 2026-11-14)

**[Pitfall] Test fixtures close every file handle they opened (SQLite logs included) before recycling their temp directories.**
- Why: on Windows an open SQLite log makes the directory rename fail with EPERM and the recycle exit 124; Mac and Linux pass (#52).
- Fixed/verified in: `f42a5a9` (`apps/desktop/src/evidence/evidence-manager.test.ts`)
- Seen 1× (2026-11-13)

**[Pitfall] Inject write failures with a mock; `chmod 0400` does not fail under root.**
- Why: WSL CI runs as uid 0 with `CAP_DAC_OVERRIDE` and appended to the `0400` file (#52).
- Fixed/verified in: `f42a5a9`
- Seen 1× (2026-11-13)

**[Recipe] Standalone Node QA gets the Electron binary from `electron`'s default export, never a reconstructed `dist` path.**
- Why: Electron 43 has no postinstall; its entry downloads the binary on first import, so a hand-built path fails with spawn ENOENT after a fresh `npm ci`.
- Fixed/verified in: `952deb3` (`scripts/service-restart-qa.mjs`)
- Seen 1× (2026-11-13)

**[Recipe] Verify a managed Desktop `agent` change by cold-starting the same bound session and comparing `system/init.tools`.**
- Why: On Desktop 5.11492.5 / Claude Code 2.1.325, the baseline with `permissions.allow` advertised 35 extra tools. Selecting an empty-body project agent via `.claude/settings.json` reduced that to 0, with all 8 mail/agenda tools present and the same Desktop and CLI session IDs. Keep `PreToolUse` for call enforcement (#418).
- Fixed/verified in: `f9fff4a` (`apps/desktop/src/controller/assistant-workspace.ts`)
- Seen 1× (2026-11-19)

**[Pitfall] After switching computers in browser E2E, wait for a session unique to the destination's live catalog before counting sessions.**
- Why: A generic title already matched the cached catalog, so `dark-incoming-file` counted 1 target before the live catalog showed both. Waiting for `审阅项目计划` made the original count assertion pass (`e3e771dd`, #424).
- Fixed/verified in: `970aa81` (browser fix `7ef04fe6`, `scripts/browser-e2e/scenarios/incoming-file.mjs`)
- Seen 1× (2026-11-19)
