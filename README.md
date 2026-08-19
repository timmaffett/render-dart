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
    src/cli.js            build / dev / init
    src/toolchain/        SDK resolution and compilation, free of Render
                          specifics so it can be extracted later
    template/             What `init` copies

## Licence

MIT
