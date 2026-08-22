const assert = require('node:assert');
const { existsSync } = require('node:fs');
const { chmod, mkdir, mkdtemp, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  compareVersions,
  isAlias,
  requestedVersion,
  DEFAULT_DART_VERSION,
} = require('../src/toolchain/dart-version');
const { resolveDart, versionOf, VENDOR_DIR } = require('../src/toolchain/dart-sdk');

// Everything here is offline. Resolving an alias and downloading an SDK both
// need the archive, and a test suite that reaches the network fails for
// reasons that have nothing to do with the code.

test('the command line outranks the environment, which outranks package.json', () => {
  assert.deepStrictEqual(
    requestedVersion({ flag: '3.10.0', env: '3.11.0', config: '3.12.0' }),
    { version: '3.10.0', explicit: true, from: '--dart-version' },
  );
  assert.deepStrictEqual(
    requestedVersion({ env: '3.11.0', config: '3.12.0' }),
    { version: '3.11.0', explicit: true, from: 'RENDER_DART_VERSION' },
  );
  assert.deepStrictEqual(
    requestedVersion({ config: '3.12.0' }),
    { version: '3.12.0', explicit: true, from: 'package.json' },
  );
});

test('the built-in default is not an explicit request', () => {
  // The distinction the whole feature turns on: a version nobody asked for
  // must not override a Dart the developer installed deliberately.
  const asked = requestedVersion({});
  assert.strictEqual(asked.version, DEFAULT_DART_VERSION);
  assert.strictEqual(asked.explicit, false);
});

test('aliases are recognised, exact versions are not', () => {
  for (const a of ['latest', 'stable', 'beta', 'dev']) {
    assert.ok(isAlias(a), `${a} should be an alias`);
  }
  assert.ok(!isAlias('3.13.0'));
});

test('versions sort numerically, and a pre-release sorts below its release', () => {
  const sorted = ['3.9.0', '3.10.0', '3.14.0-95.2.beta', '3.13.1', '3.2.0']
    .sort(compareVersions);
  assert.deepStrictEqual(sorted, [
    '3.2.0', '3.9.0', '3.10.0', '3.13.1', '3.14.0-95.2.beta',
  ]);
});

/** A stand-in `dart` that reports the version it was told to. */
async function fakeSdk(root, version) {
  const dir = path.join(root, VENDOR_DIR, 'dart-sdk', 'bin');
  await mkdir(dir, { recursive: true });
  const bin = path.join(dir, 'dart');
  await writeFile(bin, `#!/bin/sh\necho "Dart SDK version: ${version}"\n`);
  await chmod(bin, 0o755);
  await writeFile(path.join(root, VENDOR_DIR, 'VERSION'), `${version}\n`);
  return bin;
}

test('a vendored SDK is reused when it is the version asked for', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rd-sdk-'));
  await fakeSdk(root, '3.12.2');

  const r = await resolveDart({
    root, version: '3.12.2', explicit: true, log: () => {},
  });
  assert.strictEqual(r.source, 'vendored');
  assert.strictEqual(r.version, '3.12.2');
});

test('changing the pin invalidates a vendored SDK', async () => {
  // Before the version was recorded beside it, the cache key was "does the
  // directory exist" — so changing the pin did nothing on any machine that had
  // already built once, including every Render build after the first.
  const root = await mkdtemp(path.join(os.tmpdir(), 'rd-sdk-'));
  await fakeSdk(root, '3.12.2');

  const lines = [];
  await assert.rejects(
    resolveDart({
      root,
      version: '3.11.0',
      explicit: true,
      log: (m) => {
        lines.push(m);
        // Stop at the download rather than pulling 228 MB in a unit test.
        if (m.startsWith('fetching')) throw new Error('would download');
      },
    }),
    /would download/,
  );
  assert.ok(
    lines.some((l) => l.includes('vendored Dart is 3.12.2')),
    `expected the mismatch to be reported, got: ${lines.join(' | ')}`,
  );
});

test('a vendored SDK still wins when no version was asked for', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rd-sdk-'));
  await fakeSdk(root, '3.12.2');

  const r = await resolveDart({
    root, version: DEFAULT_DART_VERSION, explicit: false, log: () => {},
  });
  assert.strictEqual(r.source, 'vendored');
});

test('asking which Dart would be used never installs one', async () => {
  // It did, once. `render-dart dart` reported "(downloaded)" because the query
  // path shared the build path's resolver, so a question pulled 228 MB and
  // unpacked 624 MB of SDK as a side effect.
  const root = await mkdtemp(path.join(os.tmpdir(), 'rd-dry-'));
  const lines = [];

  const r = await resolveDart({
    root,
    version: '3.11.0',
    explicit: true,
    fetch: false,
    log: (m) => lines.push(m),
  });

  assert.strictEqual(r.source, 'would download');
  assert.strictEqual(r.dart, null);
  assert.ok(
    !existsSync(path.join(root, VENDOR_DIR)),
    'nothing should have been written',
  );
  assert.ok(
    !lines.some((l) => l.startsWith('fetching')),
    `no download should have started, got: ${lines.join(' | ')}`,
  );
});

test('versionOf reads a version from either stream', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rd-ver-'));
  const bin = path.join(root, 'dart-stderr');
  // Some Dart releases print --version to stderr, others to stdout.
  await writeFile(bin, '#!/bin/sh\necho "Dart SDK version: 3.4.4" >&2\n');
  await chmod(bin, 0o755);
  assert.strictEqual(versionOf(bin), '3.4.4');
});
