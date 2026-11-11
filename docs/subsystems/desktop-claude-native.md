# Subsystem: Desktop Claude Native & Quarantined Legacy

## Owned Paths
- `apps/desktop/src/claude/`
  - Inspector attachment, macOS startup & connection monitor: `claude-desktop-inspector.ts`, `claude-inspector-startup.ts`, `claude-inspector-monitor.ts`
  - `LocalSessions` native facade & projections: `claude-desktop-bridge.ts`, `native-context-usage.ts`, `native-history-projection.ts`
  - Catalog, discovery & retired-connector cleanup: `claude-desktop-sessions.ts`, `claude-session-catalog.ts`, `claude-runtime-discovery.ts`, `slash-command-catalog.ts`, `magpie-connection.ts`, `connector.ts`
- `apps/desktop/src/legacy/` (**quarantined — read-only / retirement maintenance only**)
  - `claude-desktop-inbox.ts`, `claude-desktop-archive.ts`, `provider-registry.ts`, `claude-desktop-session-registrar.ts`, `session-desktop-registration.ts`, `transcript-observer.ts`

## Responsibilities
- Discovers Claude Desktop's user-authorized local Node inspector (`http://127.0.0.1:9229/json/list`), attaches to the `app://localhost` renderer `WebContents`, and forwards session lifecycle, messaging, queue promotion/steering/cancellation, rewind, configuration, and tool permission calls to `claude.web.LocalSessions`.
- Subscribes to native events and tool permission prompts via a single renderer queue + waiting Promise (`claude-desktop-bridge.ts`).
- On macOS, triggers the native `Enable Main Process Debugger` menu item at most once per newly discovered Claude Desktop process (`claude-inspector-startup.ts`) and monitors active TCP connections to port 9229 via the native `inspector-process-path` helper (`claude-inspector-monitor.ts`).
- Resolves custom model labels, Magpie model ID hashes, Magpie gateway credentials (`magpie-connection.ts`), and project/personal slash commands (`slash-command-catalog.ts`).

## Critical Invariants
1. **`./native` path resolution invariant**: `claude-inspector-monitor.ts` resolves `./native/inspector-process-path` against `import.meta.url`. Because `apps/desktop/scripts/build.mjs` bundles into `dist/main.cjs` and compiles the C helper to `dist/native/inspector-process-path`, the relative path **must remain `./native/...`** (resolving next to `dist/main.cjs`), even though the TypeScript source lives under `apps/desktop/src/claude/`.
2. **Sole runtime authority & security boundary**: Never patch `app.asar`, mint auth tokens, send `SIGUSR1`, restart Claude Desktop for Bridge, or expose arbitrary JS `evaluate` to Relay.
3. **macOS menu startup safety**: `claude-inspector-startup.ts` keys attempts by `(pid, launchTime, executablePath)`, skips already-open ports and custom `BRIDGE_CLAUDE_INSPECTOR_URL` origins, persists attempts/failures in Bridge `userData`, and never re-opens an inspector the user manually closed in the same Desktop process. Always pass explicit `"darwin"` to `desktopAppPathCandidates` in `parseInspectorDesktopProcesses`.
4. **Avoid mid-stream session re-open**: Do not trigger redundant `LocalSessions` session open/refresh loops while an assistant turn is actively streaming.
5. **`apps/desktop/src/legacy/` quarantine**: Modules in `legacy/` exist only for legacy schema compatibility and safe removal of pre-1.3 Bridge MCP/hook entries (`connector.ts` writes `.bridge-backup` and removes only hooks matching exact `/hooks/claude-permission` + `X-Bridge-Permission-Host: $BRIDGE_PERMISSION_HOST` + `allowedEnvVars`). **Never wire new features into `apps/desktop/src/legacy/`.**

## Minimum Verification
```bash
npm run ci:run -- test -w @bridge/desktop
npm run test:browser
# On macOS with Accessibility + System Events permission (targets isolated Electron fixture, never port 9229):
npm run ci:run -- exec -- node scripts/claude-inspector-startup-qa.mjs output/inspector-startup-qa
```
