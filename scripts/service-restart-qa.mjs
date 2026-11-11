// Real compiled Electron Bridge UI/service; simulated Node inspector + Desktop LocalSessions.
// This checks the Bridge service boundary, not real Claude Desktop end-to-end execution.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createContext, runInContext } from 'node:vm';
import { WebSocket, WebSocketServer } from 'ws';
import { _electron } from 'playwright-core';
import { verifyInspectorMonitor } from './claude-inspector-monitor-qa.mjs';

const repo = resolve(import.meta.dirname, '..');
const dist = join(repo, 'apps/desktop/dist');
const compiledMainHash = createHash('sha256').update(await readFile(join(dist, 'main.cjs'))).digest('hex');
await mkdir(join(repo, 'output'), { recursive: true });
const root = await mkdtemp(join(repo, 'output/service-restart-'));
const application = join(root, 'app');
const home = join(root, 'home');
const userData = join(root, 'user-data');
const project = join(root, 'project');
const profiles = join(home, 'Library/Application Support');
const officialPath = join(profiles, 'Claude/developer_settings.json');
const targetPath = join(profiles, 'Claude-3p/developer_settings.json');
const originalDeveloperSettings = '{ "allowDevTools": false, "other": { "theme": "dark" } }\n';
const scanAuditPath = join(root, 'monitor-scans.jsonl');
const developerProof = {};
await Promise.all([
  cp(dist, application, { recursive: true }),
  mkdir(join(home, '.claude'), { recursive: true }),
  mkdir(join(home, 'app-data'), { recursive: true }),
  mkdir(userData), mkdir(project),
  ...(process.platform === 'darwin' ? [mkdir(join(profiles, 'Claude'), { recursive: true }), mkdir(join(profiles, 'Claude-3p'), { recursive: true })] : []),
]);
if (process.platform === 'darwin') {
  await writeFile(officialPath, originalDeveloperSettings);
  await writeFile(targetPath, originalDeveloperSettings);
}
await writeFile(join(home, '.claude/settings.json'), '{"env":{"BRIDGE_QA_ISOLATED_SETTINGS":"preserve"}}\n');
await writeFile(join(application, 'package.json'), JSON.stringify({ name: 'bridge-service-restart-qa', version: '1.0.0', main: 'bootstrap.cjs' }));
await writeFile(join(application, 'bootstrap.cjs'), `
const {app}=require('electron');
const os=require('node:os');const fs=require('node:fs');
if(process.argv.includes('--bridge-service')) {
  fs.writeFileSync(${JSON.stringify(join(root, 'service.pid'))},String(process.pid));
  if(process.platform==='darwin') {
    const prototype=require('node:child_process').ChildProcess.prototype;
    const spawn=prototype.spawn;
    prototype.spawn=function(options) {
      if(options.file==='/usr/sbin/lsof')this.once('exit',(code,signal)=>fs.appendFileSync(${JSON.stringify(scanAuditPath)},JSON.stringify({pid:process.pid,inspectorUrl:process.env.BRIDGE_CLAUDE_INSPECTOR_URL,code,signal})+'\\n'));
      return spawn.call(this,options);
    };
  }
}
os.homedir=()=>${JSON.stringify(home)};require('node:module').syncBuiltinESMExports();
app.setName('Bridge Service Restart QA');
app.setPath('home',${JSON.stringify(home)});app.setPath('appData',${JSON.stringify(join(home, 'app-data'))});
app.setPath('userData',${JSON.stringify(userData)});
require('./main.cjs');
`);

