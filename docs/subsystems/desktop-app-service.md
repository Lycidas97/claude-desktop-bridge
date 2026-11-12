# Subsystem: Desktop App & Background Service

## Owned Paths
- `apps/desktop/src/main.ts` (`dist/main.cjs`) & `apps/desktop/src/preload.ts` (`dist/preload.cjs`)
- `apps/desktop/src/app/`
- `apps/desktop/scripts/` (`build.mjs`, `make-windows.mjs`)

## Responsibilities
- Boots the Electron UI shell (`main.ts`), exposes the context-isolated `window.bridgeDesktop` preload bridge (`preload.ts` typed via `@bridge/protocol` `desktop-ipc.ts`), and manages system tray and login-item state.
- Supervises the detached background service process (`service-runtime.ts`, `service-connection.ts`) so pairing, Relay/WebRTC connectivity, and Claude inspector monitoring survive main window closure.
- Resolves OS-specific application bundles, executables, and user data directories across macOS (`Claude.app`, `Claude-3p`), Linux, and Windows 11 (both standard `%APPDATA%\Claude` / `%LOCALAPPDATA%` installs and MSIX `Packages\Claude_*\LocalCache\Roaming\Claude` containers).
- Reads and enables `allowDevTools` in Claude Desktop's `developer_settings.json` (`claude-desktop-developer-settings.ts`).

## Critical Invariants
1. **Bundle layout & `import.meta.url` banner**: `apps/desktop/scripts/build.mjs` bundles `src/main.ts` into `dist/main.cjs` with `import.meta.url` rewritten to `dist/main.cjs`'s file URL, and stages `dist/native/inspector-process-path` (macOS) plus `dist/node_modules/node-datachannel`. Runtime asset paths resolved from `import.meta.url` are relative to `apps/desktop/dist/`, **not** `apps/desktop/src/app/` or `apps/desktop/src/claude/`.
2. **Explicit target platform in cross-OS helpers**: Functions in `platform.ts` and `desktop-app-definitions.ts` accept an explicit `platform` parameter. Callers parsing OS-specific output (such as macOS `ps` lines) must pass `"darwin"` explicitly rather than relying on `process.platform` so Linux and Windows CI runners stay deterministic.
3. **Non-destructive `developer_settings.json` updates**: Enabling developer tools must preserve all existing JSON keys in `developer_settings.json`. On macOS TCC `EPERM`/`EACCES`, keep the enablement action interactive and request directory access via Electron's open-directory dialog (with hidden files visible) rather than failing permanently.
4. **Preload isolation**: `preload.ts` must keep `contextIsolation: true` and expose only the narrow `BridgeDesktopApi` surface defined in `packages/protocol/src/desktop-ipc.ts`.

## Minimum Verification
```bash
npm run ci:run -- test -w @bridge/desktop
npm run ci:run -- run build:bundle -w @bridge/desktop
# After a full desktop build on macOS/Linux:
npm run ci:run -- run test:desktop:service
```
