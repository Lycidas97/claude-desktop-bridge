# Subsystem: Desktop Transcript & Context

## Owned Paths
- `apps/desktop/src/transcript/`
  - History & pagination: `claude-history.ts`
  - DAG parent-chain & fork boundaries: `transcript-dag.ts`
  - Passive turn evidence cursor: `transcript-evidence.ts`
  - Active-branch context token usage: `transcript-context.ts`
  - Subagent & workflow projection: `transcript-subagents.ts`

## Responsibilities
- Parses Claude JSONL transcripts and native `LocalSessions` transcript pages into normalized conversation items, tool executions, task plans, and subagent runs.
- Resolves transcript DAG parent chains and fork cutoffs (`transcript-dag.ts`) so forked sessions display inherited history up to the exact complete-turn fork boundary without leaking sibling branches.
- Computes active-branch main-session token context usage (`transcript-context.ts`) across `/compact` boundaries and rewinds.
- Scans subagent/background task transcripts (`transcript-subagents.ts`), extracting actual subagent response models, completion notifications, and live status.
- Maintains bounded module-level caches keyed by file metadata and watermarks.

## Critical Invariants
1. **No legacy history fallback**: Native sessions use Claude Desktop's native session IDs and transcript cursors directly. Never fall back to `SessionEventLog` (`events-v2.jsonl`) or pre-1.3 logical session files to backfill missing pages; if Desktop is unavailable, surface unavailability explicitly.
2. **Hidden internal blocks stay hidden**: Never project hidden `thinking` blocks, internal `/compact` summary payloads, or subagent internal sidechain plans into user-visible message streams (`verifyNativeBoundaries` in `scripts/browser-e2e.mjs` enforces this).
3. **Fork & background-task isolation (`fork-boundary.test.ts`)**: Inherited parent subagent runs must remain distinct from background tasks spawned by the child session's own generation, and child background tasks remain live after the main turn finishes.
4. **Honest context capacity**: `transcript-context.ts` synchronizes token watermarks across `/compact` and rewind, and omits total window capacity and percentage whenever a custom model's context window size is unknown rather than guessing a default limit.
5. **Cache invalidation**: Module-level transcript and subagent caches must key on file `mtimeMs`, byte size, and active leaf/fork watermarks so appended JSONL lines and rewinds reflect immediately.

## Minimum Verification
```bash
npm run ci:run -- test -w @bridge/desktop
npm run test:browser
```
