# Claude Desktop Bridge

## Core Invariant
- Claude Desktop (`claude.web.LocalSessions` via the user-authorized local Node inspector) is the **sole session execution, queue, and permission authority**.
- Relay and WebRTC transports carry **only E2EE ciphertext** (Protocol V3 / Pairing V4); Relay never sees plaintext, keys, or session metadata.

## Required Pre-Flight Reading
- @AGENTS.md — subsystem and workflow routing table (read before exploring or editing any path).
- @LESSONS.md — verified mistake & retro log (read before implementing or reviewing changes).

## Hard Guardrails
- **Remote & PR boundary**: NEVER push branches, tags, or PRs to `origin` (`czhmartinez/claude-desktop-bridge`). Push branches and open/merge Issues & PRs **ONLY** on `fork` (`Lycidas97/claude-desktop-bridge`).
- **Recycle-bin-only deletion**: NEVER use `rm`, `/bin/rm`, or permanent deletion in shell, Python, or Node. Move deleted paths to the OS Recycle Bin (`/usr/bin/trash` on macOS, `trash-put` on Linux, and `scripts/recycle-cleanup.cjs` via `npm run ci:run -- ...` in Node scripts/tests).
- **Quarantined legacy code**: NEVER reintroduce SDK/CLI Hosts, provider lanes, or wire new features into `apps/desktop/src/legacy/`.
