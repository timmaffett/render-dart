const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { mkdtemp, mkdir, writeFile, readFile, utimes } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { nativeEntries, fingerprint } = require('../src/toolchain/native');
const { findDartIoImports } = require('../src/toolchain/compile');

const scratch = () => mkdtemp(path.join(os.tmpdir(), 'render-dart-native-'));

// ------------------------------------------------------------------- config

test('a bare string is shorthand for a wrapped native task', () => {
  const [e] = nativeEntries('/p', ['native/tools_impl.dart']);
  assert.strictEqual(e.name, 'tools', 'the _impl suffix is dropped');
  assert.strictEqual(e.mode, 'task');
  assert.strictEqual(e.dir, path.resolve('/p/native'));
});

test('the generated facade takes the plain name callers import', () => {
  const [e] = nativeEntries('/p', ['native/tools_impl.dart']);
  assert.strictEqual(e.facade, path.resolve('/p/native/tools.dart'));
  assert.strictEqual(e.stub, path.resolve('/p/native/tools.stub.dart'));
});

test('an entry that would be clobbered by its own facade is rejected', () => {
  // native/tools.dart is where the facade goes, so the implementation cannot
  // also live there — silently overwriting the author's source would be the
  // worst possible outcome.
  assert.throws(
    () => nativeEntries('/p', ['native/tools.dart']),
    /would be overwritten by its own generated facade[\s\S]*tools_impl\.dart/,
  );
});

test('options left unset in package.json defer to the annotation', () => {
  const [e] = nativeEntries('/p', ['native/tools_impl.dart']);
  assert.strictEqual(e.worker, undefined, 'not false — false would override');
  assert.strictEqual(e.idleTimeoutMs, undefined);
});

test('the object form overrides what the annotation declared', () => {
  const [a, b] = nativeEntries('/p', [
    { entry: 'native/raw_impl.dart', mode: 'exe' },
    { entry: 'native/hot_impl.dart', worker: true, idleTimeoutMs: 5000 },
  ]);
  assert.strictEqual(a.mode, 'exe');
  assert.strictEqual(b.worker, true);
  assert.strictEqual(b.idleTimeoutMs, 5000);
});

test('worker mode is rejected on an exe, which has no dispatch loop', () => {
  assert.throws(
    () => nativeEntries('/p', [{ entry: 'a_impl.dart', mode: 'exe', worker: true }]),
    /worker.*needs mode "task"/,
  );
});

test('an unknown mode is rejected by name', () => {
  assert.throws(() => nativeEntries('/p', [{ entry: 'a_impl.dart', mode: 'wasm' }]), /unknown native mode/);
});

test('two entries with the same basename are rejected', () => {
  // They would compile to the same executable, silently clobbering each other.
  assert.throws(
    () => nativeEntries('/p', ['a/tools_impl.dart', 'b/tools_impl.dart']),
    /both named "tools"/,
  );
});

// -------------------------------------------------------------------- guard

test('dart:io is allowed inside a declared native directory', async () => {
  const root = await scratch();
  await mkdir(path.join(root, 'native'), { recursive: true });
  await writeFile(path.join(root, 'native', 'tools_impl.dart'), "import 'dart:io';\n");
  await writeFile(path.join(root, 'tasks.dart'), "import 'render_dart.dart';\n");

  const [entry] = nativeEntries(root, ['native/tools_impl.dart']);
  assert.deepStrictEqual(await findDartIoImports(root, [entry.dir]), []);
});

test('dart:io in task code is still rejected when a native dir is exempt', async () => {
  const root = await scratch();
  await mkdir(path.join(root, 'native'), { recursive: true });
  await writeFile(path.join(root, 'native', 'tools_impl.dart'), "import 'dart:io';\n");
  await writeFile(path.join(root, 'tasks.dart'), "import 'dart:io';\n");

  const [entry] = nativeEntries(root, ['native/tools_impl.dart']);
  const hits = await findDartIoImports(root, [entry.dir]);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].file, 'tasks.dart');
});

// ------------------------------------------------------------------- cache

test('the fingerprint is content-addressed, not mtime-based', async () => {
  // This is the whole reason the cache works on Render: every deploy is a
  // fresh git checkout, which stamps current mtimes on every file. An
  // mtime-keyed cache can therefore never hit there.
  const root = await scratch();
  await mkdir(path.join(root, 'native'), { recursive: true });
  const file = path.join(root, 'native', 'tools_impl.dart');
  await writeFile(file, 'void main() {}\n');

  const [entry] = nativeEntries(root, ['native/tools_impl.dart']);
  const before = await fingerprint(root, entry);

  const later = new Date(Date.now() + 60_000);
  await utimes(file, later, later);
  assert.strictEqual(await fingerprint(root, entry), before, 'touch must not change the key');

  await writeFile(file, 'void main() { print(1); }\n');
  assert.notStrictEqual(await fingerprint(root, entry), before, 'an edit must change the key');
});

