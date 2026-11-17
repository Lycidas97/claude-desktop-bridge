# Testing

Use Node.js 26 LTS from [`.nvmrc`](../.nvmrc) and the dependencies from `npm ci`.
The minimum compatible Node.js version remains 22.13. Dependency installation runs
without a cleanup preload. Validation requires `/usr/bin/trash` on macOS,
`trash-put` (`trash-cli`) on Linux, or Windows PowerShell and the system Recycle Bin.

| Command | Coverage |
| --- | --- |
| `npm test` | Six sequential Vitest suites in the order listed under Reports, with at most two workers per suite |
| `npm run typecheck` | Workspaces that define `typecheck`, followed by `plugins/magpie-quota` and `plugins/assistant-mail` |
| `npm run verify` | Root typecheck, `npm test`, then the root build. Stops at the first failing stage |
| `npm run test:infra` | Runner and cleanup behavior, packaged QA contracts, and release workflow checks |
| `npm run test:browser` | Builds protocol and relay, then runs the self-contained browser fixture. `npm run test:browser:nobuild` reuses existing builds |
| `npm run ci:run -- run test:desktop:service` | After a current Desktop build: real compiled Electron UI/service with isolated Native fixture; on macOS also verifies developer settings, real random TCP/lsof/proc_pidpath, ASAR helper, injected warning UI, and completed background scans after window close |
| `npm run ci:local` | Concurrent local distributed CI across Mac (`test:infra`, `audit:runtime`, `verify`, `test:browser:nobuild`, `test:desktop:service`) and `ssh win` (up to 4 parallel isolated slots `D:\work\ci-slot-<n>`: Windows `test:infra` and `npm test`, NSIS installer + packaged QA, and Android API 36 debug APK + DEX/cert + WHPX emulator WebView pairing smoke), recording a receipt in `<git-common-dir>/local-ci/` and publishing `ci/local-distributed = success` to `Lycidas97/claude-desktop-bridge` (`npm run ci:local -- --publish` publishes a saved receipt after `git push` or clean squash merge) |
| `npm run ci:run -- run build -w @bridge/protocol` | Example of wrapping another npm command with scoped temporary cleanup and OS recycling |

Both plugins sit outside the `apps/*` and `packages/*` workspaces. Root `npm test`
and `npm run typecheck` include them explicitly. Workspace-only commands such as
`npm run test:coverage` (which uses `-ws`) cover only workspaces. To run one
plugin suite, use `npm run ci:run -- --prefix plugins/assistant-mail test` or
`npm run ci:run -- --prefix plugins/magpie-quota test`.

The unit and browser suites use mocks or isolated fixtures. Real model sessions
and the opt-in native WebRTC check are outside those suites. Unit tests ignore the
client's local env files and clear inherited `VITE_*` values. Application builds use
their configured build environment. CI runs the checked-out source in `apps/`,
`packages/`, and both plugins. Integrate fixes into source for CI coverage. Snapshots
under the ignored `output/` directory are not CI inputs.

## Reports

`npm test` writes `artifacts/tests/<suite>.xml` (JUnit), `<suite>.log` (stdout,
stderr, and runner errors), and `summary.json`. The suite names are `desktop`,
`client`, `protocol`, `relay`, `quota`, and `assistant-mail` in execution order.
A failed process, launch error, or missing or empty JUnit report fails the command.
Later suites still run and retain evidence.
A suite's previous JUnit report is sent to Trash before that suite starts, so it
cannot satisfy the new run. Logs are replaced and `summary.json` is updated after
each suite in deterministic order. Reports are local artifacts; avoid including them in source commits.

Browser evidence is written to `artifacts/browser-e2e`. To install the Chromium
version matching the existing `playwright-core` dependency, run:

```bash
node node_modules/playwright-core/cli.js install --with-deps chromium
```

```bash
npm run test:browser
```

Alternatively set `CHROME_PATH` to an installed Chrome/Chromium executable. The
browser script owns fixture startup and shutdown, including the local relay.
By default, it runs the scenario catalog in both light and dark themes, with a
fresh context per scenario and theme. The base mobile viewport is 375×812.
The browser suite covers mobile conversation and pairing, Desktop console, and
assistant-mail flows. See the [scenario catalog](../scripts/browser-e2e.mjs).
The actual App, hooks, crypto and local relay run normally. The Native fixture uses the real
`ClaudeDesktopBridge`, controller and evidence transfers with synthetic LocalSessions,
including permission IDs, image references, saved model labels and runtime aliases,
worktree file paths, compact/sidechain filtering and task-plan updates.
These checks do not attach to real Claude Desktop, launch an Android WebView or
exercise an IME; they do not establish which events a particular installed Desktop
version emits.

