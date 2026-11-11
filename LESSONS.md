# Lessons & Retro Log

## Retro Loop
Before cutting a release or during periodic maintenance retros, audit recent commits on `main` for:
1. **Rework or follow-up fixes** (`fix(ci)`, selector repair, missing fixture capability, revert).
2. **Changes that should not have merged** (speculative complexity, boundary violations, unrequested UX churn).
3. **Weak verification** (fixture-only claims for real OS/runtime surfaces, skipped Red checks).

Record every recurring or instructive failure below using this exact template:

```markdown
**<One-sentence imperative rule>**
- Broken in: `<commit/issue>` — <what went wrong>
- Fixed in: `<commit>`
- Done right: <concrete positive example>
- Seen N× (YYYY-MM-DD, ...)
```

**Promotion Rule**: When an entry reaches `Seen 3×` across **3 distinct calendar dates**, promote the rule into `docs/code-standards.md` (or the owning `docs/subsystems/*.md` invariant list) and move the entry under `## Promoted`.

---

## Active Lessons

**Update packaged Desktop QA selectors and contract tests whenever Desktop Settings section titles or diagnostic labels change.**
- Broken in: `5f5c76f` — reorganized Desktop Settings sections (`连接与设备` split into `连接与启动` and `诊断与关于`) without updating `scripts/packaged-desktop-qa.mjs` or `scripts/windows-native-qa-contract.test.mjs`, breaking packaged Desktop QA assertions.
- Fixed in: `c6aa944`
- Done right: `c6aa944` updated `scripts/packaged-desktop-qa.mjs` and `scripts/windows-native-qa-contract.test.mjs` in lockstep and verified with `npm run test:infra`.
- Seen 1× (2026-11-11)

**Declare new host capabilities in browser E2E synthetic fixtures when gating client requests on `host.capabilities`.**
- Broken in: `75b170e` — gated pre-preview file size metadata checks on `artifact.transfer.stat.v1` in `DesktopController` and `MediaPreviewProvider` without adding `"artifact.transfer.stat.v1"` to `createMockHost` in `scripts/browser-e2e.mjs`.
- Fixed in: `79e5700`
- Done right: `79e5700` added `"artifact.transfer.stat.v1"` to `createMockHost` in `scripts/browser-e2e.mjs` and asserted in `verifyNativeBoundaries` that `purpose: "stat"` precedes `purpose: "text-preview"`.
- Seen 1× (2026-11-11)

**Pass explicit target platform arguments to OS-specific output parsers instead of defaulting to `process.platform`.**
- Broken in: `326dc80` — `parseInspectorDesktopProcesses` parsed macOS `ps` output using `desktopAppPathCandidates(CLAUDE_DESKTOP_APP)` with implicit `process.platform`, causing unit tests to fail on Linux and Windows CI runners.
- Fixed in: `1251ddb`
- Done right: `1251ddb` passed explicit `"darwin"` to `desktopAppPathCandidates` in `parseInspectorDesktopProcesses` and parameterized `claude-inspector-startup.test.ts` across `["darwin", "linux", "win32"]`.
- Seen 1× (2026-11-10)

**Update synthetic Node inspector `require(...)` sandboxes in `scripts/service-restart-qa.mjs` whenever `ClaudeDesktopInspector` probes a new builtin module.**
- Broken in: `978ec59` — added `process.mainModule.require('module')._cache` section probing in `claude-desktop-inspector.ts` and updated `claude-desktop-inspector.test.ts`, but left `assert.equal(name, 'electron')` in `scripts/service-restart-qa.mjs`, breaking `test:desktop:service` session discovery.
- Fixed in: `0482dd3`
- Done right: `0482dd3` stubbed `if (name === 'module') return { _cache: {} }` in `scripts/service-restart-qa.mjs` and verified all 8 service lifecycle checkpoints pass via `npm run ci:run -- run test:desktop:service`.
- Seen 1× (2026-11-11)

---

## Promoted

_None yet._
