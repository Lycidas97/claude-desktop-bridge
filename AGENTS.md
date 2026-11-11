# Agent Routing Table

Read the routed document **before** exploring or modifying any path or executing a workflow step. Do not rely on memory when a routed spec exists.

## Subsystem Routing

| Subsystem | Owned Paths | Read Before Editing | Minimum Verification |
| --- | --- | --- | --- |
| Protocol & Transport | `packages/protocol/src/` | `docs/subsystems/protocol-transport.md` | `npm run ci:run -- run build -w @bridge/protocol && npm run ci:run -- test -w @bridge/protocol && npm run typecheck` |
| Desktop App & Service | `apps/desktop/src/main.ts`, `apps/desktop/src/preload.ts`, `apps/desktop/src/app/` | `docs/subsystems/desktop-app-service.md` | `npm run ci:run -- test -w @bridge/desktop && npm run ci:run -- run build:bundle -w @bridge/desktop` |
| Desktop Claude Native & Legacy Quarantine | `apps/desktop/src/claude/`, `apps/desktop/src/legacy/` | `docs/subsystems/desktop-claude-native.md` | `npm run ci:run -- test -w @bridge/desktop && npm run test:browser` |
| Desktop Transcript & Context | `apps/desktop/src/transcript/` | `docs/subsystems/desktop-transcript.md` | `npm run ci:run -- test -w @bridge/desktop && npm run test:browser` |
| Desktop Evidence & Previews | `apps/desktop/src/evidence/` | `docs/subsystems/desktop-evidence.md` | `npm run ci:run -- test -w @bridge/desktop && npm run test:html-preview && npm run test:browser` |
| Desktop Controller, RPC & Host Transport | `apps/desktop/src/controller/`, `apps/desktop/src/transport/` | `docs/subsystems/desktop-controller-rpc.md` | `npm run ci:run -- test -w @bridge/desktop && npm run test:infra && npm run test:browser` |
| Client Conversation & Workspace UI | `apps/client/src/components/`, `apps/client/src/lib/conversation-timeline.ts` | `docs/subsystems/client-conversation-ui.md` | `npm run ci:run -- test -w @bridge/client && npm run typecheck && npm run test:infra && npm run test:browser` |
| Client Bridge State & Vault | `apps/client/src/hooks/`, `apps/client/src/lib/` | `docs/subsystems/client-bridge-state.md` | `npm run ci:run -- test -w @bridge/client && npm run typecheck && npm run test:browser` |
| Relay Server & Quota Plugin | `apps/relay/src/`, `plugins/magpie-quota/` | `docs/subsystems/relay-and-plugins.md` | `npm run ci:run -- test -w @bridge/relay && npm run ci:run -- --prefix plugins/magpie-quota test && npm run typecheck` |
| CI, Release & Packaged QA | `.github/workflows/`, `scripts/` | `docs/subsystems/ci-release-qa.md` | `npm run test:infra && npm run verify` |

## Task & Workflow Routing

| Task | Route / Required Procedure |
| --- | --- |
| Writing or reviewing code | Read `docs/code-standards.md` and `LESSONS.md` first. |
| Running tests, fixtures, or packaged QA | Read `docs/testing.md` and `docs/subsystems/ci-release-qa.md`. Wrap ad-hoc Node/npm commands with `npm run ci:run -- ...`. |
| Bug fixes & features | 1. Open a GitHub Issue on `Lycidas97/claude-desktop-bridge` (`gh issue create --repo Lycidas97/claude-desktop-bridge`).<br>2. Work in an isolated `git worktree` branch.<br>3. Push branch to `fork` and open a PR referencing `Fixes #N` using `.github/pull_request_template.md`.<br>4. Merge **only** after full review and green `Quality gate` using `gh pr merge --repo Lycidas97/claude-desktop-bridge --match-head-commit <reviewed-sha>`. |
| Nightly / pre-release retro | Audit recent commits against `LESSONS.md`. Promote any lesson reaching `Seen 3×` across **3 distinct calendar dates** into `docs/code-standards.md`. |
| Cutting a release | Read `docs/RELEASE.md`. The target commit on `main` **must** have a `status == "completed"` and `conclusion == "success"` `CI` push run (`Quality gate`); cancelled or incomplete runs never qualify. |
| Architecture & protocol overview | Read `docs/ARCHITECTURE.md` and `docs/SECURITY.md`. |