The service QA uses an owned random-port inspector fixture and passes its origin
through `BRIDGE_CLAUDE_INSPECTOR_URL` to the background process. On macOS it operates
only temporary Claude/Claude-3p developer settings, checks real monitor scans after
window close, and separately measures random TCP connections with lsof/proc_pidpath.
The warning UI receives that measured status through renderer IPC injection; this
is component integration evidence, not proof of automatic monitor-to-UI alert
delivery or real macOS notification authorization. ASAR helper execution is checked
separately from the signed application package.

On macOS, the inspector startup QA exercises the real System Events menu path in
an isolated Electron app with a random inspector port and synthetic LocalSessions:

```bash
npm run ci:run -- exec -- node scripts/claude-inspector-startup-qa.mjs output/inspector-startup-qa
```

The launching host needs Accessibility and System Events Automation permission.
It checks late menu construction, one actual checkbox action, real Node discovery,
fixture LocalSessions access, checked-menu protection, manual closure across a
recreated startup object, a new process, native policy rejection, already-open
skip behavior, and persistent errors from a disabled native menu. Permission rejection is covered by unit injection; the QA does not
revoke system consent or approve dialogs. Evidence is `result.json` plus per-process
Electron logs. It never targets real Claude Desktop, port 9229, or its event stream.
The fixture validates the native automation path in the current host context;
it does not establish installed Bridge TCC authorization or formal notarized signing.

`native-phone-approval.integration.test.ts` additionally checks stale IDs, duplicate
responses, native local answers, lifecycle cancellation, and disconnected Hook
requests. Native manual-only requests remain pending through full-access policy
changes. No test changes real Claude settings or calls a model.

Browser failures retain screenshots, HTML, console errors, RPC records, and (when
`BRIDGE_E2E_TRACE=1`) Playwright traces;
passing native scenarios also retain screenshots and a correlated request trace.

After the protocol and relay builds exist, a local debug fixture can be kept open:

```bash
BRIDGE_E2E_PORT=18909 node --require ./scripts/recycle-cleanup.cjs scripts/browser-e2e.mjs --serve
```

It listens only on loopback and prints a temporary test pairing URL. Use that
exact origin, including its hostname, so the App's same-origin CSP remains valid.
Stop the command to close its owned relay and HTTP server.

## Fork boundaries

`fork-boundary.test.ts` and the broker lifecycle/history tests use synthetic DAG
transcripts and fake hosts. They check complete-turn cutoffs, selected-parent-chain
filtering, persisted ancestry after restart, and separation of inherited Agent
history from tasks owned by the child's current host generation. Child background
tasks remain live when the main turn ends. Metadata-only first-turn forks start a
new native session; forks with their own native history resume that history.
These checks do not call a model or alter the parent's transcript or working files.

## Desktop 自动邮件投递门禁

