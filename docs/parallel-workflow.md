# Parallel Issue Workflow

How the patrol runs Issues through dispatch, implementation, review, CI, and merge. Each Issue gets one fork and one reviewer; several Issues run side by side.

## Roles

- **Patrol**: the session the owner talks to. Dispatches, sets merge order, resolves conflicts and owner decisions. After merges it runs `main` CI and the dogfood install, and it is the single writer of `LESSONS.md`, `docs/subsystems/*.md`, and shared memory. It makes no code judgments and does not relay review traffic.
- **Fork**: implements one Issue in its own worktree. Never reviews or merges its own PR.
- **Reviewer**: reviews every round of its PRs and merges them (**Merge**). It sees only the PR number and SHA, never the patrol's analysis or the fork brief, and otherwise stays read-only.
- **Discussion**: a session for retros and process work. It may own docs-only PRs. Anything else it finds becomes an Issue for the patrol; it does not implement, run CI, or coordinate reviewers.

Reports to the owner give the conclusion, the decisions the owner must make, and the risks, in the owner's language. SHAs and timings stay in PRs.

## Review tiers

- **Light**: docs-only (every path matches the `NON_DOC` exclusion in `.github/workflows/ci.yml`), or tests and fixtures only. One reviewer session per round handles all Light PRs.
- **Paired**: everything else. A reviewer session is started with the fork. Architecture and UI PRs also get the Opus reviewer.

A Light reviewer whose PR grows into Paired scope tells the patrol.

## Models

