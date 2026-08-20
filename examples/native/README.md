# native

`dart:io`, `dart:ffi` and real isolates — the things dart2js cannot do.

The implementation lives in `native/tools_impl.dart` and is compiled AOT.
`tasks.dart` imports the generated `native/tools.dart` and calls it by name;
nothing at the call site says it is native.

| Task | Shows |
| --- | --- |
| `readFile` | `dart:io` — impossible under dart2js |
| `runCommand` | Spawning a process |
| `platformInfo` | `dart:ffi`, and what the container reports |
| `parallelHash` | Isolates across cores, timed against the sequential version |

```bash
npm install && npx render-dart dev
render workflows start parallelHash --local --input='[["a","b","c","d","e","f","g","h"]]'
```

## What to take from parallelHash

It runs the same batch sequentially and across isolates, and returns both
timings — 86 ms against 24 ms for eight jobs on one laptop.

That is the honest case for native. It is **not** faster at plain arithmetic:
measured on Render, V8 matches Dart AOT and beats it on small inputs. What
native gives you is reach, and the ability to use more than one core.

`platformInfo` reports `numberOfProcessors`, which is the host's core count and
not the CPU share your container actually gets. Measure before sizing an
isolate pool by it.
