// Compiling Dart to JavaScript, with a freshness check so the work is skipped
// when nothing has changed.

const { execFileSync, spawnSync } = require('node:child_process');
const { mkdir, readdir, readFile, stat } = require('node:fs/promises');
const path = require('node:path');

const SKIP_DIRS = new Set(['build', 'node_modules', '.dart_tool', '.git']);

/** Newest mtime across every .dart file under `dir`, recursively. */
async function newestDartSource(dir) {
  let newest = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestDartSource(full));
    } else if (entry.name.endsWith('.dart') || entry.name === 'pubspec.yaml') {
      newest = Math.max(newest, (await stat(full)).mtimeMs);
    }
  }
  return newest;
}

/** Whether `out` is newer than every Dart source under `root`. */
async function isFresh(root, out) {
  try {
    const built = await stat(out);
    return built.mtimeMs >= (await newestDartSource(root));
  } catch {
    return false;
  }
}

/**
 * Resolves pub dependencies, if the project declares any.
 *
 * dart2js needs a package resolution file before it can compile a project
 * that imports anything from pub.dev, and Render's builder has no pub cache,
 * so this has to run there too.
 */
function pubGet(dart, root, log) {
  // Relocate the pub cache into node_modules for the same reason the SDK
  // lives there: Render preserves node_modules between builds, but ~/.pub-cache
  // sits in a fresh filesystem every time and would re-download every
  // dependency on every deploy.
  const pubCache = process.env.PUB_CACHE ?? path.join(root, 'node_modules', '.pub-cache');
  const result = spawnSync(dart, ['pub', 'get'], {
    cwd: root,
    stdio: 'pipe',
    env: { ...process.env, PUB_CACHE: pubCache },
  });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').toString().trim();
    throw new Error(`dart pub get failed:\n${stderr}`);
  }
  log(`pub dependencies resolved (cache: ${path.relative(root, pubCache)})`);
  return pubCache;
}

/**
 * Compiles `entry` to `out` with dart2js.
 *
 * @param {object} opts
 * @param {string} opts.dart      Path to the dart executable.
 * @param {string} opts.root      Project root (holds pubspec.yaml).
 * @param {string} opts.entry     Dart entrypoint.
 * @param {string} opts.out       Output JavaScript file.
 * @param {string} [opts.optimize] dart2js optimisation level, default O2.
 * @param {boolean} [opts.sourceMaps] Emit a source map alongside the output.
 * @param {(m: string) => void} opts.log
 */
async function compile({ dart, root, entry, out, optimize = 'O2', sourceMaps = false, pubCache, log }) {
  await mkdir(path.dirname(out), { recursive: true });

  const args = ['compile', 'js', `-${optimize}`, '-o', out];
  // dart2js emits source maps by default; suppressing them keeps the bundle
  // small, at the cost of production stack traces pointing into compiled JS.
  if (!sourceMaps) args.push('--no-source-maps');
  args.push(entry);

  log(`compiling ${path.relative(root, entry)} -> ${path.relative(root, out)}`);
  execFileSync(dart, args, {
    cwd: root,
    stdio: 'inherit',
    env: pubCache ? { ...process.env, PUB_CACHE: pubCache } : process.env,
  });

  const { size } = await stat(out);
  log(`done (${(size / 1024).toFixed(1)} KB)`);
  return size;
}

/**
 * Finds direct `dart:io` imports in the project's own Dart sources.
 *
 * This matters because dart2js **compiles dart:io without complaint** and then
 * throws `Unsupported operation` at runtime — verified. A task using File,
 * Process, Socket or HttpClient therefore deploys cleanly and fails on its
 * first real run, which on Render means burning up to the task timeout before
 * anyone finds out. Catching it at build time turns a production failure into
 * a build error.
 *
 * Conditional imports (`if (dart.library.io)`) are legitimate and skipped.
 * Only the project's own files are scanned, never pub dependencies.
 */
async function findDartIoImports(root) {
  const hits = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.dart')) {
        const source = await readFile(full, 'utf8');
        source.split('\n').forEach((line, i) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('import') && !trimmed.startsWith('export')) return;
          if (!/['"]dart:io['"]/.test(trimmed)) return;
          if (trimmed.includes('if (')) return; // conditional import, fine
          hits.push({ file: path.relative(root, full), line: i + 1 });
        });
      }
    }
  }

  await walk(root);
  return hits;
}

module.exports = { compile, isFresh, newestDartSource, pubGet, findDartIoImports };
