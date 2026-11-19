# Testing

Use Node.js 26 LTS from [`.nvmrc`](../.nvmrc) and the dependencies from `npm ci`.
The minimum compatible Node.js version remains 22.13. Dependency installation runs
without a cleanup preload. Validation requires `/usr/bin/trash` on macOS,
`trash-put` (`trash-cli`) on Linux, or Windows PowerShell and the system Recycle Bin.

| Command | Coverage |
| --- | --- |
| `npm test` | Six sequential Vitest suites in the order listed under Reports, with at most two workers per suite |
| `npm run typecheck` | Workspaces that define `typecheck`, followed by `plugins/magpie-quota` and `plugins/assistant-mail` |
| `npm run lint` | Project-specific static checks in [scripts/lint.mjs](../scripts/lint.mjs). Desktop controller tests use the real constructor through the fixture or directly |
| `npm run verify` | Root lint, typecheck, `npm test`, then the root build. Stops at the first failing stage |
| `npm run test:infra` | Runner and cleanup behavior, lint rule examples, packaged QA contracts, and release workflow checks |
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

Controller unit tests and the Native browser fixture share
[`createControllerFixture`](../apps/desktop/src/controller/controller-fixture.ts).
It runs the controller constructor so tests start with the real publication
caches and event emitter. Each scenario supplies the dependencies
its code path calls. The transport tests also call `initialize()` to exercise
startup with their synthetic broker and socket. The Native browser fixture starts
its own local dependencies and routes requests through the constructed controller.

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

### 阶段 1 托管工作区实机复核

