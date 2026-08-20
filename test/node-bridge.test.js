const assert = require('node:assert');
const { test } = require('node:test');

const { nodeRequire, runProcess, installNodeBridge } = require('../src/node-bridge');

test('nodeRequire loads a Node built-in', () => {
  // The whole point: Dart cannot reach `require` on its own.
  const os = nodeRequire('node:os');
  assert.strictEqual(typeof os.platform, 'function');
});

test('globalThis.require really is undefined, which is why this exists', () => {
  // Guards the assumption the module is built on. dart_node_core reads
  // `require` off globalThis and its own comment claims dart2js provides it
  // there; it does not, in either module system.
  assert.strictEqual(globalThis.require, undefined);
});

test('installNodeBridge is idempotent', () => {
  installNodeBridge();
  const first = globalThis.__require;
  installNodeBridge();
  assert.strictEqual(globalThis.__require, first);
});

test('runProcess captures stdout and a zero exit', async () => {
  const r = await runProcess('echo', ['hello']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout.trim(), 'hello');
  assert.strictEqual(r.stderr, '');
});

test('a non-zero exit is returned, not thrown', async () => {
  // An exit code is a result. The caller usually wants stderr alongside it,
  // and throwing would discard both.
  const r = await runProcess('sh', ['-c', 'echo boom >&2; exit 3']);
  assert.strictEqual(r.code, 3);
  assert.strictEqual(r.stderr.trim(), 'boom');
});

test('a command that cannot start rejects', async () => {
  // Distinct from a non-zero exit: nothing ran, so there is no result.
  await assert.rejects(
    () => runProcess('definitely-not-a-real-binary-xyz', []),
    (e) => e.code === 'ENOENT',
  );
});

test('stdin is written and closed', async () => {
  const r = await runProcess('cat', [], { stdin: 'piped input' });
  assert.strictEqual(r.stdout, 'piped input');
});

test('stdin is closed even when not supplied, so cat does not hang', async () => {
  const r = await runProcess('cat', []);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
});

test('cwd and env are honoured', async () => {
  const os = nodeRequire('node:os');
  const tmp = os.tmpdir();

  const cwd = await runProcess('pwd', [], { cwd: tmp });
  assert.ok(cwd.stdout.trim().endsWith(tmp.replace(/^\/private/, '')) ||
            cwd.stdout.trim() === tmp);

  const env = await runProcess('sh', ['-c', 'echo $RENDER_DART_PROBE'], {
    env: { RENDER_DART_PROBE: 'set' },
  });
  assert.strictEqual(env.stdout.trim(), 'set');
});

test('a timeout kills the process and rejects', async () => {
  await assert.rejects(
    () => runProcess('sleep', ['5'], { timeoutMs: 50 }),
    (e) => /exceeded its 50ms timeout/.test(e.message),
  );
});

test('a fast command is unaffected by a generous timeout', async () => {
  const r = await runProcess('echo', ['quick'], { timeoutMs: 10_000 });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout.trim(), 'quick');
});
