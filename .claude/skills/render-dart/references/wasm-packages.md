# Packages that ship WebAssembly

Often the simpler choice: the module runs inside the Node process, so nothing is
spawned, no second binary exists, and there is no build step beyond the usual
one.

Two shapes, both verified on Render.

## Using the platform's WebAssembly API

`forge2d` binds Box2D through `dart:ffi` natively, and under dart2js selects a
bundled `.wasm` build instead. It looks for the module at Dart's standard web
asset path (`packages/forge2d/...`), which nothing serves under Node.

`render-dart` resolves that from `.dart_tool/package_config.json`, so **no
configuration is needed**:

```dart
await initializeForge2D();
final world = World(gravity: Vector2(0, -10));
```

## Packages carrying their own JS wasm runtime

`rust_crypto` goes through `wasm_run`, which looks browser-only: it loads its
WASI shim by injecting a `<script>` tag into an HTML document. But its setup
checks whether the global is already present and skips injection if so, and the
runtime seeds it. Requires `@bjorn3/browser_wasi_shim` as an npm dependency.

This works, and was initially assessed as impossible — check the actual setup
path before concluding a wasm package cannot run.

## Choosing wasm or native

Prefer wasm when the package already ships a module: no subprocess, no binary,
no per-call cost.

Prefer native when there is no wasm build, or the work needs `dart:io`,
`dart:ffi`, or more than one core. Wasm cannot open a socket — `package:postgres`
has no wasm build and no web support, so a database needs a native task.

## Note

`.dart_tool/package_config.json` is read at **task-run time** to resolve
`packages/<name>/...` asset paths, which is unusual — most Dart code only
touches it during a build. A stale copy breaks wasm module loading rather than
producing an obvious error. Moving or copying a workflow directory invalidates
it; `npx render-dart build` fixes it, since it runs `dart pub get`.
