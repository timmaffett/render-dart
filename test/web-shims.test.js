const assert = require('node:assert');
const { mkdtemp, mkdir, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const shims = require('../src/web-shims');

/** A project with a package_config.json, as `dart pub get` would write. */
async function projectWithPackage(name, rootDir) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'render-dart-shims-'));
  await mkdir(path.join(root, '.dart_tool'), { recursive: true });
  await writeFile(
    path.join(root, '.dart_tool', 'package_config.json'),
    JSON.stringify({
      configVersion: 2,
      packages: [{ name, rootUri: pathToFileURL(rootDir).href, packageUri: 'lib/' }],
    }),
  );
  return root;
}

test('installSelf gives dart2js the global it needs', () => {
  shims.installSelf();
  assert.strictEqual(globalThis.self, globalThis);
});

test('resolvePackageAsset maps the packages/ web convention to a real file', async () => {
  const pkgRoot = '/pkgs/forge2d-0.15.1';
  const project = await projectWithPackage('forge2d', pkgRoot);
  const cwd = process.cwd();
  process.chdir(project);
  try {
    const resolved = await shims.resolvePackageAsset(
      'packages/forge2d/src/backend/wasm/box2d.wasm',
    );
    assert.strictEqual(
      resolved,
      pathToFileURL(`${pkgRoot}/lib/src/backend/wasm/box2d.wasm`).href,
    );

    // The root-anchored and package: spellings resolve identically.
    const expected = pathToFileURL(`${pkgRoot}/lib/a.wasm`).href;
    assert.strictEqual(await shims.resolvePackageAsset('/packages/forge2d/a.wasm'), expected);
    assert.strictEqual(await shims.resolvePackageAsset('package:forge2d/a.wasm'), expected);

    // A package that is not installed resolves to nothing.
    assert.strictEqual(await shims.resolvePackageAsset('packages/absent/a.wasm'), null);
  } finally {
    process.chdir(cwd);
  }
});

test('resolvePackageAsset ignores ordinary URLs so real fetch handles them', async () => {
  // Regression guard: the polyfill must never swallow network requests.
  for (const url of [
    'https://example.com/x.wasm',
    'http://localhost:8120/v1/task-runs',
    'data:application/wasm;base64,AA==',
    'file:///tmp/x.wasm',
  ]) {
    assert.strictEqual(await shims.resolvePackageAsset(url), null, url);
  }
});

test('installFetch serves file: URLs and 404s a missing one', async () => {
  shims.installFetch();
  assert.ok(globalThis.fetch.__renderDartFilePatch, 'fetch should be patched');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'render-dart-fetch-'));
  const file = path.join(dir, 'asset.wasm');
  await writeFile(file, Buffer.from([0, 97, 115, 109]));

  const ok = await fetch(pathToFileURL(file).href);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.headers.get('content-type'), 'application/wasm');
  assert.strictEqual((await ok.arrayBuffer()).byteLength, 4);

  // A missing file must be a 404, not a throw: packages probe several
  // candidate URLs in turn and rely on being able to continue.
  const missing = await fetch(pathToFileURL(path.join(dir, 'nope.wasm')).href);
  assert.strictEqual(missing.status, 404);
});

test('installFetch is idempotent', () => {
  const before = globalThis.fetch;
  shims.installFetch();
  assert.strictEqual(globalThis.fetch, before, 'must not wrap itself twice');
});

test('XMLHttpRequest shim performs a GET and yields an arraybuffer', async () => {
  shims.installXmlHttpRequest();

  const dir = await mkdtemp(path.join(os.tmpdir(), 'render-dart-xhr-'));
  const file = path.join(dir, 'mod.wasm');
  await writeFile(file, Buffer.from([1, 2, 3, 4, 5]));

  const bytes = await new Promise((resolve, reject) => {
    const xhr = new globalThis.XMLHttpRequest();
    xhr.open('GET', pathToFileURL(file).href);
    xhr.responseType = 'arraybuffer';
    xhr.addEventListener('load', () => resolve(xhr.response));
    xhr.addEventListener('error', () => reject(new Error('xhr error')));
    xhr.send();
  });

  assert.strictEqual(bytes.byteLength, 5);
});

test('XMLHttpRequest shim reports failure through the error event', async () => {
  shims.installXmlHttpRequest();

  const outcome = await new Promise((resolve) => {
    const xhr = new globalThis.XMLHttpRequest();
    xhr.open('GET', 'file:///definitely/not/here.wasm');
    xhr.addEventListener('load', () => resolve(`load:${xhr.status}`));
    xhr.addEventListener('error', () => resolve('error'));
    xhr.send();
  });

  // The file: handler answers 404 rather than throwing, so this surfaces as a
  // load with a 404 status -- which is what a browser would do too.
  assert.strictEqual(outcome, 'load:404');
});

test('ensureWasmRunGlobals does nothing when wasm_run is not a dependency', async () => {
  const project = await projectWithPackage('collection', '/pkgs/collection-1.19.1');
  const cwd = process.cwd();
  process.chdir(project);
  try {
    await shims.ensureWasmRunGlobals();
    assert.strictEqual(globalThis.browser_wasi_shim, undefined);
  } finally {
    process.chdir(cwd);
  }
});
