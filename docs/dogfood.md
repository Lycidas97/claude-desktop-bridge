# Dogfood Build & Runtime Incidents

CI proves regressions and platform builds on synthetic fixtures. Bugs in real Claude Desktop sessions and real phone use are found by using Bridge, so the owner's Mac always runs current `main` and real use starts with the first merge, not after a release.

## Dogfood build

- **When**: after each batch of merges to `main`, the patrol asks the owner to quit Bridge from the tray (`停止后台服务并退出…`), then runs in a clean checkout of `main`:
  ```bash
  npm run ci:run -- exec -- node scripts/dogfood-install.mjs
  ```
  The script builds and installs Bridge, verifies the signature, reads the installed ASAR hash, and requests launch. Only then does it move the replaced app, this run's `apps/desktop/out/Bridge-darwin-<arch>/` directory, and any historical `Bridge.app` or `Bridge.app.bak` in `~/Library/Application Support/Bridge-dogfood/previous/` to the Trash. A cleanup failure does not undo the verified install. If it leaves `Bridge.app.retired` in `/Applications`, the next update retries recycling that exact bundle before replacing the installed app. The script refuses to run while Bridge is running and never touches the profile or `bridge-config.json`.
- **Version**: `<latest v* tag with patch + 1>-dev.<commits since that tag>`, e.g. `1.3.4-dev.7` after `v1.3.3`. It is written into the build only, never committed. The built-in updater compares semver (`packages/protocol/src/updater.ts`), so it offers a formal release only when that release is newer than the dogfood build: a release cut from the installed commit (`1.3.4 > 1.3.4-dev.7`) is offered; a release older than the installed commit (dogfood already at `1.3.5-dev.2`) is not.
- **Signing**: the script uses `package:local-signed` when local signing is set up (`npm run signing:setup-local -w @bridge/desktop`, once per Mac), so macOS privacy consent survives reinstalls; otherwise `package:adhoc`, whose cdhash requirement can re-prompt after each install.
- **Memory recording** (`background-service/memory-v1.sqlite`) is always on.
- **Diagnostic components stay in the product, off by default.** Once a diagnostic patch has proved useful, it merges to `main` and ships in formal releases behind an opt-in switch in Desktop Settings `诊断与支持`, persisted in the profile so it survives restarts and updates. When off it starts no timers, opens no files, and records nothing. It records numbers only; heap snapshots stay local with mode `0600`. The next time an incident happens, the owner turns on the existing switch and does not need a special build. Only a brand-new, unreviewed patch is installed as an overlay from a worktree (the version gets a `.diag` suffix) until it merges.
- **Rollback**: if installation fails, the script tries to restore the old app. If `Bridge.app.rollback` remains in `/Applications`, move the incomplete `Bridge.app` (if present) to the Trash, then rename the saved bundle back to `/Applications/Bridge.app` before retrying. To roll back after a successful install, locate the replaced `Bridge.app.retired` bundle in the Trash, quit Bridge, move the current app to the Trash, and restore the old bundle as `/Applications/Bridge.app`.
- **Release gate**: the release commit must have run as the dogfood build through several hours of real phone use with no open regression. There is no separate post-release acceptance session.

Windows dogfood installation is not covered yet.

## Android dogfood APK

After a batch of merges, when updating the owner's phone or checking a phone regression, the patrol runs on this Mac:

```bash
npm run ci:run -- exec -- node scripts/dogfood-android.mjs origin/main
```

The optional argument can be a specific `main` commit. The command fetches `origin/main`, rejects commits outside its history, and uploads a ZIP of that committed source to `ssh win` (`BRIDGE_WIN_SSH_HOST` overrides the host). Uncommitted files are not included. Windows uses `D:\work\tools\node-26`, `jdk-21`, `python`, and `android-sdk` to build the client and debug APK, verify every DEX and the pinned debug certificate, then copy the APK back and compare SHA-256 hashes. Android version fields stay as committed; the APK filename identifies the source commit.

The printed `apk` path is under `output/dogfood-android/<sha12>-<run-id>/Bridge-Android-<sha12>-debug.apk` in the invoking checkout. This only builds and copies the APK; installation on the phone remains manual. No release signing or Play distribution is involved.

Each run owns `D:\work\bridge-android-dogfood-<run-id>` and a local `.staging-*` directory under `output/dogfood-android/`. Both go to the OS Recycle Bin after copying, or on failure. Ctrl-C and SIGTERM cancel the local command; cleanup stops this run's recorded Windows worker and its descendants before recycling. A recycle failure fails the command and leaves the affected path for inspection. The retained APK and the dedicated dependency caches in `D:\work\cache\android-dogfood` remain. The command does not use CI slots, Git worktrees, emulators, or CI status publication.

## Runtime incidents (OOM, freeze, leak)

**Who does what.** The patrol only collects evidence: thread samples, a frozen copy of the memory records, logs. It copies them to a local directory (mode `0700`, files `0600`) and, with the owner's approval, restarts or reinstalls. Diagnostic patches, fixtures, regression tests, and fixes (steps 2–4) belong to a fork started for the incident. The fork's brief carries the evidence paths. The patrol never opens an implementation worktree, even while the service is stuck.

1. **Reproduce from existing code and records.** If that fails, stop static analysis; do not start parallel multi-model code reading.
2. **Diagnostic patch + full test run.** The patch records numbers only (in-flight requests, cache sizes, history read sizes, heap) plus a heap snapshot near the heap limit (`--heapsnapshot-near-heap-limit` or one `v8.writeHeapSnapshot()` past a threshold; snapshots contain plaintext, so local-only, `0600`). Drive fixtures along the incident's path (large history, repeated tool and subagent output, continuous scroll-back). A reproduction becomes a failing regression test before any fix.
3. **Synthetic data cannot reproduce it**: turn on the existing diagnostic switch, or layer a new patch onto the dogfood build (`.diag` version), and the owner reproduces in real use. A patch that helped merges to `main` behind its switch, default off.
4. **Record, then fix.** Locate the retainer or stuck path from the recorded data, write the reproducing test, fix, and confirm with the same diagnostic build on the same usage path.
5. **No reproduction, no fix.** Unrelated improvements found along the way may merge on their own merit, but are not linked to the incident or shipped as its fix. Diagnostic components may merge without a reproduction because they do not change behavior while off.
