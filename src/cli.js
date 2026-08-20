#!/usr/bin/env node
// render-dart CLI: build, dev, init.

const { spawn } = require('node:child_process');
const { cp, mkdir, readFile, rename, writeFile } = require('node:fs/promises');
const { existsSync, readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const { version } = require('../package.json');
const { resolveDart } = require('./toolchain/dart-sdk');
const { compile, findDartIoImports, isFresh, pubGet } = require('./toolchain/compile');
const { nativeEntries, buildNative, writeGeneratedIgnores } = require('./toolchain/native');
const { generate, ensureRuntimeFile } = require('./toolchain/generate');

const DEFAULT_DART_VERSION = '3.13.0';

const log = (m) => console.log(`[render-dart] ${m}`);
const fail = (m) => {
  console.error(`[render-dart] ${m}`);
  process.exit(1);
};

/** Reads render-dart settings from the project's package.json. */
async function config(root) {
  let pkg = {};
  try {
    pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  } catch {
    // A project without package.json is fine; defaults apply.
  }
  const c = pkg.renderDart ?? {};
  return {
    entry: path.resolve(root, c.entry ?? 'tasks.dart'),
    out: path.resolve(root, c.out ?? 'build/tasks.js'),
    dartVersion: c.dartVersion ?? DEFAULT_DART_VERSION,
    optimize: c.optimize ?? 'O2',
    sourceMaps: c.sourceMaps ?? false,
    allowDartIo: c.allowDartIo ?? false,
    // Directories whose dart:io use is legitimate — a local tool sitting
    // beside the workflow, say. Narrower than allowDartIo, which switches the
    // check off for task code too.
    allowDartIoIn: c.allowDartIoIn ?? [],
    native: c.native ?? [],
  };
}

async function build(root, { force = false } = {}) {
  const c = await config(root);

  if (!existsSync(c.entry)) {
    fail(
      `No Dart entrypoint at ${path.relative(root, c.entry)}. ` +
        `Create one, or set renderDart.entry in package.json.`,
    );
  }

  let native;
  try {
    native = nativeEntries(root, c.native);
  } catch (e) {
    fail(e.message);
  }
  for (const entry of native) {
    if (!existsSync(entry.entry)) {
      fail(`renderDart.native lists ${entry.rel}, which does not exist.`);
    }
  }

  // Native entries have their own content-hash cache, so the mtime check only
  // decides whether dart2js needs to run again.
  const jsFresh = !force && (await isFresh(root, c.out));
  if (native.length === 0 && jsFresh) {
    log('output is up to date, skipping compile');
    return c.out;
  }

  if (!c.allowDartIo) {
    // Declared native sources are compiled AOT, where dart:io works — as is
    // native_task.dart, which is our own runtime for that side and is never
    // reachable from the dart2js entrypoint.
    const io = await findDartIoImports(root, [
      ...native.map((n) => n.dir),
      ...c.allowDartIoIn.map((d) => path.resolve(root, d)),
      path.join(root, 'native_task.dart'),
    ]);
    if (io.length > 0) {
      const where = io.map((h) => `  ${h.file}:${h.line}`).join('\n');
      fail(
        `dart:io is imported, but tasks are compiled with dart2js and dart:io ` +
          `does not work there.\n\n${where}\n\n` +
          `It compiles without error and then throws "Unsupported operation" ` +
          `on the first run, so this would fail in production rather than here.\n\n` +
          `Use package:http (which works — it goes through fetch) instead of ` +
          `HttpClient, and dart:js_interop for anything else Node provides.\n` +
          `Set "renderDart": { "allowDartIo": true } in package.json to skip ` +
          `this check.`,
      );
    }
  }

  const dart = await resolveDart({
    root,
    version: c.dartVersion,
    log,
  });

  // Only needed when the project declares pub dependencies, but harmless
  // otherwise and far cheaper than diagnosing a missing package_config.
  let pubCache;
  if (existsSync(path.join(root, 'pubspec.yaml'))) {
    pubCache = pubGet(dart, root, log);
  }


  // Flag a render_dart.dart left behind by an older render-dart before
  // anything can fail against a signature it does not have.
  ensureRuntimeFile(root, 'render_dart.dart', log);

  // Generation comes first: the stubs it writes are what tasks.dart imports,
  // so dart2js must not run before they exist.
  if (native.length > 0) {
    try {
      for (const entry of native) {
        if (entry.mode === 'task') {
          entry.main = generate({ dart, root, entry, pubCache, log });
        }
      }
      writeGeneratedIgnores(root, native);
      await buildNative({ dart, root, entries: native, pubCache, log });
    } catch (e) {
      fail(e.message);
    }
  }

  if (jsFresh) {
    log('JavaScript output is up to date, skipping compile');
    return c.out;
  }

  await compile({
    dart,
    root,
    entry: c.entry,
    out: c.out,
    optimize: c.optimize,
    sourceMaps: c.sourceMaps,
    pubCache,
    log,
  });
  return c.out;
}

/** Builds, then hands off to the Render CLI's local task server. */
async function dev(root, args) {
  await build(root);

  const startCommand = args.length > 0 ? args : ['node', 'index.js'];
  log(`starting local task server: render workflows dev -- ${startCommand.join(' ')}`);

  const child = spawn(
    'render',
    ['workflows', 'dev', '--', ...startCommand],
    { cwd: root, stdio: 'inherit' },
  );
  child.on('error', (e) => {
    if (e.code === 'ENOENT') {
      fail(
        'The Render CLI is not installed. Install it with `brew install render`, ' +
          'or see https://render.com/docs/cli',
      );
    }
    fail(e.message);
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

const EXAMPLES_DIR = path.join(__dirname, '..', 'examples');
const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');

/** Template names, read from the directory rather than a hardcoded list. */
function templates() {
  return readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Copies an example into a new directory as a starting point. */
async function init(root, args) {
  // Templates are the examples, so every one of them is provably runnable —
  // there is no second copy to drift.
  const template = args.find((a) => a.startsWith('--template='))?.split('=')[1] ??
      (args.includes('--template') ? args[args.indexOf('--template') + 1] : null) ??
      'default';

  const available = templates();
  if (!available.includes(template)) {
    fail(`No template named "${template}". Available: ${available.join(', ')}`);
  }

  const positional = args.filter((a, i) =>
      !a.startsWith('--') && args[i - 1] !== '--template');
  const target = path.resolve(root, positional[0] ?? 'dart-workflow');
  if (existsSync(target)) fail(`${target} already exists.`);

  await mkdir(target, { recursive: true });
  // An example is a working project, so its directory also holds build output
  // and resolved dependencies. None of that belongs in a fresh scaffold, and
  // copying a lockfile would pin someone to whatever was resolved here.
  const skip = new Set([
    'README.md',
    'node_modules',
    'build',
    '.dart_tool',
    'pubspec.lock',
    'package-lock.json',
  ]);

  // The build writes a native/.gitignore naming what it generated. Reusing
  // that list means a scaffold never carries a stale facade or stub, without
  // this having to guess at their names.
  const generatedList = path.join(EXAMPLES_DIR, template, 'native', '.gitignore');
  if (existsSync(generatedList)) {
    for (const line of readFileSync(generatedList, 'utf8').split('\n')) {
      const name = line.trim();
      if (name && !name.startsWith('#')) skip.add(name);
    }
  }

  await cp(path.join(EXAMPLES_DIR, template), target, {
    recursive: true,
    filter: (src) => !skip.has(path.basename(src)),
  });

  // The Dart bridge files are not kept in the examples — `build` writes them
  // when missing, which is also how they stay current on upgrade. A scaffold
  // gets them up front so the project analyses before its first build.
  for (const name of ['render_dart.dart', 'native_task.dart']) {
    await cp(path.join(RUNTIME_DIR, name), path.join(target, name));
  }

  // Guidance for coding agents, in the one place they will reliably look.
  // An agent helping in this project never opens node_modules, so nothing we
  // ship inside the package reaches it.
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    await cp(path.join(RUNTIME_DIR, name), path.join(target, name));
  }

  // npm strips .gitignore from published packages, so the template ships it
  // as `gitignore` and it gets its real name back here.
  const shipped = path.join(target, 'gitignore');
  if (existsSync(shipped)) await rename(shipped, path.join(target, '.gitignore'));

  // Name the project after its directory, and pin render-dart to whatever
  // version is doing the scaffolding.
  //
  // The template used to carry a hardcoded range, which silently went stale:
  // `^0.1.0` means `<0.2.0` for a 0.x package, so every project scaffolded
  // after 0.2.0 quietly installed 0.1.1 and missed everything since. Deriving
  // it here means it cannot drift again.
  const pkgPath = path.join(target, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  pkg.name = path.basename(target);
  pkg.dependencies['render-dart'] = `^${version}`;
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  log(`created ${path.relative(root, target) || target}`);
  console.log(`
Next:
  cd ${path.relative(root, target) || target}
  npm install
  npx render-dart dev

Then deploy with runtime "node", root directory "${path.basename(target)}",
build command "npm install && npm run build", start command "npm start".
`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const root = process.cwd();

  switch (command) {
    case 'build':
      await build(root, { force: args.includes('--force') });
      break;
    case 'dev':
      await dev(root, args);
      break;
    case 'init':
      await init(root, args);
      break;
    default:
      console.log(`render-dart — write Render Workflows tasks in Dart

Usage:
  render-dart build [--force]   Compile tasks.dart to build/tasks.js
  render-dart dev [-- cmd...]   Build, then run the local task server
  render-dart init [dir] [--template <name>]
                                Scaffold a new Dart workflow project

Configure via "renderDart" in package.json:
  entry, out, dartVersion, optimize, sourceMaps, allowDartIo, allowDartIoIn,
  native
`);
      process.exit(command ? 1 : 0);
  }
}

main().catch((e) => fail(e.message));
