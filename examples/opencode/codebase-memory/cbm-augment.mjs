// CAO-maintained OpenCode v2 adapter, NOT an upstream generated install block.
// Contract: @opencode/plugin and @opencode/schema 2.2.7. No SDK runtime needed:
// Plugin.define(definition) returns definition unchanged in that SDK.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export function createPlugin({
  binary = join(homedir(), '.local/bin/codebase-memory-mcp'),
  timeoutMs = 1500,
  maxBytes = 64 * 1024,
  spawnImpl = spawn,
  warn = code => console.warn(`[codebase-memory] augmentation unavailable (${code}); search result preserved`),
} = {}) {
  const contexts = new WeakMap();
  return {
    id: 'codebase-memory',
    async setup(ctx) {
      if (contexts.has(ctx)) return contexts.get(ctx);
      const cwd = ctx.location?.directory;
      if (typeof cwd !== 'string' || !isAbsolute(cwd) || !isAbsolute(binary)) {
        warn('invalid-location');
        return;
      }
      const children = new Set();
      let disposed = false;
      let lastWarning = 0;
      function diagnostic(code) {
        // Never log inputs, paths, stdout/stderr or exception messages.
        if (Date.now() - lastWarning < 60_000) return;
        lastWarning = Date.now();
        warn(code);
      }
      function augment(tool, input) {
        return new Promise(resolve => {
          let payload;
          try {
            payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool,
              tool_input: input ?? {}, cwd });
            if (Buffer.byteLength(payload) > maxBytes) throw new Error('input-limit');
          } catch { diagnostic('input-limit'); resolve(''); return; }
          let child;
          try {
            child = spawnImpl(binary, ['hook-augment'], {
              cwd, stdio: ['pipe', 'pipe', 'ignore'],
              env: { ...process.env, CBM_LOG_LEVEL: 'error' }, shell: false,
            });
          } catch { diagnostic('spawn'); resolve(''); return; }
          children.add(child);
          const chunks = [];
          let bytes = 0, failure = '', settled = false;
          function abort(code) {
            if (!failure) { failure = code; diagnostic(code); }
            if (child.pid && child.exitCode == null) child.kill('SIGKILL');
          }
          const timer = setTimeout(() => abort('timeout'), timeoutMs);
          child.stdout.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > maxBytes) { abort('output-limit'); return; }
            if (!failure) chunks.push(Buffer.from(chunk));
          });
          child.stdin.on('error', () => abort('stdin'));
          child.on('error', () => { failure = 'spawn'; diagnostic('spawn'); });
          child.on('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            children.delete(child);
            if (disposed || failure || code !== 0) {
              if (!failure && code !== 0) diagnostic('exit');
              resolve(''); return;
            }
            const text = Buffer.concat(chunks).toString('utf8').trim();
            if (!text) { resolve(''); return; }
            try {
              const envelope = JSON.parse(text);
              const output = envelope.hookSpecificOutput;
              if (output?.hookEventName !== 'PreToolUse' || typeof output.additionalContext !== 'string') {
                throw new Error('invalid-envelope');
              }
              resolve(output.additionalContext);
            } catch { diagnostic('invalid-envelope'); resolve(''); }
          });
          try { child.stdin.end(payload); }
          catch { abort('stdin'); }
        });
      }
      const registration = await ctx.tool.hook('execute.after', async event => {
        if (disposed || event.status !== 'completed') return;
        const tool = event.tool === 'grep' ? 'Grep' : event.tool === 'glob' ? 'Glob' : null;
        if (!tool) return;
        const extra = await augment(tool, event.input);
        if (!extra || disposed) return;
        const result = event.result;
        const old = result.content;
        if (old != null && typeof old !== 'string' && !Array.isArray(old)) return;
        event.result = { ...result, content: typeof old === 'string'
          ? `${old}\n${extra}`
          : [...(old ?? []), { type: 'text', text: extra }] };
      });
      const cleanup = async () => {
        disposed = true;
        for (const child of children) if (child.pid && child.exitCode == null) child.kill('SIGKILL');
        await registration.dispose();
        contexts.delete(ctx);
      };
      contexts.set(ctx, cleanup);
      return cleanup;
    },
  };
}

export default createPlugin();
