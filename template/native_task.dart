/// The native side of a render-dart native task.
///
/// This file is boilerplate — you shouldn't need to edit it. A file compiled
/// AOT by `render-dart build` runs a generated `main()` that calls
/// [nativeTaskMain] with its `@nativeTask` functions.
///
/// The protocol is JSONL: one JSON object per line, in and out. That framing
/// is what lets the same binary serve a one-shot call and, later, a persistent
/// worker — a one-shot writes a line and reads a line, a worker just keeps
/// looping.
///
///   → {"id":1,"method":"inspect","args":["a.png"],"named":{"sha":true}}
///   ← {"id":1,"$log":"reading a.png"}
///   ← {"id":1,"$ok":{"bytes":8192}}
///
/// Every message carries an `id` even though a one-shot call has only one
/// request in flight, so nothing about the wire format changes when a worker
/// starts multiplexing several.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Marks a top-level function as callable from a dart2js task.
///
/// Parameters and the return value cross a JSON boundary, so they must be
/// JSON-representable: bool, int, double, num, String, List<T>, Map<String, T>,
/// Object?, dynamic, or Future<T> of those. `render-dart build` rejects
/// anything else by name rather than letting it fail as a decode error at run
/// time.
class NativeTask {
  const NativeTask({this.worker, this.idleTimeout, this.timeout});

  /// Keep the executable alive between calls.
  ///
  /// Much faster in a loop — 10 ms against 132 ms over 20 calls on Render —
  /// but the process keeps its top-level state, so call N can observe what
  /// call N-1 left behind and a leak is never cleaned up by process exit.
  /// Defaults to false.
  final bool? worker;

  /// How long an idle worker lingers before it is reaped. Defaults to 30 s.
  final Duration? idleTimeout;

  /// How long one call may take before it is abandoned. Unset means no limit.
  final Duration? timeout;
}

/// The annotation itself, for the common case with no options: `@nativeTask`.
const nativeTask = NativeTask();

/// What a generated dispatcher entry looks like.
typedef NativeHandler = Future<Object?> Function(
  List<Object?> args,
  Map<String, Object?> named,
);

/// Serves JSONL requests on stdin until it closes.
///
/// Handlers run one at a time. A native task therefore never has to be
/// reentrant, which is the reason worker mode can reuse this unchanged.
Future<void> nativeTaskMain(
  List<String> argv,
  Map<String, NativeHandler> handlers,
) async {
  final out = stdout;

  final lines = stdin.transform(utf8.decoder).transform(const LineSplitter());

  await for (final line in lines) {
    if (line.trim().isEmpty) continue;

    Object? id;
    try {
      final request = jsonDecode(line) as Map<String, Object?>;
      id = request['id'];
      final method = request['method'] as String?;
      final args = (request['args'] as List?)?.cast<Object?>() ?? const [];
      final named = (request['named'] as Map?)?.cast<String, Object?>() ?? const {};

      final handler = handlers[method];
      if (handler == null) {
        _write(out, {
          'id': id,
          r'$err': 'no @nativeTask named "$method" in this executable',
          r'$known': handlers.keys.toList(),
        });
        continue;
      }

      // print() from a task body would otherwise land on stdout and corrupt
      // the framing, so it is rerouted to a $log line instead of becoming a
      // baffling parse error on the Node side.
      final result = await runZoned(
        () => handler(args, named),
        zoneSpecification: ZoneSpecification(
          print: (_, __, ___, String message) =>
              _write(out, {'id': id, r'$log': message}),
        ),
      );

      _write(out, {'id': id, r'$ok': result});
    } catch (e, stackTrace) {
      // Mirrors the {$ok}/{$err} envelope the JS boundary uses, for the same
      // reason: a real message is worth more than a generic failure.
      _write(out, {'id': id, r'$err': '$e', r'$stack': '$stackTrace'});
    }
  }
}

void _write(IOSink out, Map<String, Object?> message) {
  // jsonEncode escapes newlines, so one message is always exactly one line.
  out.writeln(jsonEncode(message));
}