test('the fingerprint covers every dart file beside the entry', async () => {
  const root = await scratch();
  await mkdir(path.join(root, 'native', 'sub'), { recursive: true });
  await writeFile(path.join(root, 'native', 'tools_impl.dart'), 'void main() {}\n');
  await writeFile(path.join(root, 'native', 'sub', 'helper.dart'), 'int x = 1;\n');

  const [entry] = nativeEntries(root, ['native/tools_impl.dart']);
  const before = await fingerprint(root, entry);

  await writeFile(path.join(root, 'native', 'sub', 'helper.dart'), 'int x = 2;\n');
  assert.notStrictEqual(await fingerprint(root, entry), before, 'a helper edit must invalidate');
});

test('mode and worker are part of the cache key', async () => {
  const root = await scratch();
  await mkdir(path.join(root, 'native'), { recursive: true });
  await writeFile(path.join(root, 'native', 'tools_impl.dart'), 'void main() {}\n');

  const [asTask] = nativeEntries(root, ['native/tools_impl.dart']);
  const [asExe] = nativeEntries(root, [{ entry: 'native/tools_impl.dart', mode: 'exe' }]);
  assert.notStrictEqual(await fingerprint(root, asTask), await fingerprint(root, asExe));
});

// --------------------------------------------------- generator (needs Dart)