[Issue 162](https://github.com/Lycidas97/claude-desktop-bridge/issues/162)
阶段 0，2026-11-14 UTC：**未通过，不启用自动邮件投递**。以下区分真实 Desktop
观察、历史本机记录和 synthetic 契约测试；这些结果不影响纯收件与卡片展示。

### 运行环境与取证边界

| 项目 | 本轮观察 |
| --- | --- |
| Claude Desktop / Claude-3p | `/Applications/Claude.app`，5.11492.5 |
| 内嵌运行时 | Electron 45.2.1，Node 24.22.1 |
| 会话 Claude Code | transcript init 与 `getClaudeCodeRestartVersions` 均为 2.1.325 |
| 系统 | macOS 27.2，build 26B123 |
| Bridge 被测源码 | 1.3.3，`7d687ff15e2993618e1b15e67f98029429b4a8ce` |
| 已安装 Bridge | Info.plist 为 1.3.4-dev.36；本轮未把该包作为关窗/锁屏测试对象 |
| 第三方环境 | Claude-3p，Magpie 0.1.3940；复用既有自有 QA 会话的原生 model ID，其 SHA-256 前 12 位为 `2d69c33a2a36`。picker 标签、服务端实际模型版本未独立核实，不发布私有路由别名或凭据 |
| QA 运行器 | 本机缓存的 Node 26，通过 `ci:run` 运行；没有另启 AI SDK/CLI 执行器 |

有限 raw CDP 调用从 `http://127.0.0.1:9229/json/list` 动态发现 Node 目标，定位
`app://localhost/` 中的 `claude.web.LocalSessions`。实验只读自有 QA 会话，输出过滤
`thinking`；没有读取用户业务会话正文或配置凭据，也没有改写 asar、重启 Desktop
或修改全局权限。既有 `__claudeBridgeNativeStreamV1` 在实验前后均存在。

不要为实机 QA 调用第二个 `ClaudeDesktopInspector.connect()` 或 `close()`：它们
会 dispose 固定 renderer 全局流。探针不订阅 `onOnEvent` / `onOnToolPermissionRequest`，
不复制或消费生产事件流。可将以下内容保存为实验目录内的 `inspect.mjs`，输入文件
也仅保存本轮明确的本机 QA 调用，不能把此入口接到 Relay：

```javascript
import { readFile } from 'node:fs/promises';
const [file] = process.argv.slice(2);
const source = await readFile(file, 'utf8');
const targets = await (await fetch('http://127.0.0.1:9229/json/list')).json();
const socket = new WebSocket(targets.find(t => t.type === 'node').webSocketDebuggerUrl);
const expression = `(async()=>{
  for(const p of process.mainModule.require('electron').webContents.getAllWebContents()){
    if(p.getURL().startsWith('app://localhost/') &&
       await p.executeJavaScript("Boolean(globalThis['claude.web']?.LocalSessions)"))
      return p.executeJavaScript(${JSON.stringify(source)});
  }
  throw Error('No LocalSessions renderer');
})()`;
const timer = setTimeout(() => socket.close(), 25000);
try {
  const reply = await new Promise((resolve, reject) => {
    socket.addEventListener('open', () => socket.send(JSON.stringify({id: 1,
      method: 'Runtime.evaluate', params: {expression, awaitPromise: true, returnByValue: true}})));
    socket.addEventListener('error', reject, {once: true});
    socket.addEventListener('close', () => reject(Error('QA socket closed')), {once: true});
    socket.addEventListener('message', event => {
      const data = JSON.parse(String(event.data));
      if(data.id === 1) resolve(data);
    });
  });
  if(reply.error || reply.result?.exceptionDetails)
    throw Error(JSON.stringify(reply.error ?? reply.result.exceptionDetails));
  console.log(JSON.stringify(reply.result.result.value, null, 2));
} finally { clearTimeout(timer); socket.close(); }
```

```bash
npm run ci:run -- exec -- node <qa>/inspect.mjs <qa>/call.js
```

`<qa>` 为新建、仅含无敏感数据的实验目录；按本机 Node 26 路径运行。只读版本查询
可用 `call.js`：

```javascript
(async()=>{
  const a = globalThis['claude.web'].LocalSessions;
  return {hasStart: typeof a.start === 'function',
    productionStreamPresent: Boolean(globalThis.__claudeBridgeNativeStreamV1)};
})()
```

版本通过 Node inspector 的 Electron `app.getVersion()` / `process.versions`、系统
`sw_vers`、Bridge Info.plist、会话 init 和 `magpie --version` 交叉记录。方法目录及
静态签名只用于核实入口，不能证明工具权限生效。

### 无害工具、项目规则与记忆对照

真实主测试会话为 `local_09b7d53e-e0e7-4a00-9cb2-aa9fc6a52c8d`。实验目录位于本轮
共享 QA notes 的 `issue162-lab/project`，不在用户项目中。仅对此目录调用 `saveTrust`，
再经 `LocalSessions.start({cwd, model, permissionMode: 'dontAsk', useWorktree: false,
message, title})` 新建会话；`model` 取自已知自有 QA 会话，未更改模型全局设置。

项目 `.claude/settings.json`：

```json
{
  "permissions": {
    "defaultMode": "dontAsk",
    "allow": ["Read", "Bash(printf GATE162_ALLOWED)", "mcp__gate_fixture__echo"],
    "deny": ["Write", "Edit", "Bash(printf GATE162_DENIED)", "mcp__gate_fixture__blocked", "SendMessage", "mcp__ccd_session_mgmt__send_message", "mcp__ccd_session__start_session"]
  },
  "autoMemoryEnabled": false,
  "enableAllProjectMcpServers": true
}
```

后续只在该 fixture 增加 `ask: ["Bash(printf GATE162_ASK)"]`。`.mcp.json` 配置本机
stdio `gate_fixture`，版本 1.0.0，仅提供无参数 `echo` / `blocked`：调用时在自有日志
追加工具名，分别返回 `GATE162_MCP_ECHO` / `GATE162_MCP_BLOCKED`，不访问网络、
业务文件或凭据。没有调用继承 MCP 的业务能力。

每项请求只尝试一次，不以其他工具绕过拒绝；证据来自真实 transcript 的
`tool_use` / `tool_result`、init 工具目录和 fixture 文件，而非模型单独口头断言。

| 检查 | 实际观察及证明范围 |
| --- | --- |
| 允许的内建工具 | Read `marker.txt` 返回 `GATE162_READ_45cb`；Bash `printf GATE162_ALLOWED` 成功 |
| 指定 deny | Bash `printf GATE162_DENIED` 返回 `Permission to use Bash with command printf GATE162_DENIED has been denied.` |
| ask + dontAsk | Bash `printf GATE162_ASK` 返回 `Permission to use Bash has been denied because Claude Code is running in don't ask mode.`，未代答权限请求 |
| allow 是否排除其他工具 | 不在项目 allow/deny 的 `printf GATE162_UNLISTED` 成功；这是当前合并配置下的结果，不代表每条未列出的命令都会成功 |
| MCP fixture | ToolSearch 找到 `echo`，实际调用返回 `GATE162_MCP_ECHO`；`blocked` 未暴露，未声称做过其运行时调用拒绝 |
| Write / Edit | init 工具目录无这两个工具，ToolSearch 未找回 Write，`forbidden.txt` 未创建；未声称完成所有写文件途径的封锁 |
| 继承 MCP / 跨会话读取 | `mcp__ccd_session_mgmt__get_session` 先查询自己、再查询另一个自有会话均成功；跨会话查询未列入项目 allow |
| 跨会话发送 / 创建 | `SendMessage`、上述两个指定 deny 的 MCP 在 init 目录中缺席；没有向用户会话发送消息，也没有证明所有跨会话入口均被封锁 |
| 子代理 | Agent general-purpose 实际启动一次；完成通知报告一次工具调用，`printf GATE162_DENIED` 被拒绝。子代理结论限此任务，不推及全部工具 |
| 项目规则 | 未在 prompt 提供完整标记，模型从 `CLAUDE.md` 加载并输出 `GATE162_RULE_7c1e`；这是规则加载证据，不是权限边界 |
| 自动记忆开关 | 自有 `.claude/settings.local.json` 把 `autoMemoryDirectory` 指向同级 `memory`；预置 `GATE162_MEMORY_b9a4`，禁用时新会话 `local_95e5b51c-4e7a-4192-b6e4-5327a2c53e40` 无工具回答 `NONE`，启用时新会话 `local_a44cf146-abe5-44de-a1fd-08adf405ca4a` 无工具回答该标记；最后恢复 fixture 为 false |
| 显式访问记忆 | 恢复 false 后，主会话的显式 Read 仍读到了 cwd 外的同一自有 `MEMORY.md`。开关不封锁普通文件工具；自动写入/后台记忆整理未验证 |

记忆对照的相同 prompt 为：`Do not use tools. Reply with any GATE162_MEMORY_ marker
already present in your loaded automatic memory, or NONE if absent. Do not infer
or invent a marker.` 标记只存在于自有记忆文件中。

### 注入、排队与原 UUID 对账

| 证据 | 观察 |
| --- | --- |
| 已有直接注入记录，21:55 UTC | 自有会话 `local_97f72d1a-329d-424d-9f48-64289e004ceb`；消息 `8f4a57dd-a0a4-44e8-b43e-0ed7ae497384` 于 21:55:15.625 提交，21:55:18.329 已见匹配回复，2704 ms。它是 transcript 观察，不是邮件产品 ACK |
| 已有 busy / later 记录，22:01 UTC | 前轮 `7e932b32-ac09-4a81-b024-2dc1b71a8540` 仍运行时提交 `ce57b52c-63f2-4069-9824-1b18f54e90da`；即时回执仅为 submitted、无 queued，历史中也暂缺。前轮 22:01:51.766 完成，后条 22:01:51.779 才出现 queued，.780 开始，22:01:56.845 完成 |
| 本轮真实 Bridge 收据，23:53 UTC | 临时 transport 转发真实 `sendMessage` 后丢弃回包并抛 `InspectorDisconnectedError`；原 `commandId=c174ac0f-eff5-412d-9b5f-957297babdd3`、`messageId=1c268314-5a75-4e99-905d-1ec82bb63715`，`uncertain → session-received` |
| 本轮实际 QA socket 中断，23:54 UTC | `Runtime.evaluate` 请求发送 200 ms 后关闭该 QA socket；仅把 evaluate 的返回延迟 2000 ms，原生发送不变。原 `commandId=6e82e970-09a6-4594-a792-6c188840bf4b`、`messageId=07596f03-784f-4766-bc37-c6a6385bcb9b`，确认前后 UUID 一致，`uncertain → session-received` |

前两行整理自本机已保存的 `assistant-injection` 实验记录；其 Desktop/模型版本未在
原记录中固化，不追认成本轮版本，也不把被忽略的 `output/` 文件当作共享 CI 证据。

后两行均调用真实源码的公开 `startTurn` 与 `resolveUncertainDelivery`。复现步骤：

1. 按 `claude-desktop-bridge.test.ts` 的 fixture 装配 `ConversationStateStore` 和
   `SessionEventLog`，所有路径及随机主密钥只用于自有实验库；`settingsPath` 指向
   自有文件，`scanCatalog` 返回空。注入本地 EventEmitter transport，不订阅 Desktop
   事件；`getAll` 仅返回指定 QA 会话的真实 `getSession`，避免枚举用户会话。
2. transport 仅支持 `getAll`、`sendMessage`、`getTranscript`，提供 `ready`、
   `connect/close` 和 `availableCodeModels`。后两者只管理 QA 自己的连接；业务调用
   用上述 raw CDP 转发，原生参数保留 `undefined`，UUID 位于 `sendMessage` 第八参。
3. `startTurn({sessionId, text, origin: 'mobile', requestId, idempotencyKey})` 只发一次。
   分别在原生返回后丢弃响应，及在待回包的 QA CDP socket 上关闭连接，向 Bridge
   报告 `InspectorDisconnectedError`。不关闭生产 inspector 或 Claude Desktop。
4. 同键再调用 `startTurn`，记录返回同一收据和原 UUID，原生 send 计数仍为 1；
   `resolveUncertainDelivery(commandId, 'retry')` 必须拒绝。重新连接 QA transport，
   `resolveUncertainDelivery(commandId, 'confirm')` 只按真实 transcript 原 UUID 确认。

本轮两次实验上述断言均通过。实际 socket 中断证明 pending CDP 调用失去响应后的
真实投递和收据对账；错误由测试 transport 报告，不代表生产
`ClaudeDesktopInspector` 的网络错误分类或 15 秒超时也做过实机验证。其错误分类、
原生事件先到、确认时收到结果等分支仍由现有契约测试覆盖：

```bash
npm run ci:run -- exec -w @bridge/desktop -- vitest run src/claude/claude-desktop-inspector.test.ts src/claude/claude-desktop-bridge.test.ts
```

### 未运行项与启用条件

| 项目 | 本轮状态与后续通过条件 |
| --- | --- |
| 关闭 Bridge 窗口后新投递 | 未运行：未操作正在使用的已安装 Bridge 窗口或已配对客户端。现有 service QA 仅证明隔离 Native fixture 的后台存活；需分别在关窗隐藏及“退出窗口（任务继续）”之后通过真实 Bridge 提交新 UUID，并核对服务 PID 和 Desktop 接收，不能仅观察旧任务继续 |
| 锁屏投递 | 未运行：没有锁定当前交互式主机或操作已配对手机。需在真实锁屏期间通过已授权 Bridge 客户端提交自有消息，关联提交/原生接收时间与 UUID；唤醒后才收到不算锁屏即时投递 |
| 系统睡眠 | 未运行；锁屏与睡眠不同，需单独记录唤醒/断网行为，不承诺睡眠期间执行 |
| 完整最小工具集 | 未验证：当前合并配置明确仍有未列入项目 allow 的命令和跨会话查询。需对最终允许与拒绝的内建、继承 MCP、子代理、跨会话工具做实际挑战，不能以方法目录或口头拒绝代替 |
| Section | 本阶段未采用分组，不验证保持行为；后续采用时再验证，也不作为权限边界 |
| 自动写记忆、实际服务端模型版本、生产超时分类 | 未验证；本轮不能据一次未写文件、路由别名或测试 transport 推断这些能力 |

这些缺口使门禁保持关闭。后续 PR 应引用本节并更新目标环境、实际配置、原消息 UUID、
成功/拒绝结果和未运行项，满足[安全启用条件](SECURITY.md#外部邮件自动投递门禁)
后才能启用自动处理；不为补证据添加自动重发、恢复循环或第二条执行队列。

## Cleanup boundary

The runners append the checkout's `scripts/recycle-cleanup.cjs` to `NODE_OPTIONS`,
keeping existing options. Paths are resolved at runtime and quoted for checkouts
containing spaces. On first load the preload creates a fresh private temporary
root, records its exact path in `BRIDGE_TEST_TEMP_ROOT`, and points `TMPDIR`, `TEMP`
and `TMP` there. Children inherit that root; only its creator deletes the root on
exit. Windows distributed CI creates its own fresh root before uploading the
bundle/script and passes it to the Windows leg. A standalone Windows leg creates
and cleans its own root. Do not register a pre-existing directory, the system temp
directory, a reused CI slot, or a name prefix as disposable.

Node's sync, promise and callback `rm`, `unlink` and `rmdir` APIs use their original
delete implementation only for this root and its descendants. Physical parent paths
are checked so a directory symlink cannot authorize deletion of an external target.
All other paths go directly to the OS Recycle Bin, including old JUnit reports,
`dist/`, installer outputs, user files and retained `artifacts/` or `output/`
evidence. They are never renamed into disposable staging. Missing paths are ignored
only with `force: true`; unsupported recycle systems, missing recycle commands and
recycle failures surface as errors, without a permanent-delete fallback. The host
platform is captured before tests can mock `process.platform`.

`BRIDGE_RECYCLE_STAGING` is now only caller-owned Windows QA scratch inside the
fresh run root. QA leaves it to that caller. Standalone Windows QA directly removes
only its own GUID-named profile, smoke and install-copy directories after stopping
its processes (and uninstalling on hosted Windows). Original installers and
retained evidence remain outside those directories. Historical staging is neither
registered nor scanned for cleanup.

The preload covers Node processes that inherit `NODE_OPTIONS`; it does not intercept
native tools, shell commands, browser internals or processes that discard the
environment. Manual cleanup and all other deletion paths still use OS Trash.

## CI

Routine pull requests and `main` merges are verified locally via `npm run ci:local`,
which runs the full multi-platform matrix across Mac M4, Windows 11, and Android API 36
WHPX Emulator without spinning up redundant GitHub-hosted
runners. Upon a full clean pass (after owned temporary-directory cleanup completes),
`local-ci.mjs` records a receipt under `<git-common-dir>/local-ci/` and publishes the
`ci/local-distributed = success` commit status to `Lycidas97/claude-desktop-bridge`
(if `ci:local` ran before `git push`, `npm run ci:local -- --publish` publishes that
receipt immediately after pushing). Every run, passing or failing, also keeps its full
output in `<git-common-dir>/local-ci/logs/<sha12>-<UTC time>.log` (path printed on the
first line), so callers do not need to redirect it.

`.github/workflows/ci.yml` is retained as a manual `workflow_dispatch` fallback that
runs the full 6-job hosted matrix (`changes`, Linux `verify`, Windows installers,
Android, macOS unit tests, and browser E2E) gated by `Quality gate` (all six
jobs must succeed; failed, cancelled, or skipped jobs fail the gate). Native Desktop
unit fixtures explicitly simulate macOS while mocking their process and inbox
dependencies. POSIX mode-bit assertions apply on macOS/Linux; Windows skips the two
real child-process tests that require POSIX signal reporting in exit events. Test
reports and build artifacts upload with `if: always()`, including after failures.
Release workflows (`release.yml` and `release-assets.yml`) require the target `main`
commit to be an ancestor of `origin/main` and carry either `ci/local-distributed == "success"`
or a completed, successful `main` `CI` workflow run for that exact 40-char SHA.
