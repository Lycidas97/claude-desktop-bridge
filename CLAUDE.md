# Claude Desktop Bridge

## Core Invariant
- Claude Desktop (`claude.web.LocalSessions` via the user-authorized local Node inspector) is the **sole session execution, queue, and permission authority**.
- Relay and WebRTC transports carry **only E2EE ciphertext** (Protocol V3 / Pairing V4); Relay never sees plaintext, keys, or session metadata.

## Required Pre-Flight Reading
- @AGENTS.md — subsystem and workflow routing table (read the routed `docs/subsystems/*.md`, `docs/code-standards.md`, and `LESSONS.md` on demand before editing or reviewing).

## Hard Guardrails
- **Remote & PR boundary**: NEVER push branches, tags, or PRs to `upstream` (`czhmartinez/claude-desktop-bridge`). Push branches and open/merge Issues & PRs **ONLY** on `origin` (`Lycidas97/claude-desktop-bridge`).
- **Recycle-bin-only deletion**: NEVER use `rm`, `/bin/rm`, or permanent deletion in shell, Python, or Node. Move deleted paths to the OS Recycle Bin (`/usr/bin/trash` on macOS, `trash-put` on Linux, and `scripts/recycle-cleanup.cjs` via `npm run ci:run -- ...` in Node scripts/tests).
- **Native-only runtime**: NEVER reintroduce SDK/CLI Hosts, provider lanes, transcript observers, or a `legacy/` module tree.
