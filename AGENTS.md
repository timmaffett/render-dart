# Working on render-dart

`render-dart` lets Dart run as Render Workflows tasks: compiled to JavaScript
with dart2js for the task bodies, and to native executables for anything
JavaScript cannot do.

This file is for coding agents. `README.md` explains the package to a user;
this one records what goes wrong.

## Orientation

```
src/runtime.js        loaded by a workflow; bridges Dart to @renderinc/sdk
src/web-shims.js      browser-shaped APIs Node lacks
src/node-bridge.js    require + subprocesses, which Dart cannot reach alone
src/native-worker.js  keeps native executables alive between calls
src/cli.js            build / dev / init
src/toolchain/        SDK fetch, dart2js, native compile, generation
dart/generator/       reads @nativeTask with package:analyzer; own pubspec
runtime/              render_dart.dart, native_task.dart, and the AGENTS.md
                      that init writes into a scaffolded project
examples/             runnable services, which are also the init templates
```

**Examples are templates.** `init` copies `examples/<name>/`, so an example
that does not work is a broken template. There is deliberately no separate
`template/` directory to drift from them, and no per-example copy of the two
bridge files — `build` writes those when missing, which is the same mechanism
that keeps them current on upgrade.

`npm test` — 53 tests, offline. Run it before claiming anything works.

## Rules that are not obvious

**Never remove `RENDER_SDK_AUTO_START = 'false'` from `src/runtime.js`, and
never set it after the SDK is required.** `task()` schedules its own
`startTaskServer()` via `setImmediate`; combined with an explicit start, every
task body runs **twice**. Still true in `@renderinc/sdk` 0.7.0.

**Never let a Dart exception cross to JS unwrapped.** `executor.ts` stringifies
non-`Error` values, so a converted Dart exception arrives as an opaque
placeholder. Task bodies return `{$ok}`/`{$err}` and the runtime rethrows a real
`Error`. Same pattern on the native side in `template/native_task.dart`.

**Generated code must be analyzer-clean.** It lands in the user's output, so an
unused variable in a stub is our bug. Check with `dart analyze` on a scaffolded
project, not just `npm test`.

**The generator sets `exitCode`, it does not return it.** An async `main`'s
return value is not the process exit code. Returning 1 from `_fail` alone means
a rejected signature prints an error, exits 0, and the build continues to fail
somewhere confusing.

**Cache keys are content hashes, never mtimes.** Every Render deploy is a fresh
git checkout that restamps every file, so an mtime-keyed cache can never hit
there. This was measured, not reasoned about.

**Options unset in `package.json` must stay `undefined`, not `false`.**
Defaulting them means config always wins and the `@NativeTask` annotation never
applies.

## The Dart version

Two files, and the split matters. `toolchain/dart-version.js` answers *what was
asked for* — precedence, aliases, the archive listing. `toolchain/dart-sdk.js`
answers *where a Dart is* — vendored, on `PATH`, or downloaded. They were one
concern once, which is how the pin came to be consulted only on the download
path and to be silently ignored everywhere else.

`requestedVersion` returns `explicit`, and that flag carries the whole design:
a version someone typed must beat a Dart on `PATH`, and the built-in default
must not. Do not collapse the two by defaulting `dartVersion` in `config()` —
then nothing downstream can tell "unset" from "set to the default".

The vendored SDK records its version in `node_modules/.dart-sdk/VERSION`.
Without that the cache key is directory existence and changing the pin does
nothing on any machine that has built once, including every Render build after
the first.

`render-dart dart` passes `fetch: false`. It once shared the build path's
resolver and a plain query downloaded 228 MB and unpacked 624 MB. A question
must not install anything.

## Changing the Dart side

`template/render_dart.dart` and `template/native_task.dart` are copied into
projects. Changing a signature breaks every existing project until its copy is
refreshed — `build` warns when a local copy differs, and that warning is the
only thing standing between a user and "Too many positional arguments" pointing
at generated code.

They are duplicated into `render_dart_sdk/workflows*/` too. Keep them identical;
`diff` against `template/` after editing.

## Releasing

1. `npm test`
2. Bump `version` in `package.json`; `init` writes `^${version}` into scaffolded
   projects, so nothing else needs editing
3. `npm pack` **from this directory** — packing elsewhere silently builds the
   wrong tarball
4. Publishing needs the maintainer's 2FA. Ask; do not attempt it
5. After publishing, install from the registry into a scratch directory and
   check what resolves. Versions 0.2.0–0.4.0 shipped a template pinning `^0.1.0`
   (`<0.2.0` in npm's 0.x semver), so every scaffolded project silently got
   0.1.1. Local tarballs hid it for three releases

## Do not

- Add a dependency. The package has none on purpose; the generator's
  `package:analyzer` is isolated in `dart/generator/` with its own pubspec so a
  user's project never inherits it
- Weaken the `dart:io` guard. Use the exemption list — it exists for native
  sources
- Commit generated files, or a compiled binary
