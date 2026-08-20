# Examples

Each directory is a complete, runnable Render Workflows service — and also a
template:

```bash
npx render-dart init my-app --template postgres
```

That is deliberate. A template that is not also a working example drifts from
reality; making them the same thing means every template is one you can run.

| | Answers |
| --- | --- |
| [`default/`](default) | How do I write a task, fan work out, and retry a failure? |
| [`http/`](http) | How do I call an external API? |
| [`native/`](native) | How do I read a file, shell out, or use more than one core? |
| [`postgres/`](postgres) | How do I reach a database? |
| [`introspect/`](introspect) | How do I inspect Render, or run a task in another workflow? |

## Running one

```bash
cd http
npm install
npx render-dart dev
```

Then, in another terminal:

```bash
render workflows tasks list --local
render workflows start fetchRepo --local --input='["dart-lang/sdk"]'
```

No Dart installation is needed — a pinned SDK is fetched into `node_modules`.

## Which escape hatch

dart2js runs task bodies, and covers most work. It cannot open a file, use a
second core, or run a package that needs `dart:io`.

- **HTTP is not one of those cases.** `package:http` works, because its web
  implementation goes through the platform's networking. See `http/`.
- **A package shipping WebAssembly** runs in-process with nothing spawned.
  Prefer it when one exists.
- **Everything else** — files, FFI, databases, real parallelism — is a native
  task. See `native/` and `postgres/`.

Native is **not** faster at arithmetic; V8 matches Dart AOT on integer work.
Choose it for reach, or for parallelism, which is the one real speed win.

## A note on dependencies

`postgres/seed` and `introspect/` depend on `render_api` by **git**, because it
is not on pub.dev yet. Those become ordinary version constraints once it is.
