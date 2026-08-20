#!/usr/bin/env node
// render-dart CLI: build, dev, init.

const { spawn } = require('node:child_process');
const { cp, mkdir, readFile, rename, writeFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');

const { version } = require('../package.json');
const { resolveDart } = require('./toolchain/dart-sdk');
const { compile, findDartIoImports, isFresh, pubGet } = require('./toolchain/compile');

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

  if (!force && (await isFresh(root, c.out))) {
    log('output is up to date, skipping compile');
    return c.out;
  }

  if (!c.allowDartIo) {
    const io = await findDartIoImports(root);
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

/** Copies the starter template into a new directory. */
async function init(root, args) {
  const target = path.resolve(root, args[0] ?? 'dart-workflow');
  if (existsSync(target)) fail(`${target} already exists.`);

  await mkdir(target, { recursive: true });
  await cp(path.join(__dirname, '..', 'template'), target, { recursive: true });

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
  render-dart init [dir]        Scaffold a new Dart workflow project

Configure via "renderDart" in package.json:
  entry, out, dartVersion, optimize, sourceMaps, allowDartIo
`);
      process.exit(command ? 1 : 0);
  }
}

main().catch((e) => fail(e.message));
