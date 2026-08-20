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
  const [e] = nativeEntries('/p', ['native/tools.dart']);
  assert.strictEqual(e.name, 'tools');
  assert.strictEqual(e.mode, 'task');
  assert.strictEqual(e.worker, false);
  assert.strictEqual(e.dir, path.resolve('/p/native'));
});

test('the object form carries mode and worker settings', () => {
  const [a, b] = nativeEntries('/p', [
    { entry: 'native/raw.dart', mode: 'exe' },
    { entry: 'native/hot.dart', worker: true, idleTimeoutMs: 5000 },
  ]);
  assert.strictEqual(a.mode, 'exe');
  assert.strictEqual(b.worker, true);
  assert.strictEqual(b.idleTimeoutMs, 5000);
});

test('worker mode is rejected on an exe, which has no dispatch loop', () => {
  assert.throws(
    () => nativeEntries('/p', [{ entry: 'a.dart', mode: 'exe', worker: true }]),
    /worker.*needs mode "task"/,
  );
});

test('an unknown mode is rejected by name', () => {
  assert.throws(() => nativeEntries('/p', [{ entry: 'a.dart', mode: 'wasm' }]), /unknown native mode/);
});

test('two entries with the same basename are rejected', () => {
  // They would compile to the same executable, silently clobbering each other.
  assert.throws(
    () => nativeEntries('/p', ['a/tools.dart', 'b/tools.dart']),
    /both named "tools"/,
  );
});

// -------------------------------------------------------------------- guard

test('dart:io is allowed inside a declared native directory', async () => {
  const root = await scratch();
  await mkdir(path.join(root, 'native'), { recursive: true });
  await writeFile(path.join(root, 'native', 'tools.dart'), "import 'dart:io';\n");
  await writeFile(path.join(root, 'tasks.dart'), "import 'render_dart.dart';\n");

  const [entry] = nativeEntries(root, ['native/tools.dart']);
  assert.deepStrictEqual(await findDartIoImports(root, [entry.dir]), []);
});

test('dart:io in task code is still rejected when a native dir is exempt', async () => {
  const root = await scratch();
  await mkdir(path.join(root, 'native'), { recursive: true });
  await writeFile(path.join(root, 'native', 'tools.dart'), "import 'dart:io';\n");
  await writeFile(path.join(root, 'tasks.dart'), "import 'dart:io';\n");

  const [entry] = nativeEntries(root, ['native/tools.dart']);
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
  const file = path.join(root, 'native', 'tools.dart');
  await writeFile(file, 'void main() {}\n');

  const [entry] = nativeEntries(root, ['native/tools.dart']);
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
  await writeFile(path.join(root, 'native', 'tools.dart'), 'void main() {}\n');
  await writeFile(path.join(root, 'native', 'sub', 'helper.dart'), 'int x = 1;\n');

  const [entry] = nativeEntries(root, ['native/tools.dart']);
  const before = await fingerprint(root, entry);

  await writeFile(path.join(root, 'native', 'sub', 'helper.dart'), 'int x = 2;\n');
  assert.notStrictEqual(await fingerprint(root, entry), before, 'a helper edit must invalidate');
});

test('mode and worker are part of the cache key', async () => {
  const root = await scratch();
  await mkdir(path.join(root, 'native'), { recursive: true });
  await writeFile(path.join(root, 'native', 'tools.dart'), 'void main() {}\n');

  const [asTask] = nativeEntries(root, ['native/tools.dart']);
  const [asExe] = nativeEntries(root, [{ entry: 'native/tools.dart', mode: 'exe' }]);
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
    path.join(root, 'native', 'bad.dart'),
    `import '../native_task.dart';\n` +
      `class Widget {}\n` +
      `@nativeTask\n` +
      `int count(Widget w) => 1;\n`,
  );
  await writeFile(
    path.join(root, 'native_task.dart'),
    await readFile(path.join(__dirname, '..', 'template', 'native_task.dart')),
  );

  const { generate } = require('../src/toolchain/generate');
  const [entry] = nativeEntries(root, ['native/bad.dart']);
  assert.throws(
    () => generate({ dart: 'dart', root, entry, log: () => {} }),
    /cannot cross a JSON boundary[\s\S]*Widget/,
  );
  assert.ok(!existsSync(path.join(root, 'native', 'bad.g.dart')), 'no stub on failure');
});