[Issue 222](https://github.com/Lycidas97/claude-desktop-bridge/issues/222)，2026-11-19 UTC：
**部分验证，自动投递保持关闭**。主机是 macOS 27.2（26B123），Claude Desktop 5.11492.5，
原生 `system/init` 和重启版本查询均为 Claude Code 2.1.325。Bridge 是本机签名 dogfood
`1.3.8-dev.18.diag`，安装日志来源 `07de59dd35e6b6d78be313a7477d1f537bd702ee`，
安装包 ASAR SHA-256 `d2c666e18413fc887e93fdf7e56ce16e6fd06e61095d2c3c0a68a255f184d70c`。

本轮从源码的 `WorkspaceProvisioner` 生成隔离工作区，`PreToolUse` 和 stdio MCP 由已安装
Bridge 的 Electron 和 `app.asar/dist` 启动。用真实 Desktop 的 `LocalSessions` 执行；
没有更改生产绑定、启动第二条 Native 事件流或读取业务邮件。配置为 `assistant-runner`、
`dontAsk`、`PreToolUse` `onFailure: "block"`（10 秒）；使用现有绑定的原生 model ID，
其 SHA-256 前 12 位为 `46feb8e13ad1`，未独立核实服务端模型版本。配置摘要不是 Native
最终合并配置取证。

自有会话 `local_8f0fc461-95ab-4cf5-a2ec-d452b5eaa47e` 的 CLI 会话 ID 为
`8939a22f-0267-4d2b-8491-5d47a64935c7`。11:54:17.065 的 init（本地 `/agents` 消息
`ccb89668-0e6b-4f32-85fc-b8c07d682ec5`）显示 7 项工具、无白名单外项；`Task` 按 Native
别名视为 `Agent`，当时邮件 MCP 仍为 `pending`。11:55:59.126 的 init 显示 15 项，
其中 8 项为邮件和议程工具，MCP 为 `connected`，仍无白名单外项。目录与 `connected`
都不是业务调用证据。

#### 真实邮件只读往返

浙大 IMAP 的自有测试邮件在 12:05:51 UTC 提交，`received_at` 为 12:06:15.000，
Bridge SQLite 的 `recorded_at` 为 12:06:35.360，`mailRefId` 为
`90621904-8dd7-430b-837f-5bc7224ea5d5`。没有读取其他邮件、重绑或改变该邮件的 `pending` 状态。

在当前实际托管会话发出一次只读消息 `b9633988-027a-4148-90d4-4d5efea06672`，
Native 于 12:09:14.265 接收，新的 `system/init` 于 12:09:14.292 显示邮件 MCP
`connected`，CLI 会话 ID 为 `8dc0d6a2-22fd-474f-9633-9c71a7acd79c`。新起的 MCP 进程
使用安装包 Electron 和 `app.asar/dist/assistant-mcp.cjs --managed`。仅用 `ToolSearch`
加载指定工具，随后调用一次 `mcp__assistant-mail__mail_read_event`，参数只含上述 `mailRefId`。

| 证据 | UTC 时间 | 记录 |
| --- | --- | --- |
| Native `tool_use` | 12:09:18.378 | `call_00_ET_kyqHfuP0tsRYkoZD1sSC4473`，主会话调用 |
| Gateway `plugin.assistant-mail.tool-invoked` | 12:09:18.594 | `44f4d951-54ca-4c7b-9670-97f4185fe4aa`，`mail.read_event`，事件会话确与实际绑定的 Native 会话相同（ID 的 SHA-256 前 12 位 `55ded5238425`） |
| Native `tool_result` | 12:09:18.607 | 同一调用 ID，`is_error: false`，返回自有测试主题且 `source.authorizesActions: false` |

这证明已安装版的真实收件、内置 MCP 往返和当前主会话归因；不证明其他会话被拒绝、
子代理归因或自动投递。取证不导出邮件正文、账户凭据或会话令牌。

#### 文件守卫与故障

下表的时间均为 UTC。每行调用 ID 与对应 `tool_result.tool_use_id` 相同。文件用例
均属于消息 `deca0bb4-67eb-4a4f-a1b8-87d44eebe001`，Native 于 11:55:59.119 接收。

| 检查 | 调用 → 结果时间 | 调用 ID | 实际结果 |
| --- | --- | --- | --- |
| `Read` 工作区内标记 | 11:56:03.073 → .182 | `call_00_wAG18tSU2O445udKSTh06919` | 成功，返回自有标记 |
| `Write` 新建 `outputs/new-dir/owned-result.txt` | 11:56:03.378 → .498 | `call_01_2dxKMWQesGXcX0cDcos91622` | 成功，核对落盘标记 |
| `Read` 工作区外自有文件 | 11:56:03.715 → .807 | `call_02_oHGMuNZvOAU5GqPuKf2g2415` | 守卫拒绝，`is_error: true` |
| `Write` 新建 `.bridge-uploads/denied-check.txt` | 11:56:03.925 → 11:56:04.010 | `call_03_xkxHF0xfkuYDz3VhqfoJ2461` | 守卫拒绝，文件不存在 |
| `Glob` 不传 `path` | 11:56:04.106 → .192 | `call_04_lUD37HOz5sniWy4wwFcy9317` | 守卫拒绝，`is_error: true` |
| `Grep` 指定无链接的 `fixtures` 子目录 | 11:56:04.422 → .543 | `call_05_nLsgompT7DxWE3INvJ6V7371` | 成功，找到自有标记 |

在同一隔离会话分别冷启动，故障探针只替换隔离工作区的 hook 命令，保留 `onFailure: "block"`
与 10 秒限制。下列三个 `Read` 都以正常可读的工作区内文件为目标；Native 均返回
`is_error: true`，将拒绝归因于 `PreToolUse` 故障，而非模型口头拒绝。

| 守卫故障 | 消息 UUID | 调用 → 拒绝时间 | 调用 ID |
| --- | --- | --- | --- |
| 脚本不存在 | `6aef80d5-a3c2-4af0-9f6e-b1caa7e34232` | 11:56:14.810 → .928 | `call_00_L4FN1rKv7TIqetP9wokz0942` |
| 脚本抛异常 | `6090739e-25b3-46e1-b42e-4ffb5d0b1249` | 11:56:19.892 → 11:56:20.000 | `call_00_6cXsUm8qjw3UFKMA8KgY9327` |
| 脚本超过 10 秒 | `538539a6-b24a-4e11-89d7-eab5e0afbccc` | 11:56:23.742 → 11:56:33.886 | `call_00_ET_D5cpN8zIJHhGV3ywnDhn3858` |

子代理消息 `df5b0917-2d9b-40f2-b53d-a8a7fa408f02` 尝试 `Agent`，调用
`call_00_JpOWJfEOqDTlhzxCHr4W0844` 于 11:56:09.615 发出、.727 被守卫拒绝。
该次未启动子代理，不能证明获准的子代理权限或网关归因。

#### 原生压缩

带自定义指令的 `/compact` 消息 `c9d5c731-acb3-4229-a4eb-886d83a17e2e` 于
11:56:37.327 接收。隔离工作区的 `PreCompact`（11:56:37.420，`trigger: manual`，有
`custom_instructions`）、`SessionStart`（11:56:48.792，`source: compact`）、
`PostCompact`（11:56:48.891，`trigger: manual`）顺序触发，hook 输入的 `session_id`
均等于上述 CLI 会话 ID，不是 Desktop `local_…` ID。Native `compact_boundary` UUID
为 `886e7028-2b19-4f73-ae64-248a7c5d03c0`（11:56:48.684）。压缩后的无工具消息
`e4ed37f4-c856-473f-9cc0-642a09d98e55` 回复同时复述了仅来自 `PreCompact` stdout
与 `SessionStart` 注入的两个标记。未独立读取汇总正文，不能只凭回复定位标记的储存位置。

#### 实体 Android 后台投递

已配对手机安装同源 `Bridge-Android-07de59dd35e6-debug.apk`，APK SHA-256
`f616a7be538ae382dbd715ff3a9000cda36c732d36a739cd088aeffd3f77505c`（构建产物），手机设置
显示 manifest 版本 `1.3.7`。使用独立 Native 会话 `local_9d6a63ae-94df-4e09-b2d2-9a86795693d2`
（CLI `e2ee0e68-5ef9-4f77-8be8-83e34b63b12d`），不是业务会话。下表时间均为 UTC；窗口和锁屏
状态在 Mac 上记录，首收时间取 Bridge `message.delivery`（`origin: mobile`），Native 接收
时间用相同 UUID 的原生用户消息核对，不依赖手机气泡或回复文字。

| Mac 状态 | 状态变化 → Bridge 首收 → Native 接收 | 原消息 UUID | 结果 |
| --- | --- | --- | --- |
| 普通关闭主窗口 | 12:39:14.280 → 12:39:25.137 → 12:39:25.162 | `b17757fa-a531-47d7-868a-e28704535a6f` | 窗口隐藏，UI PID `96777`、服务 PID `96791` 保持；Native 12:39:26.393 完成，手机收到回复 |
| 托盘「退出窗口（任务继续）」 | 12:42:02.552 → 12:42:07.868 → 12:42:07.905 | `916f10f7-1312-40df-b6da-75922b7df153` | UI PID `96777` 退出、服务 PID `96791` 保持；Native 12:42:09.065 完成，手机收到回复 |
| 真实锁屏、窗口进程仍退出 | 12:43:55.546 → 12:44:04.120 → 12:44:04.158 | `dadb4263-de4c-43ce-8350-f25fa91d33f0` | 服务 PID `96791` 保持；Native 12:44:05.131 完成，用户确认手机在 Mac 12:44:13.417 解锁前收到回复 |

三条消息的持久收据均为 `completed`，未重发。锁屏用例由 macOS 会话的锁定标志确认，
期间服务仍持 `NoIdleSleepAssertion`（`Electron`），电源日志未见这段时间发生系统睡眠。
因此是锁屏期间即时接收，不是睡眠或解锁后的补扫。

#### 尚未验收

| 项目 | 本轮证据与缺口 |
| --- | --- |
| 一键初始化与子代理归因 | [早期安装包观察](https://github.com/Lycidas97/claude-desktop-bridge/issues/222#issuecomment-7000436347)记录过初始化和空页往返；本轮未重新初始化已绑定工作区。新版已验证真实邮件只读往返和主会话归因；子代理和其他绑定的拒绝未验证 |
| 工具边界 | 白名单外目录项未出现；没有终端、浏览器预览、定时任务、Shell、外网、继承 MCP 或跨会话工具实际拒绝回执。最终合并配置、获准子代理、原生 `@`、配置及规则写入、符号链接祖先和无路径 `Grep` 尚未验证 |
| 系统强制睡眠和生产断线对账 | 已确认关窗及锁屏的新投递和原 UUID，但没有强制睡眠／唤醒或故意造成生产投递不确定；不能从三条正常收据推断睡眠后补扫或断线时按原 UUID 对账 |
| 自动压缩和故障 | 上述探针只触发手动压缩；自动压缩的 `trigger`、压缩 hook 异常和超时是否影响完成未验证 |
| EventKit | 独立探针初版已用 dogfood 同一证书签名并通过 `codesign --verify --strict`。加入结果记录后重签阻塞，专用签名钥匙串解锁返回 51（密码不被接受）；未改钥匙串设置，也未启动 TCC 请求、读取条目或实测 `EKEventStoreChanged` |

## Cleanup boundary

The runners append the checkout's `scripts/recycle-cleanup.cjs` to `NODE_OPTIONS`,
keeping existing options. Paths are resolved at runtime and quoted for checkouts
containing spaces. On first load the preload creates a fresh private temporary
root, records its exact path in `BRIDGE_TEST_TEMP_ROOT`, and points `TMPDIR`, `TEMP`
and `TMP` there. Children inherit that root; only its creator deletes the root on
exit. Windows distributed CI creates its own fresh root before uploading the
bundle/script and passes it to the Windows leg. The SSH wrapper directly deletes
that root after the leg exits. Cancellation also deletes it after stopping the
run's processes. If a targeted process survives a failed stop, cancellation reports
the error and retains the root. A deletion error fails cleanup. A standalone Windows
leg creates and cleans its own root. Do not register a pre-existing directory, the
system temp directory, a reused CI slot, or a name prefix as disposable.

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
receipt immediately after pushing). If every check passes but the status POST fails
(for example `EOF`), the run exits 1 with the receipt already saved; publish it with
`npm run ci:local -- --publish` instead of rerunning. Every run, passing or failing,
also keeps its full output in `<git-common-dir>/local-ci/logs/<sha12>-<UTC time>.log`
(path printed on the first line), so callers do not need to redirect it.

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
