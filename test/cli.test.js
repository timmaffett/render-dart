const assert = require('node:assert');
const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const { mkdtemp, readdir, readFile, stat } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');

const run = promisify(execFile);

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const { version } = require('../package.json');

/** Scaffolds into a fresh temp dir and returns the project's package.json. */
async function scaffold(name, template) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'render-dart-init-'));
  await run(
    process.execPath,
    [CLI, 'init', name, ...(template ? ['--template', template] : [])],
    { cwd: root },
  );
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

// ------------------------------------------------------------- templates

test('every example is a usable template', async () => {
  // Templates are the examples, so a broken example is a broken template.
  // This is what keeps that promise honest.
  const examples = path.join(__dirname, '..', 'examples');
  const names = (await readdir(examples, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  assert.ok(names.includes('default'), 'default must exist — init uses it');

  for (const name of names) {
    for (const required of ['package.json', 'pubspec.yaml', 'tasks.dart', 'index.js']) {
      assert.ok(
        existsSync(path.join(examples, name, required)),
        `examples/${name} is missing ${required}`,
      );
    }
  }
});

test('init --template scaffolds the named example', async () => {
  const { target, pkg } = await scaffold('db', 'postgres');

  assert.strictEqual(pkg.name, 'db');
  assert.deepStrictEqual(pkg.renderDart.native, ['native/db_impl.dart']);
  assert.ok(existsSync(path.join(target, 'native', 'db_impl.dart')));
});

test('an unknown template fails, listing the real ones', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'render-dart-init-'));
  await assert.rejects(
    run(process.execPath, [CLI, 'init', 'x', '--template', 'nope'], { cwd: root }),
    (e) => {
      assert.match(e.stderr, /No template named "nope"/);
      assert.match(e.stderr, /postgres/, 'should name what is available');
      return true;
    },
  );
});

test('a scaffold carries agent guidance', async () => {
  // The whole reason this exists: an agent working in a user's project never
  // opens node_modules, so anything shipped inside the package is invisible.
  const { target } = await scaffold('demo');

  assert.ok(existsSync(path.join(target, 'AGENTS.md')));
  assert.ok(existsSync(path.join(target, 'CLAUDE.md')));
});

test('a scaffold carries the bridge files but no build output', async () => {
  const { target } = await scaffold('db', 'postgres');

  for (const name of ['render_dart.dart', 'native_task.dart']) {
    assert.ok(existsSync(path.join(target, name)), `${name} should be present`);
  }
  // The example is a working project; its artefacts must not come along.
  for (const junk of ['node_modules', 'build', '.dart_tool', 'pubspec.lock']) {
    assert.ok(!existsSync(path.join(target, junk)), `${junk} should not be copied`);
  }
  // Nor should generated code, which the build recreates.
  assert.ok(!existsSync(path.join(target, 'native', 'db.dart')));
  assert.ok(!existsSync(path.join(target, 'native', 'db.stub.dart')));
});
