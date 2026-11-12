import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createPlugin } from './cbm-augment.mjs';

const envelope = extra => JSON.stringify({ hookSpecificOutput: {
  hookEventName: 'PreToolUse', additionalContext: extra,
} });
function fixture({ text = envelope('graph context'), code = 0, hanging = false,
  stdinError = false, spawnError = false, ...options } = {}) {
  const calls = [], warnings = [], children = [];
  let callback, registrations = 0, disposals = 0;
  const ctx = { location: { directory: '/synthetic/project' }, tool: {
    async hook(name, cb) { assert.equal(name, 'execute.after'); callback = cb; registrations++;
      return { async dispose() { disposals++; } }; },
  } };
  const plugin = createPlugin({ timeoutMs: 30, warn: x => warnings.push(x),
    spawnImpl(binary, argv, opts) {
      calls.push({ binary, argv, opts });
      const child = new EventEmitter(); children.push(child);
      child.pid = 123; child.exitCode = null; child.stdout = new PassThrough();
      child.kill = signal => { child.killed = signal; child.exitCode = -1;
        queueMicrotask(() => child.emit('close', null)); };
      child.stdin = new Writable({ write(chunk, _, cb) {
        calls.at(-1).payload = JSON.parse(chunk.toString());
        cb(stdinError ? new Error('private input not logged') : undefined);
        if (stdinError || hanging) return;
        queueMicrotask(() => {
          if (spawnError) { child.emit('error', new Error('private failure')); child.emit('close', -1); return; }
          child.stdout.write(text); child.exitCode = code; child.emit('close', code);
        });
      } });
      return child;
    }, ...options });
  return { plugin, ctx, calls, warnings, children, get registrations() { return registrations; },
    get disposals() { return disposals; }, run: e => callback(e) };
}
function event(content = 'search result', overrides = {}) {
  return { status: 'completed', tool: 'grep', input: { pattern: 'Handler', path: 'src' },
    result: { content, output: { matches: 1 }, metadata: { kept: true } }, ...overrides };
}

test('v2 default identity, completed grep args and workspace cwd', async () => {
  const f = fixture(); const cleanup = await f.plugin.setup(f.ctx); const e = event();
  await f.run(e);
  assert.equal(f.plugin.id, 'codebase-memory');
  assert.equal(e.result.content, 'search result\ngraph context');
  assert.deepEqual(e.result.metadata, { kept: true }); assert.deepEqual(e.result.output, { matches: 1 });
  assert.deepEqual(f.calls[0].payload, { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: e.input, cwd: '/synthetic/project' });
  assert.equal(f.calls[0].opts.cwd, '/synthetic/project'); assert.equal(f.calls[0].opts.shell, false);
  assert.deepEqual(f.calls[0].argv, ['hook-augment']); await cleanup();
});
test('glob array content retains files, text and metadata; empty content supported', async () => {
  const f = fixture(); const cleanup = await f.plugin.setup(f.ctx);
  const original = [{ type: 'file', uri: 'file:///synthetic/file', mime: 'text/plain' }, { type: 'text', text: 'found' }];
  const e = event(original, { tool: 'glob' }); await f.run(e);
  assert.deepEqual(e.result.content, [...original, { type: 'text', text: 'graph context' }]);
  assert.equal(f.calls[0].payload.tool_name, 'Glob');
  const empty = event(undefined); delete empty.result.content; await f.run(empty);
  assert.deepEqual(empty.result.content, [{ type: 'text', text: 'graph context' }]); await cleanup();
});
test('unrelated and failed tools never spawn', async () => {
  const f = fixture(); const cleanup = await f.plugin.setup(f.ctx);
  for (const e of [event('kept', { tool: 'read' }), event('kept', { status: 'error' })]) {
    await f.run(e); assert.equal(e.result.content, 'kept');
  }
  assert.equal(f.calls.length, 0); await cleanup();
});
for (const [name, options] of Object.entries({
  nonzero: { code: 1 }, malformed: { text: 'not json' }, wrongEnvelope: { text: '{"additionalContext":"wrong"}' },
  empty: { text: '' }, timeout: { hanging: true }, oversized: { text: 'x'.repeat(100_000) },
  stdin: { stdinError: true }, spawn: { spawnError: true },
})) test(`${name} leaves original result intact and closes owned child`, async () => {
  const f = fixture(options); const cleanup = await f.plugin.setup(f.ctx); const e = event(); const before = e.result;
  await f.run(e); assert.equal(e.result, before);
  if (['timeout', 'oversized', 'stdin'].includes(name)) assert.equal(f.children[0].killed, 'SIGKILL');
  assert.ok(f.warnings.every(w => !w.includes('private'))); await cleanup();
});
test('synchronous spawn error and cyclic input do not reject searches', async () => {
  const f = fixture({ spawnImpl: () => { throw new Error('no binary'); } });
  const cleanup = await f.plugin.setup(f.ctx); const e = event(); await f.run(e);
  assert.equal(e.result.content, 'search result'); e.input.self = e.input; await f.run(e); await cleanup();
});
test('missing workspace location refuses home-cwd fallback', async () => {
  const f = fixture(); f.ctx.location = {}; await f.plugin.setup(f.ctx);
  assert.equal(f.registrations, 0); assert.deepEqual(f.warnings, ['invalid-location']);
});
test('one registration per context and cleanup kills only owned work', async () => {
  const f = fixture({ hanging: true }); const cleanup = await f.plugin.setup(f.ctx);
  assert.equal(await f.plugin.setup(f.ctx), cleanup); assert.equal(f.registrations, 1);
  const e = event(); const pending = f.run(e); await cleanup(); await pending;
  assert.equal(f.disposals, 1); assert.equal(f.children[0].killed, 'SIGKILL');
  assert.equal(e.result.content, 'search result'); await f.run(event()); assert.equal(f.calls.length, 1);
});
