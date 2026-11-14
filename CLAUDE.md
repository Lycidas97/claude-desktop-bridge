# Claude Desktop Bridge

## Core Invariant
- Claude Desktop (`claude.web.LocalSessions` via the user-authorized local Node inspector) is the **sole session execution, queue, and permission authority**.
- Relay and WebRTC transports carry **only E2EE ciphertext** (Protocol V3 / Pairing V4); Relay never sees plaintext, keys, or session metadata.

## Required Pre-Flight Reading
- @AGENTS.md — subsystem and workflow routing table (read the routed `docs/subsystems/*.md`, `docs/code-standards.md`, and `LESSONS.md` on demand before editing or reviewing).

## Hard Guardrails
- **Remote & PR boundary**: NEVER push branches, tags, or PRs to `upstream` (`czhmartinez/claude-desktop-bridge`). Push branches and open/merge Issues & PRs **ONLY** on `origin` (`Lycidas97/claude-desktop-bridge`).
- **Deletion boundary**: User files, build outputs, retained evidence and every non-temporary path MUST go to the OS Recycle Bin (`/usr/bin/trash`, `trash-put`, or `scripts/recycle-cleanup.cjs` via `npm run ci:run -- ...`). The only direct-delete exception is test/CI scratch in a fresh run-owned temporary root (`BRIDGE_TEST_TEMP_ROOT`), its newly created upload/QA staging, and standalone Windows QA's own GUID-named profile/smoke/install-copy directories. Never authorize shared temp, pre-existing paths, historical staging, filename prefixes or symlink targets outside that root. `artifacts/`, `output/`, old reports and installer/build outputs still recycle; no permanent-delete fallback. All other shell/Python/Node permanent deletion remains forbidden (details: `docs/testing.md` Cleanup boundary).
- **Native-only runtime**: NEVER reintroduce SDK/CLI Hosts, provider lanes, transcript observers, or a `legacy/` module tree.
