// Browser-shaped APIs that Dart packages expect and Node does not provide.
//
// Kept separate from the Render task bridge: none of this knows what a
// workflow is, and all of it is independently testable.

const { readFile } = require('node:fs/promises');
const { pathToFileURL, fileURLToPath } = require('node:url');
const path = require('node:path');

/**
 * dart2js output expects `self` to exist.
 *
 * Without it the async scheduler fails *silently* — the program prints
 * nothing, never completes its futures, and exits 0.
 */
function installSelf() {
  globalThis.self ??= globalThis;
}

/**
 * Resolves Dart's web package-asset convention against the real pub layout.
 *
 * A Dart web app serves a package's lib/ directory at `packages/<name>/`, and
 * packages that ship assets ask for them at exactly that path. Nothing serves
 * it under Node, so those requests fail — which is why a package like forge2d
 * cannot find its bundled wasm module here.
 *
 * `.dart_tool/package_config.json`, written by `dart pub get`, maps every
 * package to its root, so the mapping is reconstructed exactly rather than
 * guessed. Read lazily and cached: most tasks never load an asset.
 */
let packageRootsPromise;

function packageRoots() {
  packageRootsPromise ??= (async () => {
    const configPath = path.resolve(
      process.cwd(),
      '.dart_tool',
      'package_config.json',
    );
    try {
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      const roots = new Map();
      for (const pkg of config.packages ?? []) {
        // rootUri may be absolute, or relative to .dart_tool/.
        const root = new URL(pkg.rootUri, pathToFileURL(configPath));
        roots.set(pkg.name, new URL(pkg.packageUri ?? 'lib/', `${root}/`));
      }
      return roots;
    } catch {
      // No pub dependencies, or pub get has not run. Nothing to resolve.
      return new Map();
    }
  })();
  return packageRootsPromise;
}

/** `packages/<name>/<path>` or `package:<name>/<path>` -> a file: URL. */
async function resolvePackageAsset(url) {
  const match =
    /^package:([A-Za-z_][A-Za-z0-9_]*)\/(.+)$/.exec(url) ??
    /^\/?packages\/([A-Za-z_][A-Za-z0-9_]*)\/(.+)$/.exec(url);
  if (!match) return null;

  const [, name, rest] = match;
  const libUri = (await packageRoots()).get(name);
  return libUri ? new URL(rest, libUri).href : null;
}

/**
 * Teaches fetch the `file:` scheme and Dart's package-asset paths.
 *
 * Node's fetch supports `data:` but not `file:`, so packages that load bundled
 * assets through fetch cannot find them. Anything else is delegated to the
 * real fetch untouched.
 */
function installFetch() {
  if (typeof globalThis.fetch !== 'function') return;
  if (globalThis.fetch.__renderDartFilePatch) return;

  const realFetch = globalThis.fetch;

  const patched = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input && input.url) || String(input);

    let target = url;
    if (!target.startsWith('file:')) {
      const resolved = await resolvePackageAsset(target);
      if (resolved === null) return realFetch(input, init);
      target = resolved;
    }

    try {
      const bytes = await readFile(new URL(target));
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': target.endsWith('.wasm')
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
 * A minimal XMLHttpRequest over fetch.
 *
 * Most Dart packages reach the network through package:http, which uses fetch
 * and already works. Some load assets with XHR directly — wasm_run does — and
 * would otherwise fail with "XMLHttpRequest is not a constructor".
 *
 * This covers what asset loading needs: GET, arraybuffer and text responses,
 * and the load/error/loadend events Dart listens for. Deliberately not a
 * complete XHR: no sync mode, no upload progress, no response headers.
 */
function installXmlHttpRequest() {
  if (typeof globalThis.XMLHttpRequest !== 'undefined') return;

  globalThis.XMLHttpRequest = class XMLHttpRequest {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.response = null;
      this.responseText = '';
      this.responseType = '';
      this.timeout = 0;
      this.withCredentials = false;
      this._headers = {};
      this._listeners = Object.create(null);
    }

    open(method, url) {
      this._method = method;
      this._url = url;
      this.readyState = 1;
    }

    setRequestHeader(key, value) {
      this._headers[key] = value;
    }

    addEventListener(type, fn) {
      (this._listeners[type] ??= []).push(fn);
    }

    removeEventListener(type, fn) {
      this._listeners[type] = (this._listeners[type] ?? []).filter(
        (f) => f !== fn,
      );
    }

    getAllResponseHeaders() {
      return '';
    }

    abort() {}

    _emit(type) {
      const event = { type, target: this, currentTarget: this };
      for (const fn of this._listeners[type] ?? []) fn.call(this, event);
      const handler = this[`on${type}`];
      if (typeof handler === 'function') handler.call(this, event);
    }

    send(body) {
      globalThis
        .fetch(this._url, {
          method: this._method ?? 'GET',
          headers: this._headers,
          body,
        })
        .then(async (res) => {
          this.status = res.status;
          this.readyState = 4;
          if (this.responseType === 'arraybuffer') {
            this.response = await res.arrayBuffer();
          } else {
            this.responseText = await res.text();
            this.response = this.responseText;
          }
          this._emit('load');
          this._emit('loadend');
        })
        .catch(() => {
          this.status = 0;
          this.readyState = 4;
          this._emit('error');
          this._emit('loadend');
        });
    }
  };
}

/**
 * Seeds the two globals wasm_run would otherwise load by injecting `<script>`
 * tags into an HTML document.
 *
 * wasm_run's setup checks whether each global is already present and skips
 * injection when it is, so providing them removes its only need for a DOM. Its
 * native executor still requires dart:ffi and is unavailable here; the web
 * executor runs on the host's own WebAssembly, which Node has.
 *
 * Does nothing unless wasm_run is actually a dependency.
 */
let wasmRunGlobalsPromise;

function ensureWasmRunGlobals() {
  wasmRunGlobalsPromise ??= (async () => {
    const wasmRunLib = (await packageRoots()).get('wasm_run');
    if (!wasmRunLib) return;

    // Shipped inside the pub package as a UMD bundle that assigns itself to
    // globalThis, so no npm dependency is needed for this one.
    if (globalThis.wasmFeatureDetect === undefined) {
      try {
        require(
          fileURLToPath(new URL('assets/wasm-feature-detect.js', wasmRunLib)),
        );
      } catch {
        // Older wasm_run, or the asset moved. wasm_run falls back to its own
        // loading path and reports the problem itself.
      }
    }

    // The shipped asset pulls this from a CDN and hangs it on `window`; the
    // same module is on npm. Optional: only projects using wasm_run need it.
    if (globalThis.browser_wasi_shim === undefined) {
      try {
        const shim = await import('@bjorn3/browser_wasi_shim');
        globalThis.browser_wasi_shim = {
          WASI: shim.WASI,
          Fd: shim.Fd,
          File: shim.File,
          Directory: shim.Directory,
          OpenFile: shim.OpenFile,
          OpenDirectory: shim.OpenDirectory,
          PreopenDirectory: shim.PreopenDirectory,
          strace: shim.strace,
        };
      } catch {
        // Not installed. Only WASI modules need it, and wasm_run raises a
        // clear error if one turns out to.
      }
    }
  })();
  return wasmRunGlobalsPromise;
}

/** Installs every shim. Safe to call more than once. */
function installWebShims() {
  installSelf();
  installFetch();
  installXmlHttpRequest();
}

module.exports = {
  installWebShims,
  installSelf,
  installFetch,
  installXmlHttpRequest,
  ensureWasmRunGlobals,
  packageRoots,
  resolvePackageAsset,
};
