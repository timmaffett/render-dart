// Access to the Node platform that Dart cannot reach on its own.
//
// Two gaps, both structural rather than incidental:
//
//   `require` is module-scoped in CommonJS, and `globalThis.require` is
//   undefined in both CommonJS and ESM -- verified, not assumed. A compiled
//   Dart task therefore cannot load an npm package without a hoist.
//
//   `dart:io` compiles under dart2js and throws at runtime, so `Process` is
//   unavailable. Shelling out has to go through Node.

const { createRequire } = require('node:module');
const path = require('node:path');

/**
 * Loads an npm package or Node built-in, by name.
 *
 * Dart cannot reach `require` on its own: in CommonJS it is module-scoped, and
 * `globalThis.require` is undefined in both CommonJS and ESM. Hoisting it here
 * is the only way a compiled Dart task can use the npm ecosystem.
 *
 *     final crypto = requireModule('node:crypto');
 */
function nodeRequire(id) {
  return projectRequire()(id);
}

/**
 * A `require` rooted at the project directory rather than at this file.
 *
 * Resolving from inside `node_modules/render-dart/src/` happens to reach the
 * project's dependencies by walking up, but that is an accident of layout that
 * pnpm and workspaces can break. Rooting at the working directory makes
 * `requireModule('lodash')` mean what the task author expects: whatever their
 * own package.json depends on.
 */
let cachedRequire;
function projectRequire() {
  cachedRequire ??= createRequire(path.join(process.cwd(), 'noop.js'));
  return cachedRequire;
}

/**
 * Runs a command to completion and captures its output.
 *
 * `dart:io` compiles under dart2js and then fails at runtime, so `Process` is
 * unavailable to a task. This is the sanctioned way to shell out — to a CLI
 * tool, or to a natively compiled Dart binary shipped alongside the workflow.
 *
 * Resolves with `{code, stdout, stderr}` even when the command exits non-zero:
 * an exit code is a result, not an exception. It rejects only when the process
 * could not be started at all.
 */
function runProcess(command, args, options) {
  const { spawn } = require('node:child_process');
  const opts = options ?? {};

  return new Promise((resolve, reject) => {
    const child = spawn(command, args ?? [], {
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      shell: opts.shell ?? false,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => (stdout += chunk));
    child.stderr?.on('data', (chunk) => (stderr += chunk));

    let timer;
    if (opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        // SIGKILL rather than SIGTERM: a task run is capped by Render's own
        // timeout, and a process ignoring SIGTERM would burn the whole budget.
        child.kill('SIGKILL');
        if (!settled) {
          settled = true;
          reject(new Error(
            `\`${command}\` exceeded its ${opts.timeoutMs}ms timeout`,
          ));
        }
      }, opts.timeoutMs);
    }

    child.on('error', (e) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(e);
      }
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code: code ?? -1, signal: signal ?? null, stdout, stderr });
    });

    if (opts.stdin !== undefined && opts.stdin !== null) {
      child.stdin?.end(opts.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

/** Installs both globals. Safe to call more than once. */
function installNodeBridge() {
  if (globalThis.__require === undefined) globalThis.__require = nodeRequire;
  if (globalThis.__run === undefined) globalThis.__run = runProcess;
}

module.exports = { installNodeBridge, nodeRequire, runProcess };
