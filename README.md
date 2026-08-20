# render-dart

> ## ⚠️ UNOFFICIAL
>
> An independent, community-built project. **Not affiliated with, endorsed by,
> or supported by [Render](https://render.com).**
>
> Render's own SDKs and documentation are at
> [render.com/docs](https://render.com/docs).

[![Render](https://raw.githubusercontent.com/timmaffett/render-dart/main/doc/render-logo.png)](https://render.com)

<sub>The Render name and logo are trademarks of Render Services, Inc.
The mark itself is unmodified, shown on white with the clear space
Render's brand kit specifies, referentially — to identify the service
these packages work with, not to suggest any endorsement.</sub>

Write [Render Workflows](https://render.com/docs/workflows) tasks in **Dart**,
on [Render](https://render.com).

[Render Workflows](https://render.com/docs/workflows) is in public beta and has
no built-in way to use Dart: tasks are defined with Render's own SDK, which is
available for **TypeScript and Python** only. Their docs say SDKs for more
languages are planned.

The gap is the SDK rather than the runtime — a workflow service can run on
`node`, `python`, `go`, `ruby` or `elixir`, but without an SDK for your
language there is nothing to register tasks with.

`render-dart` closes it from the other side, without reaching for Docker (which
would cost API provisioning and local development). It compiles Dart **two
ways**:

- **Task bodies to JavaScript**, with `dart compile js`, registered through
  Render's `@renderinc/sdk`. Render sees an ordinary Node workflow.
- **Anything needing the real platform to a native executable**, with
  `dart compile exe`. The JavaScript side becomes a generated shim that calls
  it, so the task code still reads as a plain Dart call. That is what reaches
  `dart:io`, `dart:ffi`, isolates, and packages like `postgres` that have no
  web build at all.

Both are compiled during the deploy, on Render's own hardware — nothing binary
is committed. You get real static analysis over the whole thing.

## The Dart side of Render

This package covers **writing** tasks. Two companion Dart packages cover the
rest, and neither is required to use this one:

| | |
| --- | --- |
| `render-dart` (this) | **Writing** tasks in Dart |
| [`render_workflows`](https://pub.dev/packages/render_workflows) | **Running** them — start, watch, cancel, fan out |
| [`render_api`](https://pub.dev/packages/render_api) | **Managing** the services — create, deploy, inspect |

So a Flutter app can trigger a task with `render_workflows` that a Dart
workflow, built here, then executes.

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

## Examples, which are also templates

```bash
npx render-dart init my-app --template postgres
```

| | Answers |
| --- | --- |
| [`default`](examples/default) | Writing a task, fanning out, retrying |
| [`http`](examples/http) | Calling an external API |
| [`native`](examples/native) | Files, subprocesses, FFI, more than one core |
| [`postgres`](examples/postgres) | Reaching a database |
| [`introspect`](examples/introspect) | Inspecting Render, or running a task in another workflow |

Each is a complete service you can run, and `init` scaffolds from it — so a
template that does not work is a test failure rather than a surprise.

## Coding agents

Agents never read `node_modules`, so nothing shipped inside this package
reaches one helping in your project. `render-dart init` therefore writes an
`AGENTS.md` (and a `CLAUDE.md` pointing at it) **into the project it creates**,
covering the traps, when to reach for a native task, and how to get at a
database.

If you are an agent reading this page: the short version is that task bodies
are dart2js, `dart:io` does not work there, `package:http` does, and anything
needing files, FFI, a database or a second core goes through a native task —
see [Two ways past dart2js](#two-ways-past-dart2js). Native is **not** faster
at arithmetic.

There is also a Claude skill in the repository at
`.claude/skills/render-dart/`. It is not in the npm tarball, since skills are
not loaded from `node_modules`:

```bash
cp -r render-dart/.claude/skills/render-dart ~/.claude/skills/
```

`AGENTS.md` in the repository root is guidance for working *on* this package,
which is a different thing.

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
    "allowDartIo": false,
    "native": []
  }
}
```

`native` lists Dart files to compile to native executables — see
[Native tasks](#native-tasks). Each entry is a path, or an object that can
override what the source declared:

```json
"native": [
  "native/tools_impl.dart",
  { "entry": "native/raw_impl.dart", "mode": "exe" },
  { "entry": "native/hot_impl.dart", "worker": false }
]
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

Packages that ship a `.wasm` module work, and they are often the **simpler**
choice: the module runs inside the Node process, so there is no subprocess, no
second binary, and no build step beyond the one you already have.

When a package has no wasm build — or the work needs files, sockets or more
than one core — [native tasks](#two-ways-past-dart2js) are the other route.

Two shapes, both verified on Render, differing in how much the runtime has to
supply:

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

**Shelling out** to a CLI tool. (For calling *Dart* compiled natively, use
[native tasks](#native-tasks) rather than driving a process by hand.)

```dart
final result = await runProcess('git', args: ['rev-parse', 'HEAD']);
if (result.ok) print(result.stdout.trim());
```

`runProcess` takes `args`, `workingDirectory`, `environment`, `stdin`,
`timeout` and `runInShell`. A non-zero exit is **returned, not thrown** — an
exit code is a result, and the caller usually wants `stderr` with it. It throws
only when the process could not be started, or when `timeout` elapses (SIGKILL,
since a task run is already bounded by Render's own timeout).

## Two ways past dart2js

dart2js cannot open a file, use a second core, or run a package that needs
`dart:io`. There are two escapes, and they are complementary rather than
ranked.

| | WebAssembly | Native task |
| --- | --- | --- |
| Runs in | the Node process | a subprocess |
| Needs | the package to ship a `.wasm` | nothing — any Dart compiles |
| `dart:io`, sockets, files | no | **yes** |
| `dart:ffi` | no | **yes** |
| More than one core | no | **yes**, isolates |
| Per-call cost | none | ~0.5 ms with a worker |
| Extra artefact | none | a binary, built during the deploy |

**Reach for wasm when the package already has one.** `forge2d` and
`rust_crypto` both do, and `render-dart` resolves their modules without
configuration. Nothing is spawned and nothing is compiled.

**Reach for native when there is no wasm build, when the work needs I/O or
FFI, or when it needs to use more than one core.** `package:postgres` is the
clearest case: it speaks the wire protocol over a raw socket, and pub.dev marks
it `runtime:native-aot` with no `runtime:web`. There is no wasm alternative and
no dart2js path — native or nothing.

### What native is *not*

It is not a way to make computation faster. The same recursive fib, compiled
both ways and run on Render:

| n | dart2js | native |
| --- | --- | --- |
| 30 | 8 ms | 23 ms |
| 34 | 60 ms | 50 ms |
| 36 | 146 ms | 131 ms |

V8 matches Dart AOT on pure integer work, and beats it at small n. If your task
is arithmetic, dart2js is already fine.

The speed win that *is* real is **parallelism**, because dart2js inherits
JavaScript's single thread. The same batch of fib(32), run sequentially in
JavaScript and across isolates natively:

| jobs | dart2js seq | native parallel | speedup |
| ---: | ---: | ---: | ---: |
| 2 | 46 ms | 31 ms | 1.5x |
| 4 | 88 ms | 48 ms | 1.8x |
| 8 | 177 ms | 84 ms | 2.1x |
| 16 | 367 ms | 219 ms | 1.7x |
| 32 | 706 ms | 533 ms | 1.3x |

**Treat that as anecdote.** It is one workload on one Render instance, on the
default `starter` task plan in a free workspace — the smallest there is. A
different plan, or different work, would produce a different curve.

What it does illustrate is a shape worth expecting: the benefit is real, it
does not grow indefinitely, and past some point more isolates cost more than
they return. The dart2js column stays flat at ~22 ms per job throughout, which
is the control confirming the native side's rise is not noise.

`Platform.numberOfProcessors` reported 32 the whole time, which was not a
useful guide to any of this. Measure the workload on the plan it will run on.

## Native tasks

Write the function once, compile it AOT, and call it from task code as if it
were local — no process handling, no serialisation, nothing at the call site
that says it is native.

Write the implementation in `<name>_impl.dart`:

```dart
// native/tools_impl.dart
import 'dart:io';

import '../native_task.dart';

@nativeTask
Map<String, Object?> inspect(String path) => {
      'bytes': File(path).lengthSync(),
      'lines': File(path).readAsLinesSync().length,
    };
```

Declare it, and call it by its plain name:

```json
"renderDart": { "native": ["native/tools_impl.dart"] }
```

```dart
// tasks.dart — nothing here says "native"
import 'native/tools.dart';

task('inspect', (args) async => await inspect(args[0]! as String));
```

`render-dart build` generates `native/tools.dart` as a conditional export:

```dart
export 'tools.stub.dart' if (dart.library.io) 'tools_impl.dart';
```

so the **same source** compiles to a process call under dart2js and a direct
call natively. That also means native code can be unit-tested on the Dart VM,
and a native function calling a sibling skips the process hop entirely.

Always `await` a native task — the stub returns a `Future` where the
implementation may return a plain value, and awaiting is what makes one piece of
code valid on both sides.

### What can cross

Parameters and return values are JSON, so: `bool`, `int`, `double`, `num`,
`String`, `List<T>`, `Map<String, T>`, `Object?`, `dynamic`, and `Future<T>` of
those, nullable included. Required, optional and named parameters all work,
with their defaults.

Anything else — a custom class, `Uint8List`, `Set`, a record — is **rejected at
build time**, naming the parameter, rather than failing as a decode error on a
live run.

### Options ride with the declaration

So a call site never has to know, and never has to be updated when you change
your mind:

```dart
@NativeTask(worker: true, idleTimeout: Duration(seconds: 30))
Future<int> hot(int a) async => a;
```

| | |
| --- | --- |
| `worker` | Keep the executable alive between calls. Default `false` |
| `idleTimeout` | How long an idle worker lingers. Default 30 s |
| `timeout` | How long one call may take. Default none |

`renderDart.native` can override any of them per entry, so a deployment can
change behaviour without editing code. To vary them for one caller — without
changing any signature, which is what keeps the one-source property:

```dart
await NativeCall.scope(worker: false, () async => hot(1));
```

### Worker mode

Measured on Render, 20 calls:

| | processes | time |
| --- | --- | --- |
| spawn per call | 20 | 112 ms |
| worker | 1 | **9 ms** |

It is opt-in because a worker keeps top-level state between calls. That is what
makes it fast, and it also means a leak accumulates instead of being cleaned up
by process exit, and one call can observe what the last one left behind. A call
that throws does *not* kill the worker; a process that dies rejects everything
in flight with its exit code and stderr, then respawns on the next call.

### The wire, and errors

One JSON object per line (JSONL) over stdin/stdout. `print()` on the native side
arrives as a `$log` line and is forwarded to the task log — on stdout it would
corrupt the framing, so it is rerouted rather than left to break things. A
native `throw` arrives as a `NativeTaskException` carrying the real message and
the native stack trace.

### A worked example: Postgres

`package:postgres` speaks the wire protocol over a raw socket. pub.dev marks it
`runtime:native-aot` and `runtime:native-jit`, with **no** `runtime:web` — it
cannot run under dart2js at all, and there is no wasm build to fall back on.
Native is the only route to a database from a Dart workflow.

```dart
// native/db_impl.dart
@NativeTask(worker: true, idleTimeout: Duration(minutes: 2))
Future<List<Map<String, Object?>>> listWidgets({int limit = 20}) async {
  final db = await _db();                       // held open between calls
  final rows = await db.execute(
    Sql.named('select * from widgets limit @limit'),
    parameters: {'limit': limit},
  );
  return rows.map(_jsonRow).toList();
}
```

```dart
// tasks.dart
import 'native/db.dart';

task('listWidgets', (args) async => await listWidgets(limit: 20));
```

Worker mode earns its keep here: the process stays alive, so the TCP handshake,
TLS negotiation and Postgres authentication happen once rather than per call.
`pg_backend_pid()` proves it from the server's side — it stays constant across
calls while a counter climbs.

Two things this example ran into, both worth knowing before you hit them:

- **`timestamptz` arrives as a `DateTime`, which is not JSON.** Convert before
  returning, or the build rejects the signature — the right failure, but a
  puzzling one if unexpected.
- **A held connection can be dropped** by the server, a deploy, or idling. Check
  and reconnect rather than surfacing a broken socket; that is the honest cost
  of keeping state in a worker.

A full version, with a local seeding program that creates the table over the
*external* connection string while the tasks read it over the *internal* one,
is in
[`render_postgres_example`](https://github.com/timmaffett/render_dart_workflow_test).

### `mode: "exe"`

For a program that owns its own `main()` and wants no wrapper. It is compiled
to `build/native/<name>` and left alone; call it with `runProcess`.

### Building

The vendored SDK carries `gen_snapshot`, so this needs nothing extra — and
**nothing is cross-compiled and no binary is committed**. Render's build host is
already `linux/x64`, so the executable is produced from the source in the commit
that deploys it.

Generated files (`tools.dart`, `tools.stub.dart`) are listed in a
`native/.gitignore` the build maintains, because the facade takes a plain name
and would otherwise read as hand-written source.

Native sources need `dart:io`, so declared native directories — and
`native_task.dart` — are exempt from the `dart:io` guard. Everything else stays
strict.

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

Native executables are cached the same way, in `node_modules/.native-cache`,
keyed on the **content** of their sources rather than mtime — every deploy is a
fresh git checkout that restamps mtimes, so an mtime-keyed cache could never
hit. A deploy that changes only `tasks.dart` reuses the executable instead of
paying for another AOT compile.

Use *Clear build cache & deploy* in the Dashboard to force a clean fetch.

## Layout

    src/runtime.js        Loaded by your workflow; bridges Dart to the SDK
    src/web-shims.js      Browser-shaped APIs Node lacks: self, file: fetch,
                          Dart package assets, XMLHttpRequest
    src/node-bridge.js    Node access Dart lacks: require, subprocesses
    src/native-worker.js  Keeping native executables alive between calls
    src/cli.js            build / dev / init
    src/toolchain/        SDK resolution and compilation, free of Render
                          specifics so it can be extracted later
    dart/generator/       Reads @nativeTask with package:analyzer and writes
                          the dispatcher, stubs and facade. Its own pubspec,
                          so your project never depends on the analyzer
    template/             What `init` copies, including the two runtime files
                          (render_dart.dart, native_task.dart)

## Licence

MIT
