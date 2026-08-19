const assert = require('node:assert');
const { mkdtemp, mkdir, writeFile, utimes } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  archiveUrl,
  findDartIoImports,
  isFresh,
  newestDartSource,
  VENDOR_DIR,
} = require('../src/toolchain');

async function project(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'render-dart-test-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  return root;
}

test('the vendored SDK lives inside node_modules, which Render caches', () => {
  // Not cosmetic: a top-level directory is NOT preserved between Render
  // builds, and the SDK was re-downloaded every deploy until this moved.
  assert.strictEqual(VENDOR_DIR, path.join('node_modules', '.dart-sdk'));
});

test('archiveUrl names a real platform build', () => {
  const url = archiveUrl('3.13.0');
  assert.match(url, /\/3\.13\.0\/sdk\/dartsdk-(linux|macos|windows)-(x64|arm64)-release\.zip$/);
});

test('findDartIoImports flags a direct dart:io import', async () => {
  const root = await project({
    'tasks.dart': "import 'dart:io';\nvoid main() {}\n",
  });

  const hits = await findDartIoImports(root);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].file, 'tasks.dart');
  assert.strictEqual(hits[0].line, 1);
});

test('findDartIoImports allows conditional imports', async () => {
  const root = await project({
    'tasks.dart':
      "export 'stub.dart' if (dart.library.io) 'dart:io';\nvoid main() {}\n",
  });

  assert.deepStrictEqual(await findDartIoImports(root), []);
});

test('findDartIoImports ignores dependencies and build output', async () => {
  const root = await project({
    'tasks.dart': "void main() {}\n",
    'node_modules/pkg/thing.dart': "import 'dart:io';\n",
    'build/out.dart': "import 'dart:io';\n",
    '.dart_tool/gen.dart': "import 'dart:io';\n",
  });

  assert.deepStrictEqual(await findDartIoImports(root), []);
});

test('findDartIoImports does not trip on the string in a comment', async () => {
  const root = await project({
    'tasks.dart': "// we deliberately avoid dart:io here\nvoid main() {}\n",
  });

  assert.deepStrictEqual(await findDartIoImports(root), []);
});

test('isFresh is false when output is missing', async () => {
  const root = await project({ 'tasks.dart': 'void main() {}\n' });
  assert.strictEqual(await isFresh(root, path.join(root, 'build/tasks.js')), false);
});

test('isFresh is true when output is newer than every source', async () => {
  const root = await project({
    'tasks.dart': 'void main() {}\n',
    'build/tasks.js': '// compiled\n',
  });
  const out = path.join(root, 'build/tasks.js');
  const future = new Date(Date.now() + 60_000);
  await utimes(out, future, future);

  assert.strictEqual(await isFresh(root, out), true);
});

test('isFresh is false when a source is newer than the output', async () => {
  const root = await project({
    'tasks.dart': 'void main() {}\n',
    'build/tasks.js': '// compiled\n',
  });
  const src = path.join(root, 'tasks.dart');
  const future = new Date(Date.now() + 60_000);
  await utimes(src, future, future);

  assert.strictEqual(await isFresh(root, path.join(root, 'build/tasks.js')), false);
});

test('newestDartSource tracks pubspec.yaml too', async () => {
  // Changing dependencies must trigger a rebuild even if no .dart file moved.
  const root = await project({
    'tasks.dart': 'void main() {}\n',
    'pubspec.yaml': 'name: x\n',
  });
  const pubspec = path.join(root, 'pubspec.yaml');
  const future = new Date(Date.now() + 60_000);
  await utimes(pubspec, future, future);

  const newest = await newestDartSource(root);
  assert.ok(newest >= future.getTime() - 1000);
});
