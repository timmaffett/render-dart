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
const { task, startTaskServer } = require('@renderinc/sdk/workflows');
const { installWebShims, ensureWasmRunGlobals } = require('./web-shims');
const { installNodeBridge } = require('./node-bridge');

// Node lacks several APIs Dart packages assume: `self`, a `file:` scheme for
// fetch, Dart's packages/<name>/ asset paths, and XMLHttpRequest.
installWebShims();

// Reaching npm packages and shelling out. Dart can do neither on its own:
// `require` is module-scoped, and dart:io's Process fails under dart2js.
installNodeBridge();

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
    // Cached, so this is a no-op after the first task and costs nothing at all
    // for projects that do not depend on wasm_run.
    await ensureWasmRunGlobals();
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
