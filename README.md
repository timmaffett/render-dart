# render-dart

Write [Render Workflows](https://render.com/docs/workflows) tasks in **Dart**.

Render has no Dart runtime — its workflow runtimes are Node, Python, Go, Ruby
and Elixir. Rather than reach for Docker (which loses API provisioning and
local development), `render-dart` compiles your Dart to JavaScript and
registers it through Render's own `@renderinc/sdk`. Render sees an ordinary
Node workflow; you get real static analysis.

## Quick start

```bash
npx render-dart init my-workflow
cd my-workflow
npm install
npm run dev
```

Then, in another terminal:

```bash
render workflows tasks list --local
render workflows start sumSquares --local --input='[[2,3,4]]'
```

## Writing tasks

```dart
import 'render_dart.dart';

void main() {
  task('calculateSquare', (args) async {
    final n = args[0]! as int;
    return n * n;
  });

  // Each callTask becomes its own task run on its own Render instance.
  task('sumSquares', (args) async {
    var total = 0;
    for (final v in args[0]! as List<Object?>) {
      total += (await callTask('calculateSquare', [v]))! as int;
    }
    return total;
  });

  start();
}
```

## Deploying

```bash
render workflows create --name my-workflow --repo <url> \
  --runtime node --root-directory my-workflow \
  --build-command "npm install && npm run build" \
  --run-command "node index.js"
```

No Dart is needed on Render's builder — `render-dart build` fetches a pinned
SDK when none is present.

> Blueprints (`render.yaml`) do not support Workflows, so provisioning is via
> the CLI, the API, or the Dashboard.

## Commands

| | |
| --- | --- |
| `render-dart build` | Compile `tasks.dart` to `build/tasks.js`, skipping if fresh |
| `render-dart dev` | Build, then start Render's local task server |
| `render-dart init [dir]` | Scaffold a new project |

Configure through `renderDart` in `package.json`:

```json
{
  "renderDart": {
    "entry": "tasks.dart",
    "out": "build/tasks.js",
    "dartVersion": "3.13.0",
    "optimize": "O2",
    "sourceMaps": false,
    "allowDartIo": false
  }
}
```

## Using pub.dev packages

Add them to `pubspec.yaml` as normal; `render-dart build` runs `dart pub get`
for you. What works is determined by dart2js, not by Render:

| | Works? | |
| --- | --- | --- |
| Pure Dart (`collection`, `crypto`, `intl`, `path`) | yes | Nothing to think about |
| `package:http` | yes | Goes through `fetch`, which Node 18+ provides |
| Anything importing `dart:io` | **no** | `File`, `Process`, `Socket`, `HttpClient` |

**`dart:io` is the trap.** dart2js compiles it without complaint and then
throws `Unsupported operation` at runtime — so a task using it deploys cleanly
and fails on its first real run, potentially burning up to the task timeout
first. `render-dart build` therefore refuses to build a project that imports
`dart:io` directly, and tells you what to use instead. Conditional imports
(`if (dart.library.io)`) are left alone, and `allowDartIo` opts out.

For Node APIs beyond HTTP, use `dart:js_interop` directly.

### WebAssembly

Wasm-backed packages work, including ones that carry their own wasm runtime —
but how much the runtime has to provide differs:

| | Needs | Verified |
| --- | --- | --- |
| Uses the platform's `WebAssembly` API (`forge2d`) | asset resolution only | Box2D v3, zero config |
| Carries a JS wasm runtime (`rust_crypto` → `wasm_run`) | asset resolution, `XMLHttpRequest`, and two pre-seeded globals | SHA/MD5/HMAC, cross-checked against pure-Dart `crypto` |

`wasm_run` looks browser-only at first: it loads its WASI shim by injecting a
`<script>` tag into an HTML document. But its setup checks whether the global
is *already* present and skips injection if so. The runtime seeds both:
`wasmFeatureDetect` comes from a UMD bundle shipped inside the pub package, and
`browser_wasi_shim` from npm. It then loads its module over `XMLHttpRequest`,
which the runtime also provides, on top of `fetch`.

For `wasm_run`-based packages, add the shim to your project — it is an
*optional* peer dependency, so nothing else pays for it:

```bash
npm install @bjorn3/browser_wasi_shim
```

Then the package works unmodified, with no `loadModule` callback and no other
setup. Its **native** path stays unavailable, needing `dart:ffi` and a wasmtime
binary; the web executor is what runs here, on the host's own `WebAssembly`.

One caveat worth knowing before combining packages: `rust_crypto` and
`forge2d 0.15` cannot share a pubspec, because `wasm_run` pulls
`build_rust_binaries` → `hooks ^1.0.0` while forge2d needs `hooks ^2.0.0`. Put
them in separate workflows.

`forge2d` — a `dart:ffi` binding to Box2D v3 — selects a bundled 227 KB
WebAssembly build under dart2js, and runs on Render unchanged:

```dart
await initializeForge2D(wasmUri: Uri.parse(fileUri('web/box2d.wasm')));
```

No configuration, no staging step, no `wasmUri`.

A Dart web app serves each package's `lib/` at `packages/<name>/`, and packages
that ship assets ask for them at exactly that path. Nothing serves it under
Node, so the request fails. The runtime resolves those paths from
`.dart_tool/package_config.json` — written by `dart pub get`, so the mapping is
exact rather than guessed — and reads the file directly. Node's `fetch` also
has no `file:` scheme, which the runtime adds for the same reason.

For assets of your own rather than a package's, `fileUri()` resolves a
project-relative path:

```dart
final data = await http.get(Uri.parse(fileUri('data/table.json')));
```

`node:wasi` is not required: forge2d supplies its own WASI shims. It is
available in Node if a module ever needs the real thing.

## Reaching Node from a task

`dart:io` compiles under dart2js and then throws at runtime, so a task cannot
open a file, spawn a process, or reach the npm ecosystem on its own. Two
helpers close that gap.

**Any npm package or Node built-in:**

```dart
@JS()
extension type _Crypto(JSObject _) implements JSObject {
  external String randomUUID();
}

final crypto = _Crypto(requireModule('node:crypto'));
print(crypto.randomUUID());
```

Dart cannot call `require` itself — in CommonJS it is module-scoped, and
`globalThis.require` is undefined in both CommonJS and ESM — so the runtime
hoists it. Resolution is rooted at your project directory, so
`requireModule('lodash')` means whatever *your* package.json depends on.

**Shelling out**, to a CLI tool or to a natively compiled Dart binary shipped
alongside the workflow:

```dart
final result = await runProcess('git', args: ['rev-parse', 'HEAD']);
if (result.ok) print(result.stdout.trim());
```

`runProcess` takes `args`, `workingDirectory`, `environment`, `stdin`,
`timeout` and `runInShell`. A non-zero exit is **returned, not thrown** — an
exit code is a result, and the caller usually wants `stderr` with it. It throws
only when the process could not be started, or when `timeout` elapses (SIGKILL,
since a task run is already bounded by Render's own timeout).

## Two things this package exists to get right

**`RENDER_SDK_AUTO_START` must be `false` before the SDK loads.** The SDK's
`task()` schedules its own `startTaskServer()` via `setImmediate`. Combined
with an explicit start, that produces two task servers and runs **every task
body twice** — doubled side effects and doubled billing. Neither
`render workflows dev` nor Render sets this for you.

**Dart must never throw across the JS boundary.** A Dart exception converted
by `Future.toJS` reaches Render as the opaque *"Dart exception thrown from
converted Future…"*, with the real message boxed out of reach. Task bodies
return a `{$ok}`/`{$err}` envelope instead, and the runtime rethrows a genuine
`Error`, so the actual message lands in the run record.

Both are handled for you. They are documented because they cost real debugging
time to find.

## Build caching on Render

The Dart SDK is unpacked into `node_modules/.dart-sdk`, and the pub cache into
`node_modules/.pub-cache`. Render preserves `node_modules` between builds but
not arbitrary top-level directories — measured, with the SDK elsewhere it was
re-downloaded on every deploy, 33s of a 52s build. Cached, the build step is
about a second.

Use *Clear build cache & deploy* in the Dashboard to force a clean fetch.

## Layout

    src/runtime.js        Loaded by your workflow; bridges Dart to the SDK
    src/web-shims.js      Browser-shaped APIs Node lacks: self, file: fetch,
                          Dart package assets, XMLHttpRequest
    src/node-bridge.js    Node access Dart lacks: require, subprocesses
    src/cli.js            build / dev / init
    src/toolchain/        SDK resolution and compilation, free of Render
                          specifics so it can be extracted later
    template/             What `init` copies

## Licence

MIT
