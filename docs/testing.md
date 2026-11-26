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

1. 按[共享原生桥夹具](../apps/desktop/src/claude/claude-desktop-bridge-fixture.ts)装配
   `ConversationStateStore` 和 `SessionEventLog`，所有路径及随机主密钥只用于自有实验库；`settingsPath` 指向
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
npm run ci:run -- exec -w @bridge/desktop -- vitest run src/claude/claude-desktop-inspector.test.ts src/claude/claude-desktop-bridge-delivery.test.ts
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

这些缺口使当时的门禁保持关闭。用户后来[撤销旧实机启用门禁](https://github.com/Lycidas97/claude-desktop-bridge/issues/222#issuecomment-7011727311)；
上述结果仍按原验证范围记录，不能用夹具结果覆盖未验收项。不为补证据添加自动重发或第二条执行队列。

### 阶段 1 托管工作区实机复核

[Issue 222](https://github.com/Lycidas97/claude-desktop-bridge/issues/222)，2026-11-19 UTC：
**部分验证，自动投递保持关闭**。主机是 macOS 27.2（26B123），Claude Desktop 5.11492.5，
原生 `system/init` 和重启版本查询均为 Claude Code 2.1.325。Bridge 是本机签名 dogfood
`1.3.8-dev.18.diag`，基准提交 `07de59dd35e6b6d78be313a7477d1f537bd702ee`。
`.diag` 表示构建时工作树不干净；用安装包 ASAR SHA-256
`d2c666e18413fc887e93fdf7e56ce16e6fd06e61095d2c3c0a68a255f184d70c` 标识实物，不把
基准提交当作该安装包完整内容的标识。

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
`connected`，CLI 会话 ID 的 SHA-256 前 12 位为 `91f63a4c1ff5`。新起的 MCP 进程使用
安装包 Electron 和 `app.asar/dist/assistant-mcp.cjs --managed`。仅用 `ToolSearch`
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

消息 `df5b0917-2d9b-40f2-b53d-a8a7fa408f02` 请求启动前台 `assistant-helper`。
实际观察到 `Agent` 调用 `call_00_JpOWJfEOqDTlhzxCHr4W0844` 于 11:56:09.615 发出、.727
被守卫拒绝；未核实工具调用的最终参数。该次未启动子代理，不能判断是否拒绝了本应允许
的调用，也不能证明获准子代理的权限或网关归因。

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

用户确认已配对手机安装 `Bridge-Android-07de59dd35e6-debug.apk`；APK 与 Mac `.diag` 包
使用同一基准提交，不据此推断两者构建时的源码一致。APK 构建产物的 SHA-256 为
`f616a7be538ae382dbd715ff3a9000cda36c732d36a739cd088aeffd3f77505c`，手机设置显示 manifest
版本 `1.3.7`。使用独立 Native 会话 `local_9d6a63ae-94df-4e09-b2d2-9a86795693d2`
（CLI `e2ee0e68-5ef9-4f77-8be8-83e34b63b12d`），不是业务会话。下表时间均为 UTC；
Mac 观察器记录窗口和锁屏状态，Bridge `message.delivery`（`origin: mobile`）记录首收，
Native transcript 用同一 UUID 核对接收和完成。未独立记录手机点击发送的时刻，结论仅限于
相应 Mac 状态下接收、完成，不推断客户端的提交时序。

普通关窗的实时观察只记录到窗口隐藏及进程状态。首收时间事后从 Bridge 事件日志按本轮
命令 `330113cb-d5b0-4cd9-9da8-2dffdbea1c84` 和下表原消息 UUID 查得，接收与完成时间从
同一原 UUID 的 Native transcript 补取；另用 SQLite 持久收据确认该命令为 `completed`。

| Mac 状态 | 状态变化 → Bridge 首收 → Native 接收 | 原消息 UUID | 结果 |
| --- | --- | --- | --- |
| 普通关闭主窗口 | 12:39:14.280 → 12:39:25.137 → 12:39:25.162 | `b17757fa-a531-47d7-868a-e28704535a6f` | 窗口隐藏，UI PID `96777`、服务 PID `96791` 保持；Native 12:39:26.393 完成，手机收到回复 |
| 托盘「退出窗口（任务继续）」 | 12:42:02.552 → 12:42:07.868 → 12:42:07.905 | `916f10f7-1312-40df-b6da-75922b7df153` | UI PID `96777` 退出、服务 PID `96791` 保持；Native 12:42:09.065 完成，手机收到回复 |
| 真实锁屏、窗口进程仍退出 | 12:43:55.546 → 12:44:04.120 → 12:44:04.158 | `dadb4263-de4c-43ce-8350-f25fa91d33f0` | 服务 PID `96791` 保持；Native 12:44:05.131 完成，用户确认手机在 Mac 12:44:13.417 解锁前收到回复 |

三条消息的持久收据均为 `completed`，未重发。锁屏用例由 macOS 会话的锁定标志确认，
期间服务仍持 `NoIdleSleepAssertion`（`Electron`），电源日志未见这段时间发生系统睡眠。
因此是锁屏期间即时接收，不是睡眠或解锁后的补扫。

#### 实机短停 Bridge 后台

同日 UTC 独立复核，Mac 使用本机签名的 `1.3.8-dev.22.diag`，基准提交
`0c842f9d8bde2c41a6c396b627656cddb1cf5f37`，安装包 ASAR SHA-256 为
`dc9cc912297bdb27c021076306817d90e29db2d4bdb707b60592ea9fd883d254`。沿用上述实体 Android
与独立 QA 会话，仅安排一次托盘「停止后台服务并退出…」再重开 Bridge。未退出 Claude
Desktop，未操作托管会话或邮箱。

只读观察从 14:08:09.783 开始，14:09:03.672 观察到旧 UI PID `44150` 已退出；
14:09:04.056 观察到旧服务 PID `36498` 也已退出。重开后于 14:09:24.813 观察到新 UI PID
`59116`，14:09:25.945 观察到新服务 PID `59128`。观察至 14:09:56.158，Bridge 事件日志
未见新标记 `QA222-RECONCILE-4B4A9245` 对应的 mobile `host-received`。

按 QA 会话补查整段日志，仅见一条 mobile 首收：重启后 14:09:35.232 收到的是上一观察轮
的标记 `QA222-RECONCILE-37B746A0`，命令 `3507d725-5dae-4989-9f27-1d95d6f81133`，
消息 UUID `2e205b52-eb29-4f00-9abe-0336e40b5155`。Bridge 记录其于 14:09:35.277
`submitted`、14:09:36.647 `completed`，SQLite 持久收据也为 `completed`。这条记录
证明重启后收到并完成了一次正常投递，不能据此推断手机点击时刻或旧标记的来源，也没有
观测到 `uncertain` 或执行对账操作。原 UUID 断线对账仍未验收，不判为通过或失败。

#### 尚未验收

| 项目 | 本轮证据与缺口 |
| --- | --- |
| 一键初始化与子代理归因 | [早期安装包观察](https://github.com/Lycidas97/claude-desktop-bridge/issues/222#issuecomment-7000436347)记录过初始化和空页往返；本轮未重新初始化已绑定工作区。新版已验证真实邮件只读往返和主会话归因；子代理和其他绑定的拒绝未验证 |
| 工具边界 | 隔离会话目录未见白名单外项；没有终端、浏览器预览、定时任务、Shell、外网、继承 MCP 或跨会话工具实际拒绝回执。最终合并配置、获准子代理、原生 `@`、配置及规则写入、符号链接祖先、无路径 `Grep` 以及 `Glob` / `Grep` 的递归结果集尚未验证 |
| 项目规则与自动记忆 | 阶段 0 仅在临时配置上验证了项目规则加载、自动记忆开关及显式读取。本轮未在目标托管配置上验证项目规则加载或实际自动记忆策略；规则文件写入限制不是加载证据 |
| 系统睡眠／唤醒 | 依据用户日常休眠使用、未单独取证；没有安排强制睡眠或验证唤醒补扫，不以锁屏替代 Sleep/Wake |
| 生产断线对账 | 后台短停并重启；仅收到旧标记的正常投递，新标记未首收，没有真实 `uncertain` 收据可供对账，未验收 |
| 自动压缩和故障 | 上述探针只触发手动压缩；自动压缩的 `trigger`、压缩 hook 异常和超时是否影响完成未验证 |

用户已决定[不做 EventKit（日历／提醒事项）适配](https://github.com/Lycidas97/claude-desktop-bridge/issues/222#issuecomment-7010300429)，
不再把它作为阶段 1 门禁项。独立探针初版曾通过同证书 `codesign --verify --strict`；
加入结果记录后，专用签名钥匙串解锁返回 51，未完成重签。未改钥匙串设置、启动探针、
请求 TCC、读取条目或实测 `EKEventStoreChanged`。

## 助理事件唤醒

桌面 dispatcher 测试用 SQLite 和隔离 LocalSessions fixture 覆盖空闲／忙碌投递、socket 未写出或 renderer 重载前置检查拒绝后沿用原收据、用当前 UUID 对账、换绑暂停和 `dontAsk` 回读。重连测试验证断线期间的新邮件和分析写回合并为加密通知，Relay 的 `stored` 回执清除待发送状态。插件测试覆盖同事务提交、历史及开启前邮件不投递、延后启动收件和压缩 hook 的本机认证。桌面测试用 101 条未结邮件验证恢复文本上限与分页续查。

浏览器 `assistant-mail` 场景验证显式开启与关闭、两封新邮件形成一条时间线批次及独立处理状态。收件列表不可用或只加载半批时，时间线都能取齐同样两张卡，并按原回执撤回 Native 排队批次。

这些检查使用隔离数据。真实邮箱自动触发、物理手机唤醒、安装态无参 `/compact`、自动压缩和 hook 故障的影响需实机取证。此前手动带 focus 的探针见上节。

## 阶段 3 受控记忆门禁

[#217](https://github.com/Lycidas97/claude-desktop-bridge/issues/217)，2026-11-19 UTC。**生产仍使用 `stage1-fenced-workspace`。** 实验目标为 macOS 27.2（26B123）、Claude Desktop 5.11492.5、Native `system/init` 记录的 Claude Code 2.1.325。工作树生成守卫和 MCP，再将其放入隔离 `app.asar/dist`，由已安装的 Bridge 1.3.8-dev.22.diag 的 Electron 可执行文件以 `ELECTRON_RUN_AS_NODE=1` 启动；不是替换安装包。邮箱、令牌和数据目录均为独立夹具；没有改生产绑定或启动第二条 Native 事件订阅。

隔离 Native 会话 `local_81b57a8e-112c-48b5-aad4-1636161ef011` 的 `app.asar` SHA-256 为 `2f348361b4bb452df0f92ff3b8adfaa0ddaa4954a993f6ba410395a65eea93c3`。取证包只包含三个 hook/MCP 脚本；不据此证明正式打包安装后整个服务行为一致。用同一 Native 会话升级并冷启动，核对工具回执与落盘，而不依赖模型自报：

| 测试消息 UUID | 观察结果 |
| --- | --- |
| `1fba0b32-9aec-4979-a00f-94b525bbfe80` | 阶段 1 在未存在的子目录创建 `outputs/initial/export.txt`。 |
| `73191515-b005-4890-bb60-6bb3908b7f78` | 阶段 3 从项目规则读到 `PROFILE.md` 中未出现在提示里的测试标记，常规 Read/Write 成功。拒绝工作区外 Read 和主会话写资料；不带 `path` 的 `Glob`/`Grep` 在含凭据配置的根目录被拒。 |
| `9326733d-8c1c-460d-a1fe-4b1a147dbd28` | 子代理挂钩收到 `agent_type: memory-curator` 和 `agent_id`，读成功，分别写入 `threads` 和 `notes`；对越界目录链接和嵌套 `CLAUDE.md` 的写入返回守卫拒绝。 |
| `6f47b2ec-8bd8-46bf-b58a-4c20e0f4eb4a` | 邮件和日程子代理各有可归因的 Read，两个目标写文件均不存在。Native 没发出这两个角色的 Write 调用，不把未发出当作守卫拒绝回执。 |
| `03069c3f-2d2d-4881-98da-b500affabed5` | 恢复阶段 3 配置并冷启动原会话后，`outputs/restarted.txt` 确实写入。 |

同一 ASAR 的第二轮隔离会话 `local_fe6d0fca-4df2-4bc2-b86e-97ac445b471e` 补测了查找、压缩和故障闭锁：

| 测试消息 UUID | 观察结果 |
| --- | --- |
| `322882c9-6ffd-46df-aeac-55e94267303e` | `memory.lookup_entry` 返回宿主索引 ID 对应的相对路径，Native 随后读取了该线程资料。 |
| `4ba12068-cf04-4cec-9557-91d89a20aec7` | 手动 `/compact` 产生 Native 压缩边界。`PreCompact` 和 `SessionStart(compact)` 都与原 CLI 会话匹配，注入规则版本和索引 ID，未带入测试笔记正文。`PostCompact` 回执成功，未注入资料。 |
| `fe1ddc7f-1c65-4ca9-ab93-9950c063e2c5` | 冷启动原会话后，`outputs/restarted.txt` 确实写入。 |
| `3b2f8c6b-907e-4cf7-a2e3-cfd950332358`、`29d5abc9-588e-425e-8d1c-dbd3953add31`、`a21b5418-4049-4e37-a781-44ab0f829d26` | 守卫脚本缺失、异常和超时分别阻断了主会话与 `memory-curator` 对同一正常文件的 Read，六次均有 Native 工具错误回执。 |
| `3be7422a-53b2-467b-8f2a-e9363158c6d9` | 添加显式 MCP 引用前，`memory-curator` 调用 `ToolSearch`，账本没有新增规则草稿。 |

专职子代理的定义显式引用父会话的 `assistant-mail` MCP 后，用同一 ASAR 在新隔离会话 `local_554d9bd2-dbdb-4c59-928f-d866b253f822` 复测。消息 `d081a4f6-d498-4394-922e-90c660771352` 中，`memory-curator` 的 `ToolSearch` 找到 `proposal_create`，随后 Native 子代理工具回执和守卫均返回成功。账本新增一条 `memory.rule_upsert` 待确认提案，`PROFILE.md` 与提交前逐字节相同。另一轮消息 `e55b24e6-9b33-40dc-bf14-85f68ce3f9d1` 中，模型找到同一工具后结束回合，未发出调用。

额外压缩探针 `983f4158-90fc-49c5-8a06-ab5194f826f4` 和 `4d16f9c2-18d3-4c14-a67e-e059ff4493d9` 对照了 hook 返回值与磁盘数据。`PreCompact` 与 `SessionStart(compact)` 均包含准确的规则哈希与索引 ID，未包含测试文件名或正文。消息 `b85b40b1-b2a2-46fb-bf79-d615d0a2ff59` 中，模型未调用工具即复述了准确的恢复 ID。消息 `035cf63d-7851-4fc4-91b9-a2d47897a14a` 和 `99d753ca-08d7-47e5-a5f7-6cf61d061618` 均在 `ToolSearch` 后结束，未发出查找调用。

随后在隔离会话 `local_cc12ff29-bde5-4d0b-8380-aebc182e46c3` 将操作拆成独立回合。`a7fd3258-3a3e-4805-a18d-32b378608234` 产生压缩边界，`88c6ebdc-4e56-4f49-88f5-7eda64f4a4e3` 无工具复述恢复 ID，`a0aafa24-abe0-4510-a475-27988c20e311` 传入该 ID 并收到相对路径，`c1eb83e0-f621-461a-bb5a-cc63e042abb1` 的 Read 回执包含测试笔记标记。提示未提供 ID、文件名或正文。

评审后重建隔离 ASAR（SHA-256 `d172755134d77d08ff160dd3abb98e0480f99080e8ad5fe7b509640a147ff5c4`）。第一轮探针 `3573838b-f38c-41ab-9837-4225961c33ba` 找到 `proposal_create` 后结束。将工具发现拆为独立回合后，消息 `d9d39cd5-19ef-4809-968f-023783d2aa1f` 中的 `memory-curator` 得到成功回执，账本新增一条规则草稿，`PROFILE.md` 逐字节相同。

定向测试验证安全子目录的缺省路径搜索、不同角色的拒绝、外部编辑冲突和基准／结果哈希恢复。评审后新增用例覆盖普通 `index.md` 成果导出、`memory/` 父目录被替换为链接、临时文件创建遇到 `ENOSPC`、CRLF 规则更新和删除，以及绑定会话在普通 Native 回合结束后刷新索引。

浏览器 `assistant-proposals` 在明暗主题用 Desktop 请求和配对手机 RPC 走真实 Controller 和持久提案账本。旧版请求仍可读议程提案，规则提案在列表和引用解析中隐藏，直接提交旧版确认请求会被拒。支持规则审批的客户端显示前后差异并提交显式确认后，隔离 `PROFILE.md` 才会更新。真实 Windows、完整安装包和实体手机审批未取证。

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
