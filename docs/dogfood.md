# Dogfood Build & Runtime Incidents

CI proves regressions and platform builds on synthetic fixtures. Bugs in real Claude Desktop sessions and real phone use are found by using Bridge, so the owner's Mac always runs current `main` and real use starts with the first merge, not after a release.

## Dogfood build

- **When**: after each batch of merges to `main`, the patrol asks the owner to quit Bridge from the tray (`停止后台服务并退出…`), then runs in a clean checkout of `main`:
  ```bash
  npm run ci:run -- exec -- node scripts/dogfood-install.mjs
  ```
  The script builds the macOS app, keeps the replaced `/Applications/Bridge.app` as the single previous copy in `~/Library/Application Support/Bridge-dogfood/previous/`, installs, verifies the signature, and opens Bridge. The profile and `bridge-config.json` are never touched. It refuses to run while Bridge is running.
- **Version**: `<latest v* tag with patch + 1>-dev.<commits since that tag>`, e.g. `1.3.4-dev.7` after `v1.3.3`. It is written into the build only, never committed. The built-in updater compares semver (`packages/protocol/src/updater.ts`), so it offers a formal release only when that release is newer than the dogfood build: a release cut from the installed commit (`1.3.4 > 1.3.4-dev.7`) is offered; a release older than the installed commit (dogfood already at `1.3.5-dev.2`) is not.
- **Signing**: the script uses `package:local-signed` when local signing is set up (`npm run signing:setup-local -w @bridge/desktop`, once per Mac), so macOS privacy consent survives reinstalls; otherwise `package:adhoc`, whose cdhash requirement can re-prompt after each install.
- **Memory recording** (`background-service/memory-v1.sqlite`) is always on. Diagnostic patches for an open incident are built from a worktree with the patch applied and installed the same way; the version gets a `.diag` suffix. The patch never lands on `main`; the next dogfood install removes it.
- **Rollback**: quit Bridge, then `/usr/bin/trash /Applications/Bridge.app && ditto ~/Library/Application\ Support/Bridge-dogfood/previous/Bridge.app /Applications/Bridge.app`.
- **Release gate**: the release commit must have run as the dogfood build through several hours of real phone use with no open regression. There is no separate post-release acceptance session.

Not covered yet: Android APK and Windows dogfood builds.

## Runtime incidents (OOM, freeze, leak)

1. **Reproduce from existing code and records.** If that fails, stop static analysis; do not start parallel multi-model code reading.
2. **Diagnostic patch + full test run.** The patch records numbers only (in-flight requests, cache sizes, history read sizes, heap) plus a heap snapshot near the heap limit (`--heapsnapshot-near-heap-limit` or one `v8.writeHeapSnapshot()` past a threshold; snapshots contain plaintext, so local-only, `0600`). Drive fixtures along the incident's path (large history, repeated tool and subagent output, continuous scroll-back). A reproduction becomes a failing regression test before any fix.
3. **Synthetic data cannot reproduce it**: layer the patch onto the dogfood build (`.diag` version) and the owner reproduces in real use.
4. **Record, then fix.** Locate the retainer or stuck path from the recorded data, write the reproducing test, fix, and confirm with the same diagnostic build on the same usage path.
5. **No reproduction, no fix.** Unrelated improvements found along the way may merge on their own merit, but are not linked to the incident or shipped as its fix.
