# Changelog

## 0.7.1

- Fixes a dead link on the package page. The Postgres example pointed at
  `github.com/timmaffett/render_dart_workflow_test`, which is private and not
  where that example lives; it is `examples/postgres` in this repo, and also
  what `init --template postgres` scaffolds.
- Documents `--template` in the Commands table, and `allowDartIoIn` in the
  configuration section — both shipped in 0.7.0 without being written down.
- The Layout section described `template/`, which 0.7.0 removed. It now lists
  `examples/` and `runtime/`.

## 0.7.0

**Examples are the templates.** `examples/` holds five complete, runnable
services, and `init` scaffolds from them:

```bash
npx render-dart init my-app --template postgres
```

`default`, `http`, `native`, `postgres` and `introspect`. Making them the same
thing means a template that does not work is a test failure rather than a
surprise — there is no second copy to drift.

**Scaffolds carry agent guidance.** `init` writes `AGENTS.md` and a `CLAUDE.md`
pointing at it into the project it creates. Coding agents never read
`node_modules`, so nothing shipped inside this package reaches an agent helping
in your project; the scaffold is the only place that text is certain to be
seen.

**`renderDart.allowDartIoIn`** exempts named directories from the `dart:io`
guard. A local tool sitting beside a workflow — a database seeder, say — is a
normal shape, and previously the only escape was `allowDartIo: true`, which
switched the check off for task code too.

- `template/` is gone. The two Dart bridge files live in `runtime/`, and the
  examples carry no copies — `build` writes them when missing, which is also
  how they stay current on upgrade.
- README documents native tasks against WebAssembly as two routes past dart2js,
  with measurements: V8 matches Dart AOT on integer work, so native is for
  capability and parallelism rather than raw speed.

## 0.6.0

Nothing at a call site needs to know a task is native.

- `@NativeTask(worker: true, idleTimeout: …, timeout: …)` — settings ride with
  the declaration; `renderDart.native` can still override per entry.
- A generated facade conditionally exports the implementation or the
  process-spawning stub, so `import 'native/tools.dart'` compiles to a direct
  call natively and a process call under dart2js. The same source works both
  ways, which also makes native code unit-testable on the VM.
- `NativeCall.scope(worker: false, …)` varies settings for one caller without
  changing any signature.
- Implementations are named `<name>_impl.dart` so the facade can take the plain
  name; an entry that would be clobbered by its own facade is refused.

## 0.5.0

Native tasks, and worker mode.

- Declare Dart files in `renderDart.native`, annotate top-level functions with
  `@nativeTask`, and call them from task code. That reaches `dart:io`,
  `dart:ffi`, isolates and packages with no web build — `postgres` among them.
- JSONL over stdin/stdout, every message carrying an id. `print()` on the
  native side becomes a `$log` line rather than corrupting the framing, and a
  native `throw` arrives as a `NativeTaskException` with its real message.
- `worker: true` keeps the executable alive between calls: 10 ms across 20
  calls against 132 ms spawning each time, measured on Render.
- Nothing is cross-compiled and no binary is committed — the vendored SDK
  carries `gen_snapshot`, and Render's build host is already linux/x64.

## 0.4.1

`init` writes `^${version}` from its own package.json.

The template carried a hardcoded `^0.1.0`, which npm reads as `<0.2.0` — so
every project scaffolded since 0.2.0 silently installed 0.1.1, without wasm
support, asset resolution or the node bridge. Local tarballs and explicit
`render-dart@x.y.z` installs all hid it.

## 0.4.0

Tasks can reach npm packages and subprocesses.

- `requireModule(id)` — dart2js output is CommonJS, so `require` is
  module-scoped and never reaches `globalThis`. The runtime hoists one, rooted
  at the project directory.
- `runProcess(command, …)` — `dart:io`'s `Process` compiles under dart2js and
  then throws. A non-zero exit is returned rather than thrown.

## 0.3.0

Packages that carry their own JS wasm runtime work, `rust_crypto` through
`wasm_run` among them. Its setup looks browser-only but skips DOM injection
when the globals are already present, which the runtime seeds.

## 0.2.0

Packages that load `.wasm` modules work. Dart's web asset convention
(`packages/<name>/…`) is resolved from `.dart_tool/package_config.json`, so
forge2d's bundled Box2D build needs no configuration.

## 0.1.1

Export `./package.json`.

## 0.1.0

Initial release: write Render Workflows tasks in Dart, compiled to JavaScript
and registered through Render's `@renderinc/sdk`.
