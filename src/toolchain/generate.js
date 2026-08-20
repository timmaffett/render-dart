// Driving the Dart generator that turns @nativeTask functions into a
// dispatcher and typed stubs.
//
// The generator is a Dart program with its own pubspec, shipped inside this
// package and resolved into the project's node_modules pub cache. Keeping it
// self-contained means depending on package:analyzer never touches the user's
// own pubspec.
const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const GENERATOR_DIR = path.join(__dirname, '..', '..', 'dart', 'generator');

/** Resolves the generator's own dependencies, once. */
function ensureGenerator(dart, pubCache, log) {
  const marker = path.join(GENERATOR_DIR, '.dart_tool', 'package_config.json');
  if (existsSync(marker)) return;

  log('resolving generator dependencies (first native build)');
  const result = spawnSync(dart, ['pub', 'get'], {
    cwd: GENERATOR_DIR,
    stdio: 'pipe',
    env: { ...process.env, PUB_CACHE: pubCache ?? process.env.PUB_CACHE },
  });
  if (result.status !== 0) {
    throw new Error(
      `could not resolve the render-dart generator:\n${(result.stderr ?? '').toString().trim()}`,
    );
  }
}

/**
 * Makes sure a runtime file the generated code imports is present.
 *
 * Written when missing. Never overwritten — an author may have edited it — but
 * a difference is reported, because a stale copy alongside a newer render-dart
 * is exactly how the `^0.1.0` template pin went unnoticed for three releases.
 */
function ensureRuntimeFile(root, name, log) {
  const shipped = path.join(__dirname, '..', '..', 'template', name);
  const local = path.join(root, name);

  if (!existsSync(local)) {
    writeFileSync(local, readFileSync(shipped));
    log(`added ${name}`);
    return;
  }
  if (readFileSync(local, 'utf8') !== readFileSync(shipped, 'utf8')) {
    log(`note: ${name} differs from the version shipped with render-dart`);
  }
}

/**
 * Generates the dispatcher and stubs for one native task entry.
 *
 * Returns the dispatcher path, which is what actually gets compiled — the
 * author's file is imported by it rather than compiled directly.
 */
function generate({ dart, root, entry, pubCache, log }) {
  ensureGenerator(dart, pubCache, log);
  ensureRuntimeFile(root, 'native_task.dart', log);

  const stub = path.join(entry.dir, `${entry.name}.g.dart`);
  const main = path.join(root, '.dart_tool', 'render_dart', `${entry.name}.main.dart`);
  mkdirSync(path.dirname(main), { recursive: true });

  const result = spawnSync(
    dart,
    [
      'run',
      path.join('bin', 'generate.dart'),
      '--project', root,
      '--entry', entry.entry,
      '--name', entry.name,
      '--stub', stub,
      '--main', main,
    ],
    {
      cwd: GENERATOR_DIR,
      stdio: 'pipe',
      env: { ...process.env, PUB_CACHE: pubCache ?? process.env.PUB_CACHE },
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `native task ${entry.rel} could not be generated:\n` +
        `${(result.stderr ?? '').toString().trim()}`,
    );
  }

  const { methods } = JSON.parse((result.stdout ?? '{}').toString().trim() || '{}');
  log(`native ${entry.name}: ${(methods ?? []).length} task(s) — ${(methods ?? []).join(', ')}`);
  return main;
}

module.exports = { generate, ensureRuntimeFile, GENERATOR_DIR };
