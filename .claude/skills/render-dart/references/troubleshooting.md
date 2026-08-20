# Troubleshooting

## "start command exited before registering tasks"

`tasks.dart` is missing `start()`, or `main()` threw before reaching it. Run
`node index.js` directly to see the real error — the task server swallows it.

## Every task body runs twice

`RENDER_SDK_AUTO_START` was not `false` before `@renderinc/sdk` was required.
`task()` schedules its own `startTaskServer()` via `setImmediate`, so combined
with an explicit start there are two servers. `render-dart`'s runtime sets it;
requiring the SDK yourself, earlier, defeats that.

## "Dart exception thrown from converted Future"

A Dart exception crossed to JS unwrapped. Task bodies must return the
`{$ok}`/`{$err}` envelope so the runtime can rethrow a real `Error`. Using
`render-dart`'s `task()` does this for you.

## "Unsupported operation" at runtime, having built fine

`dart:io` under dart2js. It compiles without complaint and fails on first use.
The build normally refuses it; this appears when `allowDartIo: true` is set.
Use `package:http` or a native task.

## "Too many positional arguments" pointing at generated code

`render_dart.dart` in the project is older than the installed `render-dart`.
The build warns about this. Refresh it:

```bash
cp node_modules/render-dart/template/render_dart.dart render_dart.dart
```

## "cannot cross a JSON boundary"

A `@nativeTask` signature uses a type that cannot be serialised — a custom
class, `Uint8List`, `Set`, a record. The error names the parameter. `DateTime`
is the common one: convert to an ISO-8601 string.

## "would be overwritten by its own generated facade"

A native entry is named `tools.dart`, which is where the facade goes. Rename the
implementation to `tools_impl.dart`.

## A native task hangs, or a worker stops responding

A worker serves calls one at a time, so a call that never returns blocks every
later one. Set `timeout` on the `@NativeTask` annotation; an overrunning worker
is killed and respawns.

## Wasm module not found at `packages/<name>/...`

`.dart_tool/package_config.json` is stale — it holds absolute paths and is read
at run time to resolve asset paths. Run `npx render-dart build`, which runs
`dart pub get`.

## The build recompiles native code on every deploy

The cache is keyed on source content. If it is missing every time, check that
output is landing in `node_modules/.native-cache` — Render preserves
`node_modules` and nothing else.

## A scaffolded project installed an old render-dart

Historic: versions 0.2.0–0.4.0 shipped a template pinning `^0.1.0`, which npm
reads as `<0.2.0`. Fixed in 0.4.1; `init` now writes the current version. If a
project predates that, edit its `package.json`.
