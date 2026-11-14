# Parallel Issue Workflow

How the Issue patrol session runs several Issues at once: dispatch, implement, review, CI, merge. A single Issue follows the same steps with one fork and one reviewer.

## Roles

- **Patrol**: the session the owner talks to. Dispatches, sets merge order, resolves conflicts and anything needing the owner, runs post-merge `main` CI and dogfood installs, and is the single writer for `LESSONS.md`, `docs/subsystems/*.md`, and shared memory. It does not relay review traffic and makes no code judgments.
- **Fork**: one implementing session per Issue, in its own worktree. Never reviews or merges its own PR. Talks to its reviewer directly.
- **Reviewer**: reviews every round of one PR (findings, NIT fix diffs, merge resolutions), sends verdicts straight to the fork, and merges when the objective conditions in step 6 hold. Never sees the patrol's analysis or the fork brief.
- **Reports to the owner** (any session): conclusion, decisions the owner must make, risks — in the owner's language. SHAs, PIDs, and timings stay in PRs and records.

## Review tiers

Chosen at dispatch from the files the Issue is expected to touch:

- **Light**: docs-only, or changes confined to test files and fixtures. One Light reviewer session per round (started at dispatch with the **Reviewer brief**) reviews and merges all of the round's Light PRs, one review per PR and SHA.
- **Paired**: everything else (production code under `apps/*/src`, `packages/*/src`, `plugins/`, `scripts/`, `.github/workflows/`, packaging, release). A reviewer session started with the fork. Architecture/UI PRs add the extra Opus reviewer.

If a Light PR grows into Paired scope, the Light reviewer tells the patrol, which starts a paired reviewer in the owner's next turn (host constraint below).

## Models and fallback