const dartOnPath = (() => {
  try {
    execFileSync('dart', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

test('the generator rejects a parameter that cannot cross JSON', { skip: !dartOnPath }, async () => {
  const root = await scratch();
  await mkdir(path.join(root, 'native'), { recursive: true });
  await writeFile(
    path.join(root, 'native', 'bad_impl.dart'),
    `import '../native_task.dart';\n` +
      `class Widget {}\n` +
      `@nativeTask\n` +
      `int count(Widget w) => 1;\n`,
  );
  await writeFile(
    path.join(root, 'native_task.dart'),
    await readFile(path.join(__dirname, '..', 'runtime', 'native_task.dart')),
  );

  const { generate } = require('../src/toolchain/generate');
  const [entry] = nativeEntries(root, ['native/bad_impl.dart']);
  assert.throws(
    () => generate({ dart: 'dart', root, entry, log: () => {} }),
    /cannot cross a JSON boundary[\s\S]*Widget/,
  );
  assert.ok(!existsSync(path.join(root, 'native', 'bad.stub.dart')), 'no stub on failure');
});

// ------------------------------------------------------------------ worker

const { nativeCall, shutdownWorkers, workers } = require('../src/native-worker');

/**
 * A stand-in for a compiled native task: same JSONL contract, no Dart needed.
 *
 * `ping` counts calls so a reused process is provable, and `die` exits hard —
 * which a caught Dart throw does not, so it covers the failure the dispatch
 * loop cannot handle itself.
 */
async function fakeBinary(dir) {
  const file = path.join(dir, 'fake-native');
  await writeFile(
    file,
    `#!/usr/bin/env node
let calls = 0;
require('node:readline')
  .createInterface({ input: process.stdin })
  .on('line', (line) => {
    const { id, method } = JSON.parse(line);
    if (method === 'die') { process.stderr.write('fatal\\n'); process.exit(7); }
    if (method === 'slow') { setTimeout(() => reply(id, ++calls), 40); return; }
    reply(id, ++calls);
  });
function reply(id, calls) {
  process.stdout.write(JSON.stringify({ id, $ok: { calls, pid: process.pid } }) + '\\n');
}
`,
    { mode: 0o755 },
  );
  return file;
}

const okOf = (lines) => JSON.parse(lines[lines.length - 1]).$ok;
const req = (method) => JSON.stringify({ id: 1, method, args: [], named: {} });

test('a worker serves many calls from one process', async (t) => {
  t.after(shutdownWorkers);
  const bin = await fakeBinary(await scratch());

  const first = okOf(await nativeCall(bin, req('ping')));
  const second = okOf(await nativeCall(bin, req('ping')));

  assert.strictEqual(first.calls, 1);
  assert.strictEqual(second.calls, 2, 'state must survive between calls');
  assert.strictEqual(first.pid, second.pid, 'same process');
});

test('concurrent calls are matched to their own replies by id', async (t) => {
  t.after(shutdownWorkers);
  const bin = await fakeBinary(await scratch());

  // 'slow' answers out of step with 'ping', so a positional match would pair
  // the wrong reply with the wrong caller.
  const [slow, fast] = await Promise.all([
    nativeCall(bin, req('slow')),
    nativeCall(bin, req('ping')),
  ]);

  assert.strictEqual(okOf(fast).calls, 1, 'ping answered first');
  assert.strictEqual(okOf(slow).calls, 2, 'slow answered second');
});

test('a dying worker rejects in-flight calls and respawns for the next', async (t) => {
  t.after(shutdownWorkers);
  const bin = await fakeBinary(await scratch());

  const before = okOf(await nativeCall(bin, req('ping')));

  await assert.rejects(nativeCall(bin, req('die')), (e) => {
    // A hung promise would be the worst outcome; the exit status and the
    // child's stderr both have to reach the caller.
    assert.match(e.message, /exited with code 7/);
    assert.match(e.message, /fatal/);
    return true;
  });

  const after = okOf(await nativeCall(bin, req('ping')));
  assert.strictEqual(after.calls, 1, 'a fresh process starts over');
  assert.notStrictEqual(after.pid, before.pid, 'and it is a different process');
});

test('an idle worker is reaped, and the next call starts a new one', async (t) => {
  t.after(shutdownWorkers);
  const bin = await fakeBinary(await scratch());

  const before = okOf(await nativeCall(bin, req('ping'), { idleTimeoutMs: 50 }));
  await new Promise((r) => setTimeout(r, 250));
  assert.strictEqual(workers.size, 0, 'reaped after idling');

  const after = okOf(await nativeCall(bin, req('ping'), { idleTimeoutMs: 50 }));
  assert.strictEqual(after.calls, 1);
  assert.notStrictEqual(after.pid, before.pid);
});

test('the generator reads options off the annotation', { skip: !dartOnPath }, async () => {
  const root = await scratch();
  await mkdir(path.join(root, 'native'), { recursive: true });
  await writeFile(
    path.join(root, 'native_task.dart'),
    await readFile(path.join(__dirname, '..', 'runtime', 'native_task.dart')),
  );
  await writeFile(
    path.join(root, 'render_dart.dart'),
    await readFile(path.join(__dirname, '..', 'runtime', 'render_dart.dart')),
  );
  await writeFile(
    path.join(root, 'native', 'tools_impl.dart'),
    `import '../native_task.dart';\n` +
      `@NativeTask(worker: true, idleTimeout: Duration(seconds: 7))\n` +
      `Future<int> hot(int a) async => a;\n` +
      `@nativeTask\n` +
      `Future<int> cold(int a) async => a;\n`,
  );

  const { generate } = require('../src/toolchain/generate');
  const [entry] = nativeEntries(root, ['native/tools_impl.dart']);
  generate({ dart: 'dart', root, entry, log: () => {} });

  const stub = await readFile(entry.stub, 'utf8');
  // The declaration carries the settings, so the call site needs none.
  assert.match(stub, /'hot', \[a\], const \{\}, true, 7000/);
  assert.match(stub, /'cold', \[a\], const \{\}\)/, 'no options when none declared');

  // And the facade is what makes the import look ordinary.
  const facade = await readFile(entry.facade, 'utf8');
  assert.match(facade, /export 'tools\.stub\.dart'\s*\n?\s*if \(dart\.library\.io\) 'tools_impl\.dart'/);
});

test('package.json overrides what the annotation declared', { skip: !dartOnPath }, async () => {
  const root = await scratch();
  await mkdir(path.join(root, 'native'), { recursive: true });
  for (const f of ['native_task.dart', 'render_dart.dart']) {
    await writeFile(path.join(root, f), await readFile(path.join(__dirname, '..', 'runtime', f)));
  }
  await writeFile(
    path.join(root, 'native', 'tools_impl.dart'),
    `import '../native_task.dart';\n` +
      `@NativeTask(worker: true)\n` +
      `Future<int> hot(int a) async => a;\n`,
  );

  const { generate } = require('../src/toolchain/generate');
  const [entry] = nativeEntries(root, [{ entry: 'native/tools_impl.dart', worker: false }]);
  generate({ dart: 'dart', root, entry, log: () => {} });

  const stub = await readFile(entry.stub, 'utf8');
  assert.match(stub, /'hot', \[a\], const \{\}\)/, 'package.json turned the worker off');
});
