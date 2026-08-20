# Working in this project

Render Workflows tasks written in Dart, built by
[`render-dart`](https://github.com/timmaffett/render-dart).

Task bodies are compiled to JavaScript with `dart compile js` and registered
through Render's official `@renderinc/sdk` on the `node` runtime. Where
JavaScript is not enough, a task calls into Dart compiled natively.

## Commands

```bash
npx render-dart build         # compile; --force skips the freshness check
npx render-dart dev           # build, then start Render's local task server
render workflows tasks list --local
render workflows start <task> --local --input='[1, 2]'
```

No Dart installation is needed — a pinned SDK is fetched into `node_modules`.

## Writing a task

`tasks.dart` registers functions by name and must end with `start()`:

```dart
task('doThing', (args) async => args[0]! as int * 2);
```

Arguments and return values are JSON. Render caps one invocation's input at
4 MB. `callTask('other', [...])` starts a **subtask of this workflow**, each on
its own instance — that is how work fans out.

## The rule that catches people

**`dart:io` does not work in task code.** It compiles under dart2js and then
throws `Unsupported operation` on first use, so the build refuses a direct
import. That rules out files, sockets, subprocesses and any package needing
them.

Three ways forward:

| Need | Use |
| --- | --- |
| HTTP | `package:http` — works, it goes through the platform's networking |
| A package shipping a `.wasm` | just use it; modules resolve automatically |
| Files, FFI, a database, real parallelism | a **native task** |

## Native tasks

Write the implementation in `native/<name>_impl.dart`, annotate top-level
functions, and list the file in `renderDart.native` in `package.json`:

```dart
// native/tools_impl.dart
import 'dart:io';
import '../native_task.dart';

@nativeTask
Map<String, Object?> inspect(String path) => {'bytes': File(path).lengthSync()};
```

```dart
// tasks.dart — nothing here says it is native
import 'native/tools.dart';

task('inspect', (args) async => await inspect(args[0]! as String));
```

The build generates `native/tools.dart` and `native/tools.stub.dart`. Do not
edit or commit them.

- **Always `await`** a native task; the stub returns a `Future` where the
  implementation may not.
- **Return JSON-representable types only.** `DateTime` is not — convert to an
  ISO-8601 string. Anything unsupported is rejected at build time, naming the
  parameter.
- **`@NativeTask(worker: true)`** keeps the process alive between calls, which
  matters for anything holding a connection. It also keeps top-level state, so
  one call can observe what the last left behind.

**Native is not faster at arithmetic.** Measured on Render, V8 matches Dart AOT
on integer work and beats it at small n. Choose native for *capability* — or
for parallelism, which is the one real speed win, since dart2js is
single-threaded.

## Reaching a database

`package:postgres` cannot run under dart2js at all — it needs a raw socket, and
pub.dev marks it `runtime:native-aot` with no `runtime:web`. So a database
needs a native task, holding the connection open with `worker: true`.

`render-dart init db --template postgres` scaffolds a working version, seeder
included.

The connection string belongs in `DATABASE_URL` on the service, set to the
database's **internal** string. A workflow's environment can only be set when
the service is created; afterwards, the Dashboard is the only route.

## Deploying

| Field | Value |
| --- | --- |
| Runtime | Node |
| Build Command | `npm install && npm run build` |
| Start Command | `node index.js` |
| Root Directory | where this `package.json` lives |

**Autodeploy fires only for commits touching the root directory.** A commit
elsewhere being ignored is correct, not a broken webhook.

## Do not commit

`build/`, `node_modules/`, and the generated `native/*.dart` files. The build
regenerates all of them and maintains a `native/.gitignore`.

`render_dart.dart` and `native_task.dart` are render-dart's bridge files. They
are boilerplate — the build refreshes them when missing and warns when a local
copy is older than the installed package.

## More

Runnable examples covering HTTP, native tasks, Postgres, WebAssembly and
calling Render's own API from a task:
<https://github.com/timmaffett/render-dart/tree/main/examples>
