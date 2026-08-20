# Native tasks

Compiling Dart AOT and calling it from a dart2js task, with nothing at the call
site saying it is native.

## The three files

```
native/tools_impl.dart     you write this: @nativeTask functions, dart:io allowed
native/tools.dart          generated facade — callers import this
native/tools.stub.dart     generated: spawns the executable under dart2js
```

The `_impl` suffix matters: the facade takes the plain name. An entry that
would be overwritten by its own facade is refused at build time with the rename
to make.

## Writing one

```dart
// native/tools_impl.dart
import 'dart:io';

import '../native_task.dart';

@nativeTask
Map<String, Object?> inspect(String path) => {
      'bytes': File(path).lengthSync(),
    };
```

```json
"renderDart": { "native": ["native/tools_impl.dart"] }
```

```dart
// tasks.dart
import 'native/tools.dart';

task('inspect', (args) async => await inspect(args[0]! as String));
```

The facade is a conditional export:

```dart
export 'tools.stub.dart' if (dart.library.io) 'tools_impl.dart';
```

so the same source compiles to a process call under dart2js and a direct call
natively. Native code calling a sibling native function skips the process hop
entirely, and the implementation is unit-testable on the Dart VM.

## What can cross

`bool`, `int`, `double`, `num`, `String`, `List<T>`, `Map<String, T>`,
`Object?`, `dynamic`, and `Future<T>` of those, nullable included. Required,
optional and named parameters all work, with defaults.

Anything else — a custom class, `Uint8List`, `Set`, a record — is **rejected at
build time**, naming the parameter.

**`DateTime` is not JSON.** Database rows and timestamps must be converted to
ISO-8601 strings before returning, or the build rejects the signature.

## Options

They ride with the declaration, so callers need no knowledge:

```dart
@NativeTask(worker: true, idleTimeout: Duration(seconds: 30), timeout: Duration(minutes: 2))
Future<int> hot(int a) async => a;
```

| | |
| --- | --- |
| `worker` | Keep the executable alive between calls. Default `false` |
| `idleTimeout` | How long an idle worker lingers. Default 30 s |
| `timeout` | How long one call may take. Default none |

`renderDart.native` can override per entry. To vary for one caller without
changing any signature:

```dart
await NativeCall.scope(worker: false, () async => hot(1));
```

## Worker mode

Measured on Render, 20 calls: **10 ms in one process against 132 ms across 20**.

It is opt-in because a worker keeps top-level state between calls — which is
what makes it fast, and also means a leak accumulates instead of being cleaned
up by process exit, and one call can observe what the last left behind.

A held resource can die. Check and re-establish rather than surfacing a broken
socket:

```dart
Future<Connection> _db() async {
  final existing = _connection;
  if (existing != null && existing.isOpen) return existing;
  // ... reconnect
}
```

A call that throws does **not** kill the worker. A process that dies rejects
every in-flight call with its exit code and stderr, then respawns on the next.

## Performance, honestly

Native is not faster at computation. The same recursive fib on Render:

| n | dart2js | native |
| --- | --- | --- |
| 30 | 8 ms | 23 ms |
| 34 | 60 ms | 50 ms |
| 36 | 146 ms | 131 ms |

V8 matches Dart AOT on integer work. Recommend native for **capability** —
`dart:io`, `dart:ffi`, isolates, packages with no web build.

Parallelism is the real win, since dart2js inherits JavaScript's single thread.
Anecdotally, on a free-tier `starter` instance, batches of fib(32):

| jobs | dart2js seq | native parallel |
| ---: | ---: | ---: |
| 8 | 177 ms | 84 ms |
| 16 | 367 ms | 219 ms |
| 32 | 706 ms | 533 ms |

The benefit is real but does not grow indefinitely, and
`Platform.numberOfProcessors` reported 32 throughout while being no guide to
any of it. Measure the workload on the plan it will run on.

## The wire

JSONL over stdin/stdout, one object per line, every message carrying an id.
`print()` on the native side becomes a `$log` line and is forwarded — on stdout
it would corrupt the framing. A native `throw` arrives as a
`NativeTaskException` with the real message and native stack.

## Building

The vendored SDK carries `gen_snapshot`, so nothing is cross-compiled and no
binary is committed: Render's build host is already `linux/x64`, and the
executable comes from the source in the deploying commit. The cache is keyed on
source content, not mtime.

`mode: "exe"` compiles a program that owns its own `main()` with no wrapper;
call it with `runProcess`.
