// Keeping a native task executable alive between calls.
//
// Spawn-per-call costs a process start every time — small against Render's
// per-run overhead, but real in a loop. A worker pays it once and then serves
// requests over the same JSONL protocol, which is why the binary needs no
// changes: its dispatch loop already reads until stdin closes.
//
// The trade-off is state. Top-level variables, caches and open handles persist
// between calls, which is exactly what makes it fast and also means a leak
// accumulates instead of being cleaned up by process exit. Opt-in per entry.
const { spawn } = require('node:child_process');
const path = require('node:path');

/** binary path -> live worker */
const workers = new Map();
let nextId = 1;

function startWorker(binary, idleTimeoutMs) {
  const child = spawn(binary, [], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const worker = {
    child,
    binary,
    idleTimeoutMs,
    pending: new Map(),
    buffer: '',
    stderr: '',
    idleTimer: null,
    dead: false,
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    worker.buffer += chunk;
    let nl;
    while ((nl = worker.buffer.indexOf('\n')) !== -1) {
      const line = worker.buffer.slice(0, nl);
      worker.buffer = worker.buffer.slice(nl + 1);
      routeLine(worker, line);
    }
  });

  // Native code writing to stderr is diagnostics, not protocol. Keep it
  // visible rather than swallowing it, and keep the tail for a crash report.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    worker.stderr = (worker.stderr + chunk).slice(-4096);
    process.stderr.write(`[native ${path.basename(binary)}] ${chunk}`);
  });

  const die = (reason) => {
    worker.dead = true;
    clearTimeout(worker.idleTimer);
    workers.delete(binary);
    // A hung promise is the worst possible failure here — every waiting call
    // gets a real error instead.
    for (const { reject } of worker.pending.values()) {
      reject(new Error(reason));
    }
    worker.pending.clear();
  };

  child.on('exit', (code, signal) => {
    if (worker.pending.size === 0 && !worker.stderr) return void workers.delete(binary);
    die(
      `native worker ${path.basename(binary)} exited ` +
        `${signal ? `on ${signal}` : `with code ${code}`}` +
        `${worker.stderr.trim() ? `: ${worker.stderr.trim()}` : ''}`,
    );
  });
  child.on('error', (e) => die(`native worker ${path.basename(binary)} failed to start: ${e.message}`));

  return worker;
}

function routeLine(worker, line) {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    // Not protocol — surface it rather than dropping it silently.
    process.stderr.write(`[native ${path.basename(worker.binary)}] ${line}\n`);
    return;
  }

  const call = worker.pending.get(message.id);
  if (!call) return;

  call.lines.push(line);
  if ('$ok' in message || '$err' in message) {
    worker.pending.delete(message.id);
    call.resolve(call.lines);
    armIdleTimer(worker);
  }
}

function armIdleTimer(worker) {
  clearTimeout(worker.idleTimer);
  if (worker.idleTimeoutMs <= 0 || worker.pending.size > 0) return;

  worker.idleTimer = setTimeout(() => {
    if (worker.pending.size > 0) return;
    workers.delete(worker.binary);
    worker.child.stdin.end();
    worker.child.kill();
  }, worker.idleTimeoutMs);
  // Never hold the process open just to wait for a reap.
  worker.idleTimer.unref?.();
}

/**
 * Sends one request line and resolves with every reply line for it.
 *
 * Returning raw lines keeps the Dart side identical for both process models —
 * it parses `$log`, `$ok` and `$err` the same way whether they came from a
 * worker or a one-shot spawn.
 */
function nativeCall(binary, requestLine, { idleTimeoutMs = 30000, timeoutMs = 0 } = {}) {
  const resolved = path.resolve(process.cwd(), binary);

  let worker = workers.get(resolved);
  if (!worker || worker.dead || worker.child.exitCode !== null) {
    worker = startWorker(resolved, idleTimeoutMs);
    workers.set(resolved, worker);
  }

  // The id is assigned here, not in Dart: a worker multiplexes calls, so it
  // has to be unique across everything in flight.
  const id = nextId++;
  const request = { ...JSON.parse(requestLine), id };

  clearTimeout(worker.idleTimer);

  return new Promise((resolve, reject) => {
    // A worker handles requests one at a time, so a call that never returns
    // would block every later one. The whole process goes, rather than leaving
    // a worker wedged behind a hung handler.
    let timer = null;
    const settle = (fn) => (value) => {
      if (timer) clearTimeout(timer);
      fn(value);
    };

    worker.pending.set(id, { resolve: settle(resolve), reject: settle(reject), lines: [] });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (!worker.pending.has(id)) return;
        worker.pending.delete(id);
        worker.child.kill('SIGKILL');
        reject(new Error(
          `native worker ${path.basename(resolved)} exceeded ${timeoutMs} ms`,
        ));
      }, timeoutMs);
      timer.unref?.();
    }

    worker.child.stdin.write(`${JSON.stringify(request)}\n`, (e) => {
      if (!e) return;
      const call = worker.pending.get(id);
      worker.pending.delete(id);
      call?.reject(new Error(
        `could not write to native worker ${path.basename(resolved)}: ${e.message}`,
      ));
    });
  });
}

/** Closes every worker's stdin, which its dispatch loop sees as EOF. */
function shutdownWorkers() {
  for (const worker of workers.values()) {
    clearTimeout(worker.idleTimer);
    try {
      worker.child.stdin.end();
    } catch {
      // Already gone.
    }
  }
  workers.clear();
}

function installNativeWorker() {
  if (globalThis.__nativeCall) return;

  globalThis.__nativeCall = (binary, requestLine, options) =>
    nativeCall(binary, requestLine, options ?? {});

  process.once('exit', shutdownWorkers);
}

module.exports = { installNativeWorker, nativeCall, shutdownWorkers, workers };
