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
