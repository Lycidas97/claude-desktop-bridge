import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { ClaudeDesktopBridge } from './claude-desktop-bridge.js';

const [mode, count] = process.argv.slice(2);
const pages = Number(count);
const refs = [];
let calls = 0;
let usageCalls = 0;
let resume;
let entered;
const gate = new Promise(resolve => { resume = resolve; });
const reached = new Promise(resolve => { entered = resolve; });
const start = mode === 'cursor' ? 'requested-page' : '';
function rawPage(index) {
  const block = { type: 'thinking', thinking: Buffer.alloc(16384, 65 + index % 20).toString('latin1') };
  refs.push(new WeakRef(block));
  return { hasMore: true, messages: [{ uuid: `old-${index}`, type: 'assistant', message: { content: [block] } }] };
}
const inspector = {
  ready: true, on() {}, supports: name => name === 'getContextUsage',
  async call(method, args) {
    if (method === 'getContextUsage') { usageCalls++; return mode === 'fallback' ? undefined : { totalTokens: 1240 }; }
    assert.equal(method, 'getTranscriptPage');
    const index = calls++;
    assert.equal(args[1], index === 0 ? start : index === 1 ? 'target' : `old-${index - 1}`);
    if (index === 0) return { hasMore: true, messages: Array.from({ length: mode === 'fallback' ? 20 : 1 }, (_, i) => ({
      uuid: i === 0 ? 'target' : `target-${i}`, type: 'assistant', timestamp: 2000,
      message: { id: `visible-${i}`, ...(mode === 'fallback' ? {} : { usage: { input_tokens: 1200, output_tokens: 40 } }),
        content: i ? [] : [{ type: 'text', text: 'target page' }, { type: 'tool_use', id: 'advance', name: 'mcp__ccd_turn__update_plan', input: { advance: true } }] },
    })) };
    if (index === pages + 1) {
      entered(); await gate;
      return { hasMore: true, messages: [{ uuid: `old-${index}`, type: 'assistant', timestamp: 100,
        message: { content: [{ type: 'tool_use', id: 'plan', name: 'mcp__ccd_turn__update_plan',
          input: { scope: 'first_task', items: [{ content: 'first', status: 'in_progress' }, { content: 'second', status: 'pending' }] } }] } }] };
    }
    return rawPage(index);
  },
};
const bridge = new ClaudeDesktopBridge({ inspector, settingsPath: '/synthetic', eventLog: {}, conversationState: {},
  scanCatalog() { throw new Error('Unexpected catalog read'); } });
bridge.native.set('session', { sessionId: 'session', cwd: '/synthetic', isRunning: true });
bridge.projectDirectories.set('/synthetic', { cwd: '/synthetic', realCwd: '/synthetic' });
async function collect() {
  const control = new WeakRef({ independentControl: true });
  for (let i = 0; i < 3; i++) { await setImmediate(); global.gc(); }
  assert.equal(control.deref(), undefined, 'fresh GC control must collect');
  return refs.filter(ref => ref.deref() !== undefined).length;
}
const pending = bridge.history('session', start || undefined, 20);
await reached;
const retained = await collect();
// The current local response may remain live. Superseded pages must not accumulate.
assert(retained <= 1, `unrelated old raw pages retained: ${retained}/${pages}`);
resume();
const result = await pending;
assert.equal(result.nextCursor, 'target');
assert.equal(result.items[0].text, 'target page');
assert.deepEqual(result.items[1].taskPlan.items.map(item => item.status), ['completed', 'in_progress']);
assert.equal(result.items[1].taskPlan.id, 'plan');
assert.equal(calls, pages + (mode === 'fallback' ? 10 : 2));
assert.equal(usageCalls, mode === 'cursor' ? 0 : 1);
assert.equal(await collect(), 0);
assert.equal(result.items[1].taskPlan.id, 'plan');
console.log(JSON.stringify({ mode, pages, retained, released: true, calls, usageCalls }));
