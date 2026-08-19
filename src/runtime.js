// The Node-side runtime for Dart-authored Render Workflows tasks.
//
// Render runs a workflow's start command; that command loads this module,
// which bridges dart2js output to the official @renderinc/sdk.

// MUST run before @renderinc/sdk is required, and is why this module exists
// rather than being inlined into user code.
//
// The SDK's task() schedules its own startTaskServer() via setImmediate as
// soon as it sees RENDER_SDK_SOCKET_PATH. Since we also start the server
// explicitly, leaving auto-start on produces TWO task servers and executes
// every task body TWICE -- doubled side effects and doubled billing. Neither
// `render workflows dev` nor Render in production sets this for us.
process.env.RENDER_SDK_AUTO_START = 'false';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFile } = require('node:fs/promises');
const { task, startTaskServer } = require('@renderinc/sdk/workflows');

// dart2js output expects `self` to exist. Without it the async scheduler
// fails *silently* -- the program prints nothing and exits 0.
globalThis.self ??= globalThis;

// Node's fetch has no file: support, so Dart packages that load bundled
// assets through fetch -- wasm modules especially -- cannot find them.
// Teaching fetch the scheme makes those packages work unchanged; forge2d's
// bundled Box2D wasm build loads this way, and so do several others.
//
// Everything that is not file: is delegated to the real fetch untouched.
if (typeof globalThis.fetch === 'function' && !globalThis.fetch.__renderDartFilePatch) {
  const realFetch = globalThis.fetch;

  const patched = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input && input.url) || String(input);

    if (!url.startsWith('file:')) return realFetch(input, init);

    try {
      const bytes = await readFile(new URL(url));
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': url.endsWith('.wasm')
            ? 'application/wasm'
            : 'application/octet-stream',
        },
      });
    } catch (e) {
      // Match fetch's contract: a missing file is a 404, not a throw, so
      // callers trying several candidate URLs can keep going.
      if (e.code === 'ENOENT' || e.code === 'EISDIR') {
        return new Response(null, { status: 404, statusText: 'Not Found' });
      }
      throw e;
    }
  };

  patched.__renderDartFilePatch = true;
  globalThis.fetch = patched;
}

/**
 * Turns a project-relative path into a file: URL the patched fetch can read.
 *
 * Exposed to Dart so a task can point a package at a bundled asset, e.g.
 * `initializeForge2D(wasmUri: Uri.parse(fileUri('web/box2d.wasm')))`.
 */
globalThis.__fileUri = (relativePath) =>
  pathToFileURL(path.resolve(process.cwd(), relativePath)).href;

/** Registered tasks, by name, as returned by the SDK's task(). */
const wrapped = Object.create(null);

/**
 * Registers a Dart task. Called by the compiled Dart bundle, not by hand.
 *
 * Two adaptations happen here:
 *  1. Varargs collapse into a single array, so the Dart side can expose
 *     fixed-arity closures instead of guessing each task's parameter count.
 *  2. The Dart result envelope is unwrapped. Dart must never throw across the
 *     boundary: a converted Dart exception reaches Render as the opaque
 *     "Dart exception thrown from converted Future...", with the real message
 *     boxed out of reach. Task bodies return {$ok} or {$err} instead, and the
 *     failure becomes a genuine Error here.
 */
globalThis.__registerTask = (name, fn, options) => {
  wrapped[name] = task({ name, ...(options ?? {}) }, async (...args) => {
    const env = await fn(args);
    if (env && env.$err !== undefined) throw new Error(env.$err);
    return env ? env.$ok : undefined;
  });
};

/**
 * Invokes another task as a child run. Calling an SDK-wrapped function from
 * inside an executing task is what makes Render spawn a subtask.
 */
globalThis.__callTask = (name, args) => {
  const fn = wrapped[name];
  if (!fn) {
    throw new Error(
      `Task '${name}' is not registered. Tasks must be registered at module ` +
        `level, before the task server starts.`,
    );
  }
  return fn(...args);
};

/**
 * Starts the task server.
 *
 * The SDK reports a failure over /callback and then rethrows, which would
 * otherwise surface as an unhandled rejection and a wall of compiled-JS
 * stack. The run is already recorded failed by that point, so exit cleanly
 * with the message.
 */
globalThis.__start = () =>
  startTaskServer().catch((e) => {
    console.error('[render-dart] task failed:', e && e.message ? e.message : e);
    process.exit(1);
  });

/**
 * Loads a compiled Dart bundle, which registers its tasks and starts serving.
 *
 * @param {string} bundlePath Path to dart2js output, relative to the caller.
 */
function runTasks(bundlePath = './build/tasks.js') {
  const resolved = path.isAbsolute(bundlePath)
    ? bundlePath
    : path.resolve(process.cwd(), bundlePath);
  require(resolved);
}

module.exports = { runTasks };
