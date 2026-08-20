// Compiling declared Dart files to native executables.
//
// Render's own container can do this: the SDK render-dart vendors is the full
// SDK, carrying gen_snapshot and dartaotruntime, and the build host is already
// linux/x64. So nothing is cross-compiled and no binary is committed — the
// executable is produced from the source in the commit that deploys it.
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } = require('node:fs');
const { readdir } = require('node:fs/promises');
const path = require('node:path');

const CACHE_DIR = path.join('node_modules', '.native-cache');
const OUT_DIR = path.join('build', 'native');
const SKIP_DIRS = new Set(['build', 'node_modules', '.dart_tool', '.git']);

/**
 * Normalises `renderDart.native` into full entries.
 *
 * Accepts a bare path as shorthand for a wrapped native task, or an object for
 * anything else:
 *
 *   "native": [
 *     "native/image_tools.dart",
 *     { "entry": "native/raw.dart", "mode": "exe" },
 *     { "entry": "native/hot.dart", "worker": true, "idleTimeoutMs": 30000 }
 *   ]
 */
function nativeEntries(root, declared) {
  const seen = new Map();

  return (declared ?? []).map((raw) => {
    const spec = typeof raw === 'string' ? { entry: raw } : { ...raw };
    if (!spec.entry) {
      throw new Error('every renderDart.native entry needs an "entry" path');
    }

    const mode = spec.mode ?? 'task';
    if (mode !== 'task' && mode !== 'exe') {
      throw new Error(`unknown native mode "${mode}" for ${spec.entry} (expected "task" or "exe")`);
    }

    const worker = spec.worker ?? false;
    // An "exe" owns its own main and has no dispatch loop to keep alive, so
    // there is nothing for a worker to talk to.
    if (worker && mode !== 'task') {
      throw new Error(`"worker" needs mode "task", but ${spec.entry} is mode "exe"`);
    }

    const entry = path.resolve(root, spec.entry);
    const name = path.basename(spec.entry, '.dart');
    if (seen.has(name)) {
      throw new Error(
        `two native entries are both named "${name}" (${seen.get(name)} and ${spec.entry}); ` +
          `they would compile to the same executable`,
      );
    }
    seen.set(name, spec.entry);

    return {
      name,
      entry,
      rel: spec.entry,
      dir: path.dirname(entry),
      mode,
      worker,
      idleTimeoutMs: spec.idleTimeoutMs ?? 30000,
      out: path.join(root, OUT_DIR, name),
    };
  });
}

/** Every .dart file under `dir`, sorted, so a fingerprint is stable. */
async function dartFilesUnder(dir) {
  const found = [];
  async function walk(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith('.dart')) found.push(full);
    }
  }
  await walk(dir);
  return found.sort();
}

/**
 * Content fingerprint of everything that feeds one native executable.
 *
 * Keyed on content, never mtime. Every Render deploy is a fresh git checkout,
 * which stamps the current time on every file — so an mtime comparison can
 * never hit, and the cache silently does nothing. That was measured against
 * Render's build log before this was written.
 */
async function fingerprint(root, entry) {
  const files = await dartFilesUnder(entry.dir);
  const h = createHash('sha256');
  h.update(entry.mode).update('\0').update(String(entry.worker)).update('\0');
  for (const f of files) {
    h.update(path.relative(root, f)).update('\0').update(readFileSync(f));
  }
  for (const meta of ['pubspec.yaml', 'pubspec.lock']) {
    const p = path.join(root, meta);
    if (existsSync(p)) h.update(meta).update('\0').update(readFileSync(p));
  }
  return h.digest('hex');
}

/**
 * Compiles each entry, reusing a cached binary when its sources are unchanged.
 *
 * Output lands in node_modules/.native-cache first and is copied to
 * build/native/. That is deliberate: Render's build cache preserves
 * node_modules and nothing else, so a deploy touching only tasks.dart reuses
 * the executable instead of paying for another AOT compile.
 */
async function buildNative({ dart, root, entries, pubCache, log }) {
  const cacheDir = path.join(root, CACHE_DIR);
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(path.join(root, OUT_DIR), { recursive: true });

  const env = pubCache ? { ...process.env, PUB_CACHE: pubCache } : process.env;

  for (const entry of entries) {
    // A "task" entry compiles the generated dispatcher, which imports the
    // author's file; an "exe" entry compiles the file itself.
    const source = entry.mode === 'task' ? entry.main : entry.entry;
    const cached = path.join(cacheDir, entry.name);
    const stamp = `${cached}.sha256`;
    const want = await fingerprint(root, entry);

    const hit =
      existsSync(cached) &&
      existsSync(stamp) &&
      readFileSync(stamp, 'utf8').trim() === want;

    if (hit) {
      log(`native ${entry.name}: cache hit (${want.slice(0, 12)})`);
    } else {
      log(`native ${entry.name}: compiling ${path.relative(root, source)}`);
      execFileSync(dart, ['compile', 'exe', source, '-o', cached], {
        cwd: root,
        stdio: 'inherit',
        env,
      });
      writeFileSync(stamp, want);
    }

    copyFileSync(cached, entry.out);
    chmodSync(entry.out, 0o755);
    const { size } = statSync(entry.out);
    log(`native ${entry.name}: ${path.relative(root, entry.out)} (${(size / 1e6).toFixed(1)} MB)`);
  }
}

module.exports = { nativeEntries, buildNative, fingerprint, dartFilesUnder, CACHE_DIR, OUT_DIR };
