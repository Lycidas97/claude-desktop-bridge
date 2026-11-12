# Subsystem: Client Conversation & Workspace UI

## Owned Paths
- `apps/client/src/lib/conversation-timeline.ts`
- `apps/client/src/components/` (`MobileWorkspace.tsx`, `DesktopDashboard.tsx`, and subdirectories `conversation/`, `mobile/`, `desktop/`, `evidence/`, `session/`, `pairing/`, `common/`)
- Stylesheets: `apps/client/src/*.css`, `apps/client/src/components/**/*.css`

## Responsibilities
- Projects raw history items, live streaming deltas, tool executions, inline tool permissions/questions, task plans, and subagent runs into a unified renderable timeline (`lib/conversation-timeline.ts`).
- Renders the 3-layer mobile workspace (`MobileWorkspace.tsx`, `components/mobile/`) with composer, slash-command catalog, context-usage indicator, Desktop Section moves, and Browse Computer single-level folder creation.
- Renders the lightweight Electron desktop console (`DesktopDashboard.tsx`, `components/desktop/DesktopSessionsPane.tsx`, `components/desktop/DesktopSettings.tsx`).
- Provides cached/chunked image, PDF range-stream, markdown/code text, and HTML snapshot previews with pre-download size confirmation (`components/evidence/`).

## Critical Invariants
1. **`scripts/media-preview-qa.mjs` import coupling**: In `--mobile` QA mode, `scripts/media-preview-qa.mjs` fetches `/src/components/MobileWorkspace.tsx` from Vite and matches `from "...MediaPreviewProvider.tsx..."` via regex. If relocating or re-exporting `MediaPreviewProvider.tsx`, update `scripts/media-preview-qa.mjs` in the same change.
2. **Packaged Desktop QA selector coupling**: `scripts/packaged-desktop-qa.mjs` and `scripts/windows-native-qa-contract.test.mjs` assert exact role/text selectors on `DesktopDashboard.tsx` and `DesktopSettings.tsx` (`设备`, `添加手机`, `设置`, `连接与启动`, `诊断与关于`, `dt:text-is("原生中转") + dd` -> `已就绪`, `会话设置`). Update both scripts whenever those labels or structure change.
3. **Scroll & streaming stability**: Opening or streaming a session must preserve upward-scrolled reading position during assistant deltas and history pagination, and must not trigger mid-stream `onOpenSession` re-fetch loops when `contextUsage` is temporarily absent.
4. **Visual restraint**: Do not add redundant subtitles, secondary descriptions, or explanatory callouts; keep long host names, status badges, and persistent appearance font-size scales balanced across `375x812` mobile and desktop viewports in both light and dark themes.

## Minimum Verification
```bash
npm run ci:run -- test -w @bridge/client
npm run typecheck
npm run test:infra
npm run test:browser
```
