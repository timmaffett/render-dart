---
name: render-dart
description: Writes, builds and deploys Render Workflows tasks in Dart using the render-dart npm package. Covers scaffolding a project, writing task bodies, calling natively compiled Dart for dart:io/dart:ffi/isolates, using pub.dev packages that ship WebAssembly, local development, and deployment. Use when a user wants to run Dart on Render Workflows, add or change Dart tasks, reach a database or the filesystem from a task, or deploy a Dart workflow service.
license: MIT
compatibility: Requires Node 18+ and the Render CLI for local development. No Dart installation needed — render-dart fetches a pinned SDK. Render Workflows is in beta.
metadata:
  author: Tim Maffett
  version: "1.0.0"
  category: workflows
---

# Dart on Render Workflows

Render has no Dart runtime. `render-dart` compiles Dart task bodies to
JavaScript with `dart compile js` and registers them through Render's own
`@renderinc/sdk` on the supported `node` runtime — no Docker, and API
provisioning and local development both keep working.

**Render's own `render-workflows` skill covers Python and TypeScript only.** It
does not know Dart is possible; this skill is the Dart path.

## Start here

Prefer scaffolding from an example over writing a task body from scratch — each
one has been run:

```bash
npx render-dart init my-app --template postgres   # or http, native, introspect
```

`references/examples.md` maps each template to the question it answers.

```bash
npm install render-dart
npx render-dart init my-workflow
cd my-workflow && npm install
npx render-dart dev            # builds, then starts Render's local task server
```

A task is a Dart function registered by name:

```dart
import 'render_dart.dart';

void main() {
  task('sumSquares', (args) async {
    final values = args[0]! as List<Object?>;
    var total = 0;
    for (final v in values) {
      total += (await callTask('square', [v]))! as int;   // fan-out
    }
    return total;
  });

  start();                     // must be last
}
```

Arguments and return values are JSON. `start()` is required, and forgetting it
produces "start command exited before registering tasks".

## Choosing how to run work

dart2js covers most tasks. It cannot open a file, use a second core, or run a
package needing `dart:io`. Two escapes:

| | WebAssembly | Native task |
| --- | --- | --- |
| Runs in | the Node process | a subprocess |
| Needs | the package to ship a `.wasm` | nothing — any Dart compiles |
| `dart:io`, `dart:ffi`, multiple cores | no | **yes** |
| Per-call cost | none | ~0.5 ms with a worker |

Use wasm when the package already has a module — nothing is spawned. Use native
when it does not, or the work needs I/O, FFI, or more than one core.

**Native is not faster at arithmetic.** Measured on Render, V8 matches Dart AOT
on integer work and beats it at small n. Recommend native for capability, not
speed. See `references/native-tasks.md`.

## Detail

- `references/examples.md` — the templates, and which to reach for
- `references/native-tasks.md` — the full native task workflow, worker mode,
  what can cross the boundary
- `references/wasm-packages.md` — packages that ship WebAssembly
- `references/troubleshooting.md` — the errors that are not self-explanatory

## Deploying

| Field | Value |
| --- | --- |
| Runtime | Node |
| Build Command | `npm install && npm run build` |
| Start Command | `node index.js` |
| Root Directory | wherever `package.json` lives |

No Dart is needed on Render's builder; `render-dart build` fetches a pinned SDK
into `node_modules`, which is the one directory Render's build cache preserves.

Blueprints (`render.yaml`) do not support Workflows — provision via the CLI, the
API, or the Dashboard.

**Autodeploy fires only for commits touching the service's root directory.**

## Rules

- **Never import `dart:io` in task code.** It compiles under dart2js and then
  throws at runtime; the build refuses it. Use `package:http` (which goes
  through fetch), or a native task
- **Always `await` a native task.** The stub returns a `Future` where the
  implementation may not
- **Never commit generated files or compiled binaries.** The build regenerates
  them and maintains a `native/.gitignore`
- **After publishing anything, install it from the registry** into a scratch
  directory and check what resolves