| Role | Magpie group or model | Picker label |
| --- | --- | --- |
| Patrol | `group/bridge-runner`: DeepSeek Flash → GPT-6.1-Sol | `bridge-runner` |
| Fork, reviewer, `LESSONS.md` consolidation, scheduled `bridge-tech-debt-patrol` (no subagents: a weaker scanner's misses cannot be caught by review) | `codex/gpt-6.1-sol` | `GPT-6.1-Sol · Codex` |
| Extra reviewer for architecture/UI PRs | `auto/claude-opus-5-5` | `Claude Opus 5.5` |
| `plan-ideator` / `plan-reviewer` | `group/bridge-ideator`: Gemini 4 Carbon → GPT-6.1-Sol / `codex/gpt-6.1-sol` | `bridge-ideator` / `GPT-6.1-Sol · Codex` |
| Drafting Issue bodies, PR descriptions, docs | `group/bridge-docs`: Gemini 4 Hydrogen → Opus 5.5 → DeepSeek Flash | `bridge-docs` |
| Hard bugs | `codex/gpt-6-astra` | `GPT-6-Astra · Codex` |

- Fallback lives in Magpie groups with `routing=order`, so sessions carry no fallback logic. Gemini only via `antigravity/*`. One-time setup per machine (the group name is the label):
  ```bash
  magpie group add bridge-runner models=deepseek/deepseek-flash,codex/gpt-6.1-sol routing=order
  magpie group add bridge-ideator models=antigravity/gemini-4-carbon,codex/gpt-6.1-sol routing=order
  magpie group add bridge-docs models=antigravity/gemini-4-hydrogen,antigravity/claude-opus-5-5,claude/claude-opus-5-5,deepseek/deepseek-flash routing=order
  ```
- `set_session_model` and frontmatter take a picker id. Resolve it right before use with `node scripts/picker-id.mjs "<label>"`; never write ids down. A new group needs a Claude Desktop restart before its id works.
- A session keeps one model for life. `set_session_model` applies only from the session's next turn (see **Dispatch**).
- Escalate to Astra when a defect survives two fix rounds or `ci:local` fails twice for the same cause.
- DeepSeek only runs procedures with an objective check (`gh` state, `ci/local-distributed`); it never writes code or tests.
- When a Sol session reports a quota error, the patrol stops dispatching and asks the owner.

## Host constraints

- `start_session` works only in a turn the owner's own message started, never in one triggered by a peer message, `/loop`, or a task notification.
- Completion notes reach the patrol only once all linked sessions are idle, so status travels by `SendMessage` to the target's `local_…` id.
- `set_monitor` may be refused for PRs a fork opened. If it is, do not work around it.

## Messages

Every status change is an explicit `SendMessage`:

| Message | From → to |
| --- | --- |
| `READY #<n> <sha>` + checks run / not run. The head is frozen from here except for fixes and syncs. | fork → reviewer |
| `HEAD CHANGED #<n> <old> → <new>` + why | fork → reviewer |
| `REVIEWED #<n> <sha>: CLEAN — run ci:local` or `…: <k> BLOCKER, <m> NIT — fix` | reviewer → fork |
| `NIT FIX OK #<n> <sha>` / `MERGE OK #<n> <sha>`: that SHA becomes the reviewed SHA | reviewer → fork |
| `CI GREEN #<n> <sha>` / `CI FAILED #<n> <sha>` + cause | fork → reviewer |
| `MERGED #<n> <sha>` + 0–2 verified candidate lessons | reviewer → patrol |
| `BLOCKED <reason>` | any → patrol |
| `TAKEN OVER <PRs>` | new owner → old owner |

**Handoff**: when PRs move to another session, the receiver confirms with `TAKEN OVER` and reroutes the reviewers itself. Until then the old owner only forwards what it receives.

## Dispatch (owner's turn)

1. For each Issue, list the files it should touch, pick its tier, and set a merge order for overlapping Issues. CI and tooling PRs never gate feature PRs.
2. Start the reviewers (`use_worktree: false`, **Reviewer brief**), then switch them to Sol. Their brief idles until `READY`.
3. Start each fork with only `Reply "waiting" until the task message arrives.` (`use_worktree: true`), switch it to Sol, then `SendMessage` it the **Fork brief**. A brief passed to `start_session` would run its whole first turn on the patrol's model.
4. Start the patrol checklist.

## Implement (fork)

- Before review run only `npm run typecheck` and `vitest related --run <changed files>`, plus `npm run test:browser` if client UI changed. A failure already seen in CI or reported by the owner is the Red Check.
- Evidence goes in the PR body, not in `output/`. Mac E2E ports are random and Windows CI queues itself, so write no wait loops or markers.
- Open the PR with `Fixes #N` and `ci:local — pending review` (or `— docs only`) under `## Not Run`, try `set_monitor`, then send `READY`.

## Review (reviewer)

Read the Issue, the diff at the SHA, the routed `docs/subsystems/*.md`, `docs/code-standards.md`, and `LESSONS.md`. Post one review bound to the SHA:

```bash
gh api repos/Lycidas97/claude-desktop-bridge/pulls/<n>/reviews --input - <<'JSON'
{"commit_id": "<sha>", "event": "COMMENT", "body": "<verdict + off-diff findings>",
 "comments": [{"path": "<file>", "line": <line>, "side": "RIGHT", "body": "[BLOCKER] ..."}]}
JSON
```

Flag only defects with a concrete trigger. After a `[BLOCKER]` round, re-review the whole new head. After a NIT-only round, check only `git diff <reviewed>..<new>`. After a sync, check only `git show --remerge-diff <new>`.

## CI (fork)

- On `run ci:local`, run `npm run ci:local` on the reviewed SHA as a background command, update the PR body, and report the result. Docs-only PRs skip this.
- A failure that needs a code change is a `[BLOCKER]` round. Rerun an unchanged head at most once; a second failure with the same cause goes to Astra for diagnosis instead of a third run.

## Merge (reviewer)

Merge SHA `X` when all of these hold:
- the last verdict on `X` is CLEAN, `NIT FIX OK`, or `MERGE OK`;
- `gh api repos/Lycidas97/claude-desktop-bridge/commits/X/statuses` shows `ci/local-distributed = success`, checked yourself rather than taken from the fork's report (not needed for docs-only);
- every earlier PR in the merge order is merged.

Then run:

```bash
gh pr merge <n> --repo Lycidas97/claude-desktop-bridge --squash --match-head-commit X
```

and send `MERGED`.

## After merge (patrol)

1. Sync `main`. Unless docs-only, run `npm run ci:local -- --publish` when `HEAD^{tree}` matches the verified head.
2. Only forks whose files overlap the merged PR sync (`sync_with_base_branch`), run typecheck and related tests, and send `HEAD CHANGED`. A synced head merges on `MERGE OK` without rerunning `ci:local`, unless the PR touches `.github/workflows/`, `scripts/`, packaging, or release files.
3. After each batch, run `npm run ci:local` on `main`; fix forward or revert before the next merge. Then install the dogfood build (`docs/dogfood.md`).
4. After the round, a Sol session consolidates the candidate lessons into `LESSONS.md`.

## Patrol checklist

During a round, run `/loop 20m` read-only. It reports linked sessions that are stopped, errored, or out of quota (`list_sessions {"linked": true}`, `list_events`), and the round's PRs with no activity for 60 minutes. It stays silent when nothing is wrong. It never starts sessions, switches models, or merges.

## Briefs

### Fork brief

```text
You are the fork for Issue #<N> (<link>). Follow docs/parallel-workflow.md as the Fork.
Paths: <subsystem paths>. Overlaps: <PRs/files>; merge order: <first → last>. Environment: <CHROME_PATH, ...>.
Reviewer: <reviewer session id>. Patrol: <patrol session id>.
LESSONS.md, docs/subsystems/*.md, and shared memory are read-only.
```

### Reviewer brief

```text
You are the reviewer for <#N, ...> (merge order: <...>). Follow docs/parallel-workflow.md as the Reviewer.
Do nothing until a fork sends READY. Patrol: <patrol session id>. Never edit files or push.
```