async function waitFor(read, predicate, description, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(value)}`);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function nativeDesktopFixture() {
  const sessionId = randomUUID();
  const requestId = randomUUID();
  const taskId = 'qa-native-background-task';
  const native = {
    sessionId, cwd: project, title: 'Native service lifecycle QA', model: 'qa-native-model', permissionMode: 'default',
    createdAt: Date.now(), lastActivityAt: Date.now(), isRunning: false, turnRunning: false,
    hasBackgroundWork: false, pendingToolPermissions: [], queuedMessages: [],
  };
  const calls = [];
  const messages = [];
  const events = new Set();
  const permissions = new Set();
  const errors = [];
  let taskState = 'idle';
  let discoveryCount = 0;
  const api = {
    getAll: () => [native],
    getSession: () => native,
    getSupportedCommands: () => [],
    getTranscript: () => messages,
    getTranscriptPage: () => ({ messages, hasMore: false }),
    getTranscriptTail: () => messages,
    getAvailableCodeModels: () => [{ value: native.model, displayName: native.model }],
    sendMessage: (...args) => { calls.push({ method: 'sendMessage', args }); },
    setModel: (id, model) => { assert.equal(id, sessionId); native.model = model; },
    setEffort: (id, effort) => { assert.equal(id, sessionId); native.effort = effort; },
    setPermissionMode: (id, mode) => { assert.equal(id, sessionId); native.permissionMode = mode; },
    interrupt: (...args) => {
      calls.push({ method: 'interrupt', args });
      native.turnRunning = native.isRunning = native.hasBackgroundWork = false;
      taskState = 'stopped';
    },
    stopTask: (...args) => { calls.push({ method: 'stopTask', args }); taskState = 'stopped'; native.hasBackgroundWork = false; },
    respondToToolPermission: (...args) => {
      assert.equal(args[0], requestId, 'Permission must retain the native requestId');
      assert.equal(native.pendingToolPermissions.length, 1);
      calls.push({ method: 'respondToToolPermission', args: structuredClone(args) });
      native.pendingToolPermissions = [];
    },
    onOnEvent: callback => { events.add(callback); return () => events.delete(callback); },
    onOnToolPermissionRequest: callback => { permissions.add(callback); return () => permissions.delete(callback); },
  };
  const renderer = createContext({ 'claude.web': { LocalSessions: api } });
  const page = { id: 42, getURL: () => 'app://localhost/epitaxy/native-service-qa', executeJavaScript: source => runInContext(source, renderer) };
  const main = createContext({ process: { mainModule: { require: name => {
    assert.equal(name, 'electron');
    return { webContents: { getAllWebContents: () => [page], fromId: id => id === page.id ? page : undefined } };
  } } } });
  const server = createServer((request, response) => {
    if (request.url !== '/json/list') { response.writeHead(404); response.end(); return; }
    discoveryCount++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify([{ type: 'node', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/native-inspector` }]));
  });
  const sockets = new WebSocketServer({ server, path: '/native-inspector' });
  sockets.on('connection', socket => socket.on('message', async data => {
    const request = JSON.parse(String(data));
    try {
      assert.equal(request.method, 'Runtime.evaluate');
      const value = await runInContext(request.params.expression, main);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: request.id, result: { result: { value } } }));
    } catch (error) {
      errors.push(String(error));
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: request.id, result: { exceptionDetails: { exception: { description: String(error) } } } }));
    }
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const emit = message => {
    messages.push(message);
    native.lastActivityAt = Date.now();
    for (const callback of events) callback({ sessionId, session: native, message });
  };
  return {
    sessionId, requestId, taskId, native, calls, errors,
    origin: `http://127.0.0.1:${server.address().port}`,
    get taskState() { return taskState; },
    get discoveryCount() { return discoveryCount; },
    get subscriptions() { return [events.size, permissions.size]; },
    start(messageId) {
      native.turnRunning = native.isRunning = native.hasBackgroundWork = true;
      taskState = 'running';
      emit({ type: 'user', uuid: messageId, timestamp: Date.now(), message: { role: 'user', content: 'Keep native work alive across Bridge restarts' } });
      emit({ type: 'command_lifecycle', command_uuid: messageId, state: 'started', timestamp: Date.now() });
      emit({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: 'qa-native-agent-tool', description: 'Native background work', timestamp: Date.now() });
      const permission = { sessionId, requestId, cliToolUseId: 'qa-native-bash-tool', toolName: 'Bash', input: { command: 'native-fixture-noop' }, requestedAt: Date.now() };
      native.pendingToolPermissions = [permission];
      for (const callback of permissions) callback(permission);
    },
    complete(messageId) {
      assert.equal(native.pendingToolPermissions.length, 0);
      native.turnRunning = native.isRunning = native.hasBackgroundWork = false;
      taskState = 'completed';
      emit({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: 'qa-native-agent-tool', status: 'completed', summary: 'Native task completed', timestamp: Date.now() });
      emit({ type: 'assistant', uuid: randomUUID(), timestamp: Date.now(), message: { id: 'qa-native-assistant', role: 'assistant', content: [{ type: 'text', text: 'Native completion after Bridge restart' }] } });
      emit({ type: 'result', uuid: randomUUID(), user_message_uuid: messageId, is_error: false, result: 'Native completion after Bridge restart', timestamp: Date.now() });
    },
    async close() {
      runInContext("globalThis['__claudeBridgeNativeStreamV1']?.dispose()", renderer);
      for (const socket of sockets.clients) socket.terminate();
      await new Promise(resolveClose => sockets.close(() => server.close(resolveClose)));
    },
  };
}

