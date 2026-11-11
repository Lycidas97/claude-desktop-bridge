# Subsystem: Desktop Evidence & Artifact Previews

## Owned Paths
- `apps/desktop/src/evidence/`
  - Lifecycle & attribution: `evidence-manager.ts`
  - Encrypted blob & manifest store: `evidence-store.ts`
  - Git & filesystem diffing: `workspace-evidence.ts`
  - Sandboxed image/HTML previews: `artifact-preview.ts`
  - Chunked workspace uploads: `file-upload.ts`

## Responsibilities
- Passively tracks native turn lifecycles, tool inputs/results, and workspace git/filesystem changes to build per-turn `BridgeTurnEvidence` manifests (`evidence-manager.ts`, `workspace-evidence.ts`).
- Stores evidence manifests in SQLite WAL and encrypts previewable/downloadable file snapshots as content-addressed AES-256-GCM blobs on disk with 30-day / 1 GiB LRU retention (`evidence-store.ts`).
- Generates bounded image thumbnails and network-isolated static HTML screenshots (`artifact-preview.ts`).
- Serves 256 KiB chunked artifact downloads/text-previews/stat probes (`artifact.transfer.open/read/close`) and receives chunked mobile file uploads (`file-upload.ts`).

## Critical Invariants
1. **Strictly passive collection**: Never start a model turn or touch `thinking` blocks to gather evidence. Wait for 1s filesystem quiet (capped at 5s) after turn completion; exclude dirty workspace changes that existed before turn start; downgrade confidence to `partial` when concurrent turns share a directory or watchers overflow.
2. **Worktree-first path resolution**: Resolve relative and project-scoped file links against the session's active `harnessCwd` (such as `.claude/worktrees/<name>`) before the parent project `cwd`, and enforce path containment so symlink/traversal escapes and parent-root namesakes are never read.
3. **Transfer bounds & ephemerality**: Artifact transfers cap single files at 20 MiB with 10-minute leases and end-to-end SHA-256 verification. `purpose: "stat"` (`artifact.transfer.stat.v1`) returns metadata without reading full content so clients can confirm large downloads first. Artifact responses are ephemeral (10-minute TTL) and must never enter Relay's 7-day offline queue.
4. **Isolated HTML preview**: `artifact-preview.ts` must render HTML snapshots with network access blocked and JavaScript/navigation sandboxed so local artifacts cannot exfiltrate data.

## Minimum Verification
```bash
npm run ci:run -- test -w @bridge/desktop
npm run test:html-preview
npm run test:browser
```
