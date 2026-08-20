const assert = require('node:assert');
const { execFile } = require('node:child_process');
const { mkdtemp, readFile, stat } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');

const run = promisify(execFile);

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const { version } = require('../package.json');

/** Scaffolds into a fresh temp dir and returns the project's package.json. */
async function scaffold(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'render-dart-init-'));
  await run(process.execPath, [CLI, 'init', name], { cwd: root });
  const target = path.join(root, name);
  const pkg = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'));
  return { target, pkg };
}

// cli.js calls main() on require, so it has to be driven as a subprocess.
// That also makes this the real `npx render-dart init` path rather than an
// approximation of it.

test('init pins render-dart to the version doing the scaffolding', async () => {
  const { pkg } = await scaffold('demo');

  // The bug this guards: template/package.json carried a hardcoded `^0.1.0`,
  // which npm reads as `<0.2.0` for a 0.x package. Every project scaffolded
  // after 0.2.0 silently installed 0.1.1 and missed wasm support, asset
  // resolution and the node bridge. The template's own value is deliberately
  // NOT the source of truth — init overwrites it — so this asserts against
  // package.json's version instead.
  assert.strictEqual(pkg.dependencies['render-dart'], `^${version}`);
});

test('init names the project after its directory', async () => {
  const { pkg } = await scaffold('my-tasks');
  assert.strictEqual(pkg.name, 'my-tasks');
});

test('init restores the template gitignore to its real name', async () => {
  // npm strips .gitignore from published packages, so the template ships it
  // as `gitignore`. If that rename ever broke it would be invisible until a
  // scaffolded project committed build/ and a 227 MB Dart SDK.
  const { target } = await scaffold('demo');

  assert.ok((await stat(path.join(target, '.gitignore'))).isFile());
  await assert.rejects(stat(path.join(target, 'gitignore')), { code: 'ENOENT' });
});

test('init refuses to overwrite an existing directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'render-dart-init-'));
  await run(process.execPath, [CLI, 'init', 'demo'], { cwd: root });

  await assert.rejects(
    run(process.execPath, [CLI, 'init', 'demo'], { cwd: root }),
    (e) => /already exists/.test(e.stderr) && e.code !== 0,
  );
});
