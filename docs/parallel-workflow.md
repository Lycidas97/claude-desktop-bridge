# Parallel Issue Workflow

How the Issue patrol session runs several Issues at once: dispatch, implement, review, CI, merge. A single Issue follows the same steps with one fork and one reviewer.

## Roles

- **Patrol**: the session the owner talks to. Dispatches, relays, checks status, merges on the conditions below, and is the single writer for `LESSONS.md`, `docs/subsystems/*.md`, and shared memory. It makes no code judgments: diff and merge-resolution checks go to the PR's reviewer.
- **Fork**: one implementing session per Issue, in its own worktree. Never reviews or merges its own PR.
- **Reviewer**: one review session paired with each fork, for every review round of that PR, including NIT fix diffs and merge resolutions. Never sees the patrol's analysis or the fork brief.

## Models and fallback

Pick models per role, not per task. Fallback is done by Magpie routing groups with `routing=order` (first member until it can't answer, then the next; requests return to the first once its quota renews), so no session or agent carries fallback logic. Gemini is used only through `antigravity/*`; never `gemini-web/*` or `google/models/*`.

| Role | Magpie group or model | Picker label |
| --- | --- | --- |
| Patrol, `ci:local` runs | `group/bridge-runner`: DeepSeek Flash → GPT-6.1-Sol | `bridge-runner` |
| Fork, Reviewer, `LESSONS.md` consolidation | `codex/gpt-6.1-sol` | `GPT-6.1-Sol · Codex` |
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
- DeepSeek runs fixed procedures with an objective check (`ci/local-distributed`, `gh` state). It never writes tests or fixes code; its own summaries are not evidence.

## Host constraints this workflow is built around

- `start_session` is refused in turns triggered by another session's message or an automated event (`/loop`, task notifications). Every fork **and** reviewer must be started in a turn the owner's own message started.
- A session's completion note reaches the patrol only after **all** linked sessions are idle. With many forks running, the patrol is never woken by notes; status travels only by explicit `SendMessage` with `to` set to the target's `local_…` session id (this is what every `SendMessage` below means).
- `mcp__ccd_pr__set_monitor` is refused for PRs opened with `gh pr create` from a fork. Try it; if refused, do not work around it. Fixes are relayed by `SendMessage`.

## 1. Dispatch (owner's turn)

1. For each Issue, list the files it is expected to touch. Issues that overlap get an explicit merge order; record it in each affected brief.
2. Start the fork (`start_session`, `use_worktree: true`) with the **Fork brief** below, then switch it to GPT-6.1-Sol with `mcp__ccd_session_mgmt__set_session_model` (picker id from `node scripts/picker-id.mjs "GPT-6.1-Sol · Codex"`).
3. In the same turn, start its reviewer (`start_session`, `use_worktree: false`) with the **Reviewer brief** below, then switch it to GPT-6.1-Sol while it waits.
4. Start the patrol checklist (step 8).

## 2. Implement (fork)

- Run only local checks: the subsystem's minimum verification from `AGENTS.md`, `typecheck`, and `npm run test:browser` when the client is touched. Do **not** run `ci:local` yet.
- Do not hand-roll port or CI wait loops and do not write `RUNNING` markers to shared notes. Mac browser E2E uses random ports and the Windows script queues itself.
- Open the PR (`Fixes #N`, template filled; under `## Not Run` list `ci:local — pending review`, or `ci:local — docs only` for docs-only PRs) and try `set_monitor`.

## 3. Report (fork → patrol)

The fork sends `SendMessage` to the patrol, never relying on completion notes, on each of:

- `READY #<pr> <head-sha>` + checks run / not run
- `BLOCKED <reason>` + who must act
- `HEAD CHANGED #<pr> <old-sha> → <new-sha>` + why

From `READY` until told otherwise, the head is frozen: no pushes except requested fixes, syncs, or conflict resolution.

## 4. Review (reviewer)

1. The patrol sends the reviewer only `PR #<n>, head <sha>`. No suspected problem areas, no fork brief.
2. The reviewer reads the Issue, the diff at that SHA, and the routed `docs/subsystems/*.md`, `docs/code-standards.md`, `LESSONS.md`, then posts **one** review bound to the SHA:
   ```bash
   gh api repos/Lycidas97/claude-desktop-bridge/pulls/<n>/reviews --input - <<'JSON'
   {"commit_id": "<sha>", "event": "COMMENT", "body": "<verdict + findings on lines outside the diff>",
    "comments": [{"path": "<file>", "line": <line>, "side": "RIGHT", "body": "[BLOCKER] ..."}]}
   JSON
   ```
3. It sends the patrol: `REVIEWED #<n> <sha>: CLEAN | <k> BLOCKER, <m> NIT` plus `0–2` verified candidate lessons. It stays idle for later rounds.

## 5. Fix (patrol → fork)

- CLEAN round: skip to step 6; the step 4 SHA is the reviewed SHA.
- Round had findings: the patrol tells the fork `Review on #<n> @ <sha> posted; fix it`. The fork reads the review via `gh api`, pushes fixes, and reports `HEAD CHANGED`.
- Round had a `[BLOCKER]`: the patrol sends the same reviewer the new SHA (back to step 4).
- NIT-only round: the patrol sends the same reviewer `NIT FIX #<n> <reviewed-sha>..<new-head-sha>`. The reviewer checks only that diff and replies `NIT FIX OK #<n> <new-head-sha>` (the new head becomes the reviewed SHA) or posts a `[BLOCKER]` review (back to step 4).

## 6. CI (fork, after review converges)

- The patrol switches the fork to `group/bridge-runner` (`set_session_model`), then tells it to run `npm run ci:local` on the reviewed SHA. The fork reports the exit code, SHA, and `ci/local-distributed` status, then edits the PR body: the reviewed SHA under `## Reviewed / Verified Commit SHA`, the `ci:local` box checked, and the `pending review` line removed. The patrol verifies the status with `gh api repos/Lycidas97/claude-desktop-bridge/commits/<sha>/statuses`, not from the report, then switches the fork back to GPT-6.1-Sol.
- Docs-only PRs skip this step (see `AGENTS.md` **PR review & merge**).
- A CI failure that needs a code change sends the PR back to step 5 as a `[BLOCKER]` round (the fork, back on GPT-6.1-Sol, fixes it; the reviewer re-reviews the fix head), then step 6 re-runs.

## 7. Merge (patrol)

1. Merge in the planned order: `gh pr merge <n> --repo Lycidas97/claude-desktop-bridge --squash --match-head-commit <reviewed-sha>`. Then sync local `main` and, unless the PR was docs-only, run `npm run ci:local -- --publish` when `HEAD^{tree}` matches the verified head (otherwise skip; see `AGENTS.md` Bug fixes step 4).
2. Tell only forks whose files overlap the merged PR to sync (`mcp__ccd_host__sync_with_base_branch`), push, and report `HEAD CHANGED`. The patrol sends that PR's reviewer `MERGE CHECK #<n> <new-head-sha>`; the reviewer inspects only the merge resolution (the host sync merges or fast-forwards, never rebases, so `git show --remerge-diff <new-head-sha>` shows only the resolution; empty for a clean merge) and replies `MERGE OK` or posts a `[BLOCKER]` review. On `MERGE OK` the new head becomes the reviewed SHA and the fork re-runs step 6. Non-overlapping PRs keep their CI status.
3. After the round's merges, a GPT-6.1-Sol session (a fork or reviewer still open, or a new one) consolidates the candidate lessons from forks and reviewers into `LESSONS.md` as the single writer for that round.

## 8. Patrol checklist

During a round the patrol runs `/loop 20m` with this read-only check and stops it when the round ends:

- `mcp__ccd_session_mgmt__list_sessions {"linked": true}`: sessions stopped, errored, or showing a quota/API error in `list_events`.
- Forks or reviewers with no report for 20 minutes while work is pending.
- PR heads (`gh pr list --json number,headRefOid`) that changed without a `HEAD CHANGED` report.

Silent when nothing is wrong; otherwise it tells the owner and may `SendMessage` the affected session. It never starts sessions, switches models, or merges.

## Templates

### Fork brief

```text
Implement Issue #<N> (<link>) in this worktree.
Paths: <subsystem paths from AGENTS.md>. Overlaps: <Issue/PR and files> — merge order: <first → last>.
Environment: <e.g. CHROME_PATH=..., Playwright cache>.
Local checks: <minimum verification from AGENTS.md>. Do not run ci:local until the patrol says so.
Report to the patrol (<patrol session id>) via SendMessage: READY #<pr> <sha> / BLOCKED <reason> / HEAD CHANGED #<pr> <old> → <new>.
Freeze the head after READY except for requested fixes and syncs.
LESSONS.md, docs/subsystems/*.md, and shared memory are read-only; put 0–2 verified candidate lessons in your READY report.
```

### Reviewer brief

```text
You are the independent reviewer for Issue #<N>. Do nothing now; wait for a message "PR #<n>, head <sha>".
For each such message: read the Issue, the diff at that SHA, AGENTS.md, the routed docs/subsystems/*.md,
docs/code-standards.md and LESSONS.md. Post one PR review bound to the SHA (gh api .../pulls/<n>/reviews,
commit_id=<sha>, payload via --input - heredoc, line comments marked [BLOCKER] or [NIT], off-diff findings in the body). Flag only defects with
a concrete trigger; no speculative defense or scope expansion. Then SendMessage the patrol (<patrol session id>):
"REVIEWED #<n> <sha>: CLEAN | <k> BLOCKER, <m> NIT" plus 0–2 verified candidate lessons. Also answer
"NIT FIX #<n> <old>..<new>" (check only that diff; reply "NIT FIX OK #<n> <new>" or post a [BLOCKER] review) and
"MERGE CHECK #<n> <sha>" (check only git show --remerge-diff <sha>; reply "MERGE OK #<n> <sha>" or post a [BLOCKER] review).
Read-only otherwise: never edit files, push, or merge.
```