Pick models per role, not per task. Fallback is done by Magpie routing groups with `routing=order` (first member until it can't answer, then the next; requests return to the first once its quota renews), so no session or agent carries fallback logic. Gemini is used only through `antigravity/*`; never `gemini-web/*` or `google/models/*`.

| Role | Magpie group or model | Picker label |
| --- | --- | --- |
| Patrol | `group/bridge-runner`: DeepSeek Flash → GPT-6.1-Sol | `bridge-runner` |
| Fork, Reviewer (paired and Light), `LESSONS.md` consolidation | `codex/gpt-6.1-sol` | `GPT-6.1-Sol · Codex` |
| Extra reviewer for architecture/UI PRs | `auto/claude-opus-5-5` | `Claude Opus 5.5` |
| `plan-ideator` / `plan-reviewer` | `group/bridge-ideator`: Gemini 4 Carbon → GPT-6.1-Sol / `codex/gpt-6.1-sol` | `bridge-ideator` / `GPT-6.1-Sol · Codex` |
| Drafting Issue bodies, PR descriptions, docs | `group/bridge-docs`: Gemini 4 Hydrogen → Opus 5.5 (antigravity, then Claude Code) → DeepSeek Flash | `bridge-docs` |
| Hard bugs | `codex/gpt-6-astra` | `GPT-6-Astra · Codex` |
| Scheduled tech-debt patrol (`bridge-tech-debt-patrol`: Dreaming + rot scan) | `codex/gpt-6.1-sol`, no subagents: rot is judged by the task itself after command pre-filtering, since a weaker scanner's misses cannot be caught by review | `GPT-6.1-Sol · Codex` |

- `set_session_model`, agent frontmatter, and scheduled-task frontmatter take a picker id (`provider/model` ids are rejected there). Picker ids are generated per machine by Claude Desktop and change, so they are never written down: resolve one from its label with `node scripts/picker-id.mjs <label>` right before use. It reads Claude Desktop's `configLibrary` (macOS `~/Library/Application Support/Claude-3p/configLibrary`, Windows `%LOCALAPPDATA%\Claude-3p\configLibrary`, override with `CLAUDE_CONFIG_LIBRARY`) and fails when the label is missing or ambiguous.
- A group added in Magpie shows up in `configLibrary` at once, but the running Claude Desktop keeps its old list until restarted: until then `set_session_model` rejects the id, and agent frontmatter naming it silently runs on the `sonnet` default. Magpie's `usage.jsonl` (`req` field) shows which model actually answered.
- Set up the groups once per machine (the label is the group name, so keep these names):
  ```bash
  magpie group add bridge-runner models=deepseek/deepseek-flash,codex/gpt-6.1-sol routing=order
  magpie group add bridge-ideator models=antigravity/gemini-4-carbon,codex/gpt-6.1-sol routing=order
  magpie group add bridge-docs models=antigravity/gemini-4-hydrogen,antigravity/claude-opus-5-5,claude/claude-opus-5-5,deepseek/deepseek-flash routing=order
  ```
- No quota check before dispatching: the groups route around exhausted members. Sol (a single model, no group) keeps running on Codex credits once its 7-day window is used up; when a Sol session reports a quota error (patrol checklist), the patrol stops dispatching and asks the owner before a reset credit is spent.
- Escalate to Astra when the same defect survives two fix rounds, or `ci:local` fails twice in a row for the same cause.
- Sessions keep one model for their whole life; nobody switches a fork's model to run `ci:local` (it is a background command that costs almost nothing while it runs).
- DeepSeek runs fixed procedures with an objective check (`ci/local-distributed`, `gh` state). It never writes tests or fixes code; its own summaries are not evidence.

## Host constraints this workflow is built around

- `start_session` is refused in turns triggered by another session's message or an automated event (`/loop`, task notifications). Every fork **and** reviewer must be started in a turn the owner's own message started.
- A session's completion note reaches the patrol only after **all** linked sessions are idle. With many forks running, the patrol is never woken by notes; status travels only by explicit `SendMessage` with `to` set to the target's `local_…` session id (this is what every `SendMessage` below means).
- `mcp__ccd_pr__set_monitor` is refused for PRs opened with `gh pr create` from a fork. Try it; if refused, do not work around it. Fixes are relayed by `SendMessage`.

## Host constraints this workflow is built around

- `start_session` is refused in turns triggered by another session's message or an automated event (`/loop`, task notifications). Every fork **and** paired reviewer must be started in a turn the owner's own message started.
- A session's completion note reaches the patrol only after **all** linked sessions are idle. With many forks running, the patrol is never woken by notes; status travels only by explicit `SendMessage` with `to` set to the target's `local_…` session id (this is what every `SendMessage` below means).
- `mcp__ccd_pr__set_monitor` is refused for PRs opened with `gh pr create` from a fork. Try it; if refused, do not work around it. Fixes are relayed by `SendMessage`.

## 1. Dispatch (owner's turn)

1. For each Issue, list the files it is expected to touch and pick its review tier. Issues that overlap get an explicit merge order; record it in each affected brief. CI or tooling PRs never gate feature PRs: features merge on the CI that works today, and infrastructure improvements proceed in parallel.
2. Start each Paired PR's reviewer, plus one Light reviewer if the round has Light PRs (`start_session`, `use_worktree: false`, **Reviewer brief**), then switch them to GPT-6.1-Sol.
3. Start the fork (`start_session`, `use_worktree: true`, **Fork brief** with its reviewer's `local_…` id), then switch it to GPT-6.1-Sol (picker id from `node scripts/picker-id.mjs "GPT-6.1-Sol · Codex"`).
4. Start the patrol checklist (step 8).

## 2. Implement (fork)

- Run only `npm run typecheck` and the tests related to the changed files (`vitest related --run <files>` in the touched workspace), plus `npm run test:browser` when client UI changed. Full suites run once inside `ci:local`; do **not** run them, or `ci:local`, yet.
- A failure already observed in a CI log or a user report is the Red Check; do not rebuild it in an isolated checkout.
- Do not write acceptance files under `output/`; the PR body carries the checklist, commands, and links.
- Do not hand-roll port or CI wait loops and do not write `RUNNING` markers to shared notes. Mac browser E2E uses random ports and the Windows script queues itself.
- Open the PR (`Fixes #N`, template filled; under `## Not Run` list `ci:local — pending review`, or `ci:local — docs only` for docs-only PRs) and try `set_monitor`.

## 3. Report (fork → reviewer)

The fork sends `SendMessage` to its reviewer, never relying on completion notes:

- `READY #<pr> <head-sha>` + checks run / not run
- `HEAD CHANGED #<pr> <old-sha> → <new-sha>` + why
- `CI GREEN #<pr> <sha>` / `CI FAILED #<pr> <sha>` + cause
- `BLOCKED <reason>` goes to the patrol.

From `READY` the head is frozen except for requested fixes, syncs, or conflict resolution.

## 4. Review (reviewer)

1. The reviewer reads the Issue, the diff at that SHA, and the routed `docs/subsystems/*.md`, `docs/code-standards.md`, `LESSONS.md`, then posts **one** review bound to the SHA:
   ```bash
   gh api repos/Lycidas97/claude-desktop-bridge/pulls/<n>/reviews --input - <<'JSON'
   {"commit_id": "<sha>", "event": "COMMENT", "body": "<verdict + findings on lines outside the diff>",
    "comments": [{"path": "<file>", "line": <line>, "side": "RIGHT", "body": "[BLOCKER] ..."}]}
   JSON
   ```
2. It replies to the fork: `REVIEWED #<n> <sha>: CLEAN — run ci:local` or `REVIEWED #<n> <sha>: <k> BLOCKER, <m> NIT — fix`. Candidate lessons (`0–2`) go to the patrol.
3. Later rounds: a `[BLOCKER]` round re-reviews the new head in full; a NIT-only round checks only `git diff <reviewed-sha>..<new-head-sha>` and replies `NIT FIX OK #<n> <new-sha> — run ci:local` (the new head becomes the reviewed SHA) or posts a `[BLOCKER]` review.

## 5. CI (fork, after review converges)

- On `run ci:local` the fork runs `npm run ci:local` on the reviewed SHA as a background command, without switching models, then edits the PR body (reviewed SHA, `ci:local` box checked, `pending review` line removed) and reports `CI GREEN` or `CI FAILED`.
- Docs-only PRs skip this step.
- A CI failure that needs a code change is a `[BLOCKER]` round: the fork fixes, reports `HEAD CHANGED`, the reviewer re-reviews, then CI re-runs.

## 6. Merge (reviewer)

1. Merge when all hold: the last verdict on SHA `X` is CLEAN / `NIT FIX OK` / `MERGE OK`; `gh api repos/Lycidas97/claude-desktop-bridge/commits/X/statuses` shows `ci/local-distributed = success` (not needed for docs-only; not re-run after a sync unless the PR touches `.github/workflows/`, `scripts/`, packaging, or release files); every PR listed before it in the brief's merge order is merged. Then:
   `gh pr merge <n> --repo Lycidas97/claude-desktop-bridge --squash --match-head-commit X`
   and `SendMessage` the patrol `MERGED #<n> X`. If a predecessor is not merged yet, wait; ask the patrol only if the order itself is in doubt.
2. The reviewer never trusts the fork's CI report alone and does not re-audit CI logs.

## 7. After merge (patrol)

1. On `MERGED`, sync local `main`; unless docs-only, run `npm run ci:local -- --publish` when `HEAD^{tree}` matches the verified head (otherwise skip; see `AGENTS.md` Bug fixes step 4).
2. Tell only forks whose files overlap the merged PR to sync (`mcp__ccd_host__sync_with_base_branch`), push, run `npm run typecheck` + related tests, and report `HEAD CHANGED` to their reviewer. The reviewer inspects only the merge resolution (`git show --remerge-diff <new-head-sha>`; empty for a clean merge) and replies `MERGE OK #<n> <sha>` or posts a `[BLOCKER]` review; on `MERGE OK` the new head becomes the reviewed SHA. Non-overlapping PRs keep their CI status.
3. After each batch of merges, run `npm run ci:local` on the new `main` head. A failure is fixed forward or reverted before the next merge. Then install the dogfood build (`docs/dogfood.md`).
4. After the round, a GPT-6.1-Sol session (a fork or reviewer still open, or a new one) consolidates the candidate lessons into `LESSONS.md` as the single writer for that round.

## 8. Patrol checklist

During a round the patrol runs `/loop 20m` with this read-only check and stops it when the round ends:

- `mcp__ccd_session_mgmt__list_sessions {"linked": true}`: sessions stopped, errored, or showing a quota/API error in `list_events`.
- Open PRs of the round with no new commit, review, or status for 60 minutes (`gh pr list --json number,updatedAt`).

Silent when nothing is wrong; otherwise it tells the owner and may `SendMessage` the affected session. It never starts sessions, switches models, or merges.

## Templates

### Fork brief

```text
Implement Issue #<N> (<link>) in this worktree.
Paths: <subsystem paths from AGENTS.md>. Overlaps: <Issue/PR and files> — merge order: <first → last>.
Environment: <e.g. CHROME_PATH=..., Playwright cache>.
Local checks: typecheck + vitest related --run <changed files> (+ test:browser for client UI). No full suites, no output/ acceptance files.
Report to your reviewer (<reviewer session id>) via SendMessage: READY #<pr> <sha> / HEAD CHANGED #<pr> <old> → <new> / CI GREEN|CI FAILED #<pr> <sha>.
Run ci:local (background, no model switch) only when the reviewer says "run ci:local". BLOCKED <reason> goes to the patrol (<patrol session id>).
Freeze the head after READY except for requested fixes and syncs.
LESSONS.md, docs/subsystems/*.md, and shared memory are read-only; send 0–2 verified candidate lessons to the patrol.
```

### Reviewer brief

```text
You are the independent reviewer for Issue(s) <#N, ...> (merge order: <...>). Do nothing until a fork sends "READY #<n> <sha>".
For each READY or HEAD CHANGED: read the Issue, the diff at that SHA, AGENTS.md, the routed docs/subsystems/*.md,
docs/code-standards.md and LESSONS.md. Post one PR review bound to the SHA (gh api .../pulls/<n>/reviews,
commit_id=<sha>, payload via --input - heredoc, line comments marked [BLOCKER] or [NIT], off-diff findings in the body). Flag only defects with
a concrete trigger; no speculative defense or scope expansion. Reply to the fork (the from= address):
"REVIEWED #<n> <sha>: CLEAN — run ci:local" or "... <k> BLOCKER, <m> NIT — fix". After a NIT-only round check only
git diff <reviewed>..<new>; after a sync check only git show --remerge-diff <sha> ("MERGE OK #<n> <sha>").
Merge per docs/parallel-workflow.md step 6 (verified ci/local-distributed via gh api, predecessors merged,
--match-head-commit), then SendMessage the patrol (<patrol session id>) "MERGED #<n> <sha>" plus 0–2 verified candidate lessons.
Otherwise read-only: never edit files or push.
```
