# Parallel Issue Workflow

How the Issue patrol session runs several Issues at once: dispatch, implement, review, CI, merge. A single Issue follows the same steps with one fork and one reviewer.

## Roles

- **Patrol**: the session the owner talks to. Plans, dispatches, relays, merges, and is the single writer for `LESSONS.md`, `docs/subsystems/*.md`, and shared memory.
- **Fork**: one implementing session per Issue, in its own worktree. Never reviews or merges its own PR.
- **Reviewer**: one review session paired with each fork, for every review round of that PR. Never sees the patrol's analysis or the fork brief.

## Host constraints this workflow is built around

- `start_session` is refused in turns triggered by another session's message or an automated event (`/loop`, task notifications). Every fork **and** reviewer must be started in a turn the owner's own message started.
- A session's completion note reaches the patrol only after **all** linked sessions are idle. With many forks running, the patrol is never woken by notes; status travels only by explicit `SendMessage`.
- `mcp__ccd_pr__set_monitor` is refused for PRs opened with `gh pr create` from a fork. Try it; if refused, do not work around it. Fixes are relayed by `SendMessage`.

## 1. Dispatch (owner's turn)

1. For each Issue, list the files it is expected to touch. Issues that overlap get an explicit merge order; record it in each affected brief.
2. Start the fork (`start_session`, `use_worktree: true`) with the **Fork brief** below.
3. In the same turn, start its reviewer (`start_session`, `use_worktree: false`) with the **Reviewer brief** below, then switch it to GPT-6.1-Sol with `mcp__ccd_session_mgmt__set_session_model` while it waits. Pass the picker id (`mythos-magpie-9189869295` as of 2026-11-12; `codex/gpt-6.1-sol` is rejected). An unknown id returns the valid list.
4. Start the patrol checklist (step 8).

## 2. Implement (fork)

- Run only local checks: the subsystem's minimum verification from `AGENTS.md`, `typecheck`, and `npm run test:browser` when the client is touched. Do **not** run `ci:local` yet.
- Do not hand-roll port or CI wait loops and do not write `RUNNING` markers to shared notes. Mac browser E2E uses random ports and the Windows script queues itself.
- Open the PR (`Fixes #N`, template filled; `ci:local — pending review` under `## Not Run`) and try `set_monitor`.

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

- The patrol tells the fork: `Review on #<n> @ <sha> posted; fix it`. The fork reads the review via `gh api`, pushes fixes, and reports `HEAD CHANGED`.
- Round had a `[BLOCKER]`: the patrol sends the same reviewer the new SHA (back to step 4).
- NIT-only round: the patrol checks only `git diff <reviewed-sha>..<new-head-sha>`; the new head becomes the reviewed SHA.
- CLEAN round: the step 4 SHA is the reviewed SHA.

## 6. CI (fork, after review converges)

- The patrol tells the fork to run `npm run ci:local` on the reviewed SHA. The fork reports the exit code, SHA, and `ci/local-distributed` status.
- Docs-only PRs skip this step (see `AGENTS.md` **PR review & merge**).
- A CI failure that needs a code change sends the PR back to step 5 as a `[BLOCKER]` round (the reviewer re-reviews the fix head), then step 6 re-runs.

## 7. Merge (patrol)

1. Merge in the planned order: `gh pr merge <n> --repo Lycidas97/claude-desktop-bridge --squash --match-head-commit <reviewed-sha>`.
2. Tell only forks whose files overlap the merged PR to sync (`mcp__ccd_host__sync_with_base_branch`), push, and report `HEAD CHANGED`. The patrol inspects only the merge resolution (`git show --remerge-diff <new-head-sha>`; empty for a clean merge), the new head becomes the reviewed SHA, and the fork re-runs step 6. Non-overlapping PRs keep their CI status.
3. Consolidate candidate lessons from forks and reviewers.

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
Report to the patrol (<patrol session id>) via SendMessage: READY #<pr> <sha> / BLOCKED <reason> / HEAD CHANGED <old> → <new>.
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
"REVIEWED #<n> <sha>: CLEAN | <k> BLOCKER, <m> NIT" plus 0–2 verified candidate lessons. Read-only otherwise:
never edit files, push, or merge.
```