async function connectService() {
  const address = JSON.parse(await readFile(join(userData, 'background-service/connection.json'), 'utf8'));
  assert.equal(address.protocol, 1);
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, { headers: { Authorization: `Bearer ${address.token}` } });
  const pending = new Map();
  let nextId = 0;
  let servicePid;
  socket.on('message', data => {
    const message = JSON.parse(String(data));
    if (message.kind === 'hello') servicePid = message.pid;
    if (message.kind !== 'response') return;
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  socket.on('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Service connection closed')); }
    pending.clear();
  });
  await once(socket, 'open');
  await waitFor(() => servicePid, Boolean, 'service hello');
  return {
    pid: servicePid,
    call(method, ...args) {
      const id = ++nextId;
      return new Promise((resolveCall, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Service ${method} timed out`)); }, 20_000);
        pending.set(id, { resolve: resolveCall, reject, timer });
        socket.send(JSON.stringify({ id, method, args }));
      });
    },
    close() { socket.close(); },
  };
}

const desktop = await nativeDesktopFixture();
const environment = {
  ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
  CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'),
  BRIDGE_USER_DATA: userData, BRIDGE_SERVICE_DATA_PATH: userData, BRIDGE_CLAUDE_INSPECTOR_URL: desktop.origin,
  BRIDGE_RELAY_URL: 'ws://127.0.0.1:1/ws', BRIDGE_PUBLIC_RELAY_URL: '',
  BRIDGE_PAIRING_BASE_URL: 'http://127.0.0.1:1', BRIDGE_SERVICE_ORIGIN: 'http://127.0.0.1:1', BRIDGE_ICE_SERVERS: '[]',
  BRIDGE_CODEX_APP_SERVER_PATH: join(root, 'unavailable-codex'), BRIDGE_HERMES_EXECUTABLE: join(root, 'unavailable-hermes'),
  BRIDGE_HERMES_GATEWAY_URL: 'http://127.0.0.1:1', BRIDGE_DSH_GATEWAY_URL: 'http://127.0.0.1:1',
};
for (const name of Object.keys(environment)) {
  if (name.startsWith('ANTHROPIC_') || name.startsWith('CLAUDE_CODE_') || ['BRIDGE_CLAUDE_PATH', 'BRIDGE_DEV_SERVER_URL', 'ELECTRON_RUN_AS_NODE'].includes(name)) delete environment[name];
}
const uiErrors = [];
let ui;
let client;
const servicePids = [];
const checkpoints = [];

async function launchUI() {
  const instance = await _electron.launch({
    executablePath: join(repo, 'node_modules/electron/dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [application, '--bridge-packaged-qa'], env: environment, timeout: 45_000,
  });
  ui = { instance };
  ui.page = await waitFor(() => instance.windows().find(page => page.url().startsWith('file:')), Boolean, 'compiled renderer window', 45_000);
  ui.page.on('pageerror', error => uiErrors.push(String(error)));
  await ui.page.waitForFunction(async sessionId => Boolean((await window.bridgeDesktop?.getSnapshot())?.sessions.some(session => session.sessionId === sessionId)), desktop.sessionId, { timeout: 45_000 });
  await ui.page.getByRole('button', { name: '会话', exact: true }).click();
  return ui.page.evaluate(() => window.bridgeDesktop.getSnapshot());
}

async function dispatch(request) {
  const response = await client.call('dispatchLocal', request);
  assert.equal(response.ok, true, response.error?.message);
  return response.result;
}

function assertNativeStillRunning(label) {
  assert.equal(desktop.native.turnRunning, true, label);
  assert.equal(desktop.taskState, 'running', label);
  assert.equal(desktop.native.pendingToolPermissions[0]?.requestId, desktop.requestId, label);
  assert.deepEqual(desktop.calls.filter(call => ['interrupt', 'stopTask'].includes(call.method)), [], label);
  checkpoints.push(label);
  console.log(`PASS ${label}`);
}

try {
  console.log(`Bridge service QA: compiled Electron + simulated Desktop boundary; artifacts ${root}`);
  const inspectorCheck = process.platform === 'darwin' ? await verifyInspectorMonitor(root) : undefined;
  const initial = await launchUI();
  client = await connectService();
  servicePids.push(client.pid);
  const originalServicePid = client.pid;
  const hostId = initial.host.hostId;
  assert.ok(initial.host.capabilities.includes('claude.native-relay.v1'));
  assert.equal(initial.sessions.find(session => session.sessionId === desktop.sessionId).transport, 'claude-desktop-native');
  if (inspectorCheck) {
    const page = ui.page;
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: 'Claude 接入', exact: true }).click();
    const card = page.getByRole('region', { name: 'Claude Desktop 开发者工具' });
    const enable = card.getByRole('button', { name: '一键开启', exact: true });
    const check = card.getByRole('button', { name: '重新检查', exact: true });
    await card.getByLabel('配置目录').waitFor();
    assert.equal(await enable.isDisabled(), true, 'Two profiles require an explicit choice');
    assert.equal(await readFile(targetPath, 'utf8'), originalDeveloperSettings, 'Checking must not write');
    await card.getByLabel('配置目录').selectOption('Claude-3p');
    await card.getByRole('status').filter({ hasText: '配置未开启' }).waitFor();
    await enable.click();
    await card.getByRole('status').filter({ hasText: '配置已开启，重启 Claude Desktop 后生效。' }).waitFor();
    assert.deepEqual(JSON.parse(await readFile(targetPath, 'utf8')), { allowDevTools: true, other: { theme: 'dark' } });
    assert.equal(await readFile(officialPath, 'utf8'), originalDeveloperSettings, 'The other profile must not change');
    assert.equal(await enable.isDisabled(), true);
    const enabledTime = (await stat(targetPath)).mtimeMs;
    await check.click();
    await card.getByRole('status').filter({ hasText: /^配置已开启$/ }).waitFor();
    assert.equal((await stat(targetPath)).mtimeMs, enabledTime, 'An enabled file must not be rewritten');
    await page.screenshot({ path: join(root, 'developer-enabled.png'), fullPage: true });
    await writeFile(targetPath, '{broken');
    await check.click();
    await card.getByRole('alert').waitFor();
    assert.equal(await enable.isEnabled(), true, 'A failed check must not lock the action');
    await enable.click();
    await card.getByRole('alert').filter({ hasText: '不是有效 JSON' }).waitFor();
    assert.equal(await readFile(targetPath, 'utf8'), '{broken');
    await page.screenshot({ path: join(root, 'developer-invalid-json.png'), fullPage: true });
    await card.getByLabel('配置目录').selectOption('Claude');
    await card.getByRole('status').filter({ hasText: '配置未开启' }).waitFor();
    assert.equal(await enable.isEnabled(), true);
    const snapshot = await page.evaluate(() => window.bridgeDesktop.getSnapshot());
    assert.ok(snapshot.claudeInspector, 'The service must start the monitor');
    assert.notEqual(snapshot.claudeInspector.state, 'error', snapshot.claudeInspector.error);
    // Display the independently measured TCP fixture through the actual renderer IPC.
    await ui.instance.evaluate(({ webContents }, next) => {
      for (const contents of webContents.getAllWebContents()) if (contents.getURL().startsWith('file:')) contents.send('bridge:snapshot', next);
    }, { ...snapshot, claudeInspector: inspectorCheck.status });
    await page.getByText('Claude 调试接口存在未认可的进程连接', { exact: true }).waitFor();
    const monitorRegion = page.getByRole('region', { name: '调试连接监测' });
    await monitorRegion.getByText(`PID ${process.pid} · node · 未认可路径`, { exact: true }).waitFor();
    assert.ok((await monitorRegion.textContent()).includes(inspectorCheck.proof.fullNodePath));
    await page.screenshot({ path: join(root, 'inspector-banner.png'), fullPage: true });
    await monitorRegion.locator('summary').click();
    await monitorRegion.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(root, 'inspector-warning.png'), fullPage: true });
    await ui.instance.evaluate(({ webContents }, next) => {
      for (const contents of webContents.getAllWebContents()) if (contents.getURL().startsWith('file:')) contents.send('bridge:snapshot', next);
    }, { ...snapshot, claudeInspector: { ...inspectorCheck.status, clients: [] } });
    await page.waitForFunction(() => !document.querySelector('.inspector-warning'));
    assert.ok((await monitorRegion.textContent()).includes('最近告警'));
    Object.assign(developerProof, {
      profileSelection: true, realIpcWrite: true, fieldsPreserved: true, otherProfileUnchanged: true,
      checkIsReadOnly: true, enabledNotRewritten: true, invalidJsonPreserved: true, errorRecovery: true,
      backgroundMonitorStarted: true, bannerUsesInjectedTcpFixture: true, monitorPathsVisible: true,
      monitorAlertHistoryVisible: true, inspector: inspectorCheck.proof,
    });
    await page.getByRole('button', { name: '会话', exact: true }).click();
    checkpoints.push('developer settings and monitor display coexist with isolated Native sessions');
    console.log('PASS developer settings, real TCP/helper and injected monitor UI');
  }
  const request = { method: 'turn.start', params: { sessionId: desktop.sessionId, text: 'Keep native work alive across Bridge restarts' }, idempotencyKey: randomUUID() };
  const receipt = await dispatch(request);
  assert.equal(receipt.state, 'submitted');
  assert.equal(desktop.calls.filter(call => call.method === 'sendMessage').length, 1);
  const messageId = desktop.calls.find(call => call.method === 'sendMessage').args[7];
  assert.equal(typeof messageId, 'string');
  assert.equal((await dispatch({ method: 'events.resume', params: { afterSeq: 0, sessionId: desktop.sessionId } })).events.some(event => event.type === 'turn.started'), false, 'RPC acknowledgement must not invent a native turn start');
  desktop.start(messageId);
  await waitFor(() => client.call('snapshot'), snapshot => snapshot.permissions.some(permission => permission.requestId === desktop.requestId) && snapshot.sessions.some(session => session.sessionId === desktop.sessionId && session.runningSubagents?.count === 1), 'native task and permission projection');
  await waitFor(() => dispatch({ method: 'events.resume', params: { afterSeq: 0, sessionId: desktop.sessionId } }), result => result.events.some(event => event.type === 'turn.started' && event.data.commandId === receipt.commandId), 'indexed native turn start');
  await ui.page.screenshot({ path: join(root, 'native-running.png'), fullPage: true });
  await ui.instance.close(); ui = undefined;
  if (inspectorCheck) {
    const before = (await readFile(scanAuditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const after = await waitFor(async () => (await readFile(scanAuditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), records => records.filter(record => record.pid === originalServicePid).length >= before.filter(record => record.pid === originalServicePid).length + 2, 'two completed monitor scans after closing UI');
    const scans = after.filter(record => record.pid === originalServicePid);
    assert.ok(scans.every(record => record.inspectorUrl === desktop.origin && [0, 1].includes(record.code) && record.signal === null));
    assert.notEqual((await client.call('snapshot')).claudeInspector.state, 'error');
    Object.assign(developerProof, { backgroundMonitorContinuesScanning: true, backgroundPid: originalServicePid, inspectorUrl: desktop.origin, scansBeforeClose: before.length, scansAfterClose: after.length });
    await writeFile(join(root, 'developer-proof.json'), JSON.stringify(developerProof, null, 2) + '\n');
    checkpoints.push('same background completes two monitor scans after UI closes');
    console.log('PASS same background continues monitor scans with the isolated inspector URL');
  }
  assert.equal(isAlive(originalServicePid), true);
  assertNativeStillRunning('normal UI close preserves native task and permission');

  const reconnected = await launchUI();
  assert.ok(reconnected.permissions.some(permission => permission.requestId === desktop.requestId));
  assert.equal(client.pid, originalServicePid);
  assertNativeStillRunning('UI reconnect retains native requestId');
  const crashedProcess = ui.instance.process();
  const crashedExit = once(crashedProcess, 'exit');
  crashedProcess.kill('SIGKILL');
  await crashedExit; ui = undefined;
  assert.equal(isAlive(originalServicePid), true);
  assertNativeStillRunning('UI crash preserves native task and permission');
  assert.ok((await launchUI()).permissions.some(permission => permission.requestId === desktop.requestId));
  await ui.instance.close(); ui = undefined;

  await client.call('shutdown'); client.close(); client = undefined;
  await waitFor(() => isAlive(originalServicePid), alive => !alive, 'service shutdown');
  await waitFor(() => desktop.subscriptions, subscriptions => subscriptions.every(count => count === 0), 'native subscriptions disposed');
  assertNativeStillRunning('service shutdown only unsubscribes; native execution survives');

  const restarted = await launchUI();
  client = await connectService(); servicePids.push(client.pid);
  assert.notEqual(client.pid, originalServicePid);
  assert.equal(restarted.host.hostId, hostId);
  assert.ok(restarted.permissions.some(permission => permission.requestId === desktop.requestId));
  assert.deepEqual(desktop.subscriptions, [1, 1]);
  assert.equal(desktop.calls.filter(call => call.method === 'sendMessage').length, 1, 'Service restart must not replay input');
  const retried = await dispatch(request);
  assert.equal(retried.commandId, receipt.commandId);
  assert.equal(retried.state, 'running');
  assert.equal(desktop.calls.filter(call => call.method === 'sendMessage').length, 1, 'Persisted idempotency key must not resend');
  assertNativeStillRunning('service restart recovers receipt and native permission without resending');

  const approved = await ui.page.evaluate(requestId => window.bridgeDesktop.request({ method: 'permission.resolve', params: { requestId, decision: 'allow-once' } }), desktop.requestId);
  assert.equal(approved.ok, true, approved.error?.message);
  assert.equal(approved.result.resolved, true);
  assert.deepEqual(desktop.calls.filter(call => call.method === 'respondToToolPermission').map(call => call.args), [[desktop.requestId, 'once', { command: 'native-fixture-noop' }]]);
  assert.equal(desktop.taskState, 'running', 'Permission reply must not manufacture task completion');
  desktop.complete(messageId);
  const completed = await waitFor(() => dispatch({ method: 'events.resume', params: { afterSeq: 0, sessionId: desktop.sessionId } }), result => result.events.some(event => event.type === 'turn.completed' && event.data.commandId === receipt.commandId), 'indexed native completion after restart');
  const { history } = await dispatch({ method: 'session.history', params: { sessionId: desktop.sessionId } });
  assert.ok(history.items.some(item => item.subagent?.agentId === desktop.taskId && item.subagent.state === 'completed'));
  assert.ok(history.items.some(item => item.role === 'assistant' && item.text === 'Native completion after Bridge restart'));
  const resolved = completed.events.find(event => event.type === 'permission.resolved' && event.data.requestId === desktop.requestId);
  assert.equal(resolved?.data.resolvedByDeviceId, hostId);
  assert.equal(resolved.data.resolvedByName, initial.host.name);
  await waitFor(() => ui.page.evaluate(() => window.bridgeDesktop.getSnapshot()), snapshot => snapshot.sessions.some(session => session.sessionId === desktop.sessionId && session.turnState === 'idle') && snapshot.permissions.length === 0, 'completed native state in renderer');
  await ui.page.screenshot({ path: join(root, 'native-completed.png'), fullPage: true });
  await ui.instance.close(); ui = undefined;
  const finalPid = client.pid;
  await client.call('shutdown'); client.close(); client = undefined;
  await waitFor(() => isAlive(finalPid), alive => !alive, 'final service shutdown');
  assert.deepEqual(desktop.calls.filter(call => ['interrupt', 'stopTask'].includes(call.method)), []);
  assert.deepEqual(desktop.errors, []);
  assert.deepEqual(uiErrors, []);
  assert.equal(await readFile(join(home, '.claude/settings.json'), 'utf8'), '{"env":{"BRIDGE_QA_ISOLATED_SETTINGS":"preserve"}}\n');
  assert.equal(createHash('sha256').update(await readFile(join(application, 'main.cjs'))).digest('hex'), compiledMainHash);
  const proof = { ok: true, developerSettings: developerProof, boundary: 'real compiled Electron Bridge UI/service + simulated Node inspector/LocalSessions', compiledMainHash, servicePids, sessionId: desktop.sessionId, requestId: desktop.requestId, commandId: receipt.commandId, messageId, discoveryCount: desktop.discoveryCount, checkpoints, nativeCalls: desktop.calls, nativeTaskState: desktop.taskState, uiErrors };
  await writeFile(join(root, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(`PASS native permission resumes by requestId and native events complete the original receipt\n${JSON.stringify({ ok: true, proof: join(root, 'proof.json'), screenshots: ['native-running.png', 'native-completed.png'].map(file => join(root, file)) }, null, 2)}`);
} catch (error) {
  if (ui?.page && !ui.page.isClosed()) await ui.page.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(failure => console.error(`Failure screenshot: ${failure}`));
  await writeFile(join(root, 'failure.json'), JSON.stringify({ error: String(error.stack ?? error), nativeCalls: desktop.calls, native: desktop.native, taskState: desktop.taskState, inspectorErrors: desktop.errors, uiErrors }, null, 2));
  console.error(`FAIL artifacts ${root}`);
  throw error;
} finally {
  if (ui) await ui.instance.close();
  if (client) { if (isAlive(client.pid)) await client.call('shutdown'); client.close(); }
  const lastServicePid = await readFile(join(root, 'service.pid'), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  for (const pid of new Set([...servicePids, ...(lastServicePid ? [Number(lastServicePid)] : [])])) {
    if (isAlive(pid)) { process.kill(pid, 'SIGTERM'); await waitFor(() => isAlive(pid), alive => !alive, 'fixture service cleanup'); }
  }
  await desktop.close();
}
