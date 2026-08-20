/// The Dart side of the render-dart bridge.
///
/// This file is boilerplate — you shouldn't need to edit it. It will become a
/// pub package (`render_workflows_node`); for now it ships with the template
/// so a project stays self-contained.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';

@JS('__registerTask')
external void _registerTask(String name, JSFunction fn, JSObject? options);

@JS('__callTask')
external JSPromise<JSAny?> _callTask(String name, JSArray args);

@JS('__start')
external JSPromise<JSAny?> _start();

@JS('__nativeCall')
external JSPromise<JSArray<JSString>> _nativeCall(
  String binary,
  String request,
  JSObject options,
);

@JS('__fileUri')
external String _fileUri(String relativePath);

/// Resolves a project-relative path to a `file:` URI.
///
/// Useful for packages that load bundled assets through `fetch`. Node's fetch
/// has no `file:` support of its own; the render-dart runtime adds it, so a
/// URI from here can be handed straight to such a package:
///
/// ```dart
/// await initializeForge2D(wasmUri: Uri.parse(fileUri('web/box2d.wasm')));
/// ```
String fileUri(String relativePath) => _fileUri(relativePath);

@JS('__require')
external JSObject _require(String id);

@JS('__run')
external JSPromise<JSObject> _run(String command, JSArray args, JSObject options);

/// Loads an npm package or Node built-in, by name.
///
/// This is how a Dart task reaches the npm ecosystem. Bind what you need with
/// an extension type:
///
/// ```dart
/// @JS()
/// extension type _Crypto(JSObject _) implements JSObject {
///   external String randomUUID();
/// }
///
/// final crypto = _Crypto(requireModule('node:crypto'));
/// print(crypto.randomUUID());
/// ```
///
/// Dart cannot call `require` directly — in CommonJS it is module-scoped, and
/// `globalThis.require` is undefined — so the runtime hoists it for us.
JSObject requireModule(String id) => _require(id);

/// What a finished process left behind.
class ProcessResult {
  const ProcessResult({
    required this.exitCode,
    required this.stdout,
    required this.stderr,
    this.signal,
  });

  /// The process's exit code, or -1 if it was killed before exiting.
  final int exitCode;
  final String stdout;
  final String stderr;

  /// The signal that killed the process, if one did.
  final String? signal;

  bool get ok => exitCode == 0;

  @override
  String toString() => 'ProcessResult(exitCode: $exitCode'
      '${signal == null ? '' : ', signal: $signal'})';
}

/// Runs [command] to completion and captures its output.
///
/// `dart:io` compiles under dart2js and then fails at runtime, so `Process` is
/// unavailable here. This is the way to shell out — to a CLI tool, or to a
/// natively compiled Dart binary shipped alongside the workflow.
///
/// A non-zero exit is returned, not thrown: an exit code is a result, and the
/// caller usually wants [ProcessResult.stderr] with it. It throws only when the
/// process could not be started, or when [timeout] elapses.
///
/// ```dart
/// final result = await runProcess('git', args: ['rev-parse', 'HEAD']);
/// if (result.ok) print(result.stdout.trim());
/// ```
Future<ProcessResult> runProcess(
  String command, {
  List<String> args = const [],
  String? workingDirectory,
  Map<String, String>? environment,
  String? stdin,
  Duration? timeout,
  bool runInShell = false,
}) async {
  final options = JSObject();
  if (workingDirectory != null) options['cwd'] = workingDirectory.toJS;
  if (stdin != null) options['stdin'] = stdin.toJS;
  if (timeout != null) options['timeoutMs'] = timeout.inMilliseconds.toJS;
  if (runInShell) options['shell'] = true.toJS;
  if (environment != null) {
    final env = JSObject();
    environment.forEach((key, value) => env[key] = value.toJS);
    options['env'] = env;
  }

  final raw = await _run(command, args.map((a) => a.toJS).toList().toJS, options)
      .toDart;

  return ProcessResult(
    exitCode: (raw['code']! as JSNumber).toDartInt,
    stdout: (raw['stdout']! as JSString).toDart,
    stderr: (raw['stderr']! as JSString).toDart,
    signal: raw['signal'].isUndefinedOrNull
        ? null
        : (raw['signal']! as JSString).toDart,
  );
}

/// Thrown when a native task reports a failure.
///
/// Carries the message and stack trace from the native side rather than the
/// spawn's exit code, so a `throw` inside AOT-compiled Dart reads the same way
/// it would if the call had been local.
class NativeTaskException implements Exception {
  NativeTaskException(this.message, {this.nativeStackTrace, this.binary, this.method});

  final String message;
  final String? nativeStackTrace;
  final String? binary;
  final String? method;

  @override
  String toString() {
    final where = binary == null ? '' : ' in $binary/$method';
    return 'NativeTaskException$where: $message'
        '${nativeStackTrace == null ? '' : '\n$nativeStackTrace'}';
  }
}

/// Calls a `@nativeTask` function in an AOT-compiled executable.
///
/// Generated stubs call this; you rarely call it directly. The executable is
/// produced by `render-dart build` from the file declared in
/// `renderDart.native`, and lives at `build/native/<binary>` relative to the
/// project root — which is the working directory both on Render and under
/// `render workflows dev`.
///
/// One JSONL line goes in and the reply lines come back. `print()` on the
/// native side arrives as a `\$log` line and is forwarded here, so native
/// output still reaches the task log instead of corrupting the framing.
/// Per-call overrides for native tasks, scoped to a block.
///
/// Settings normally travel with the `@NativeTask` declaration, so nothing at
/// a call site needs to know a function is native. This is the escape hatch
/// for the times one caller wants something different — it changes no
/// signatures, which is what keeps the same source compiling both natively and
/// under dart2js.
///
/// ```dart
/// await NativeCall.scope(worker: false, () async => probe(30));
/// ```
class NativeCall {
  const NativeCall._();

  static const _key = #renderDartNativeCall;

  /// Runs [body] with these settings applied to every native call inside it,
  /// including nested ones.
  static Future<T> scope<T>(
    Future<T> Function() body, {
    bool? worker,
    Duration? idleTimeout,
    Duration? timeout,
  }) {
    final outer = Zone.current[_key] as _NativeOverrides?;
    return runZoned(
      body,
      zoneValues: {
        // An inner scope refines the outer one rather than replacing it.
        _key: _NativeOverrides(
          worker: worker ?? outer?.worker,
          idleTimeoutMs: idleTimeout?.inMilliseconds ?? outer?.idleTimeoutMs,
          timeoutMs: timeout?.inMilliseconds ?? outer?.timeoutMs,
        ),
      },
    );
  }
}

class _NativeOverrides {
  const _NativeOverrides({this.worker, this.idleTimeoutMs, this.timeoutMs});

  final bool? worker;
  final int? idleTimeoutMs;
  final int? timeoutMs;
}

Future<Object?> callNativeTask(
  String binary,
  String method,
  List<Object?> args, [
  Map<String, Object?> named = const {},
  bool worker = false,
  int idleTimeoutMs = 30000,
  int timeoutMs = 0,
]) async {
  // A surrounding NativeCall.scope wins over what the declaration asked for.
  final overrides = Zone.current[NativeCall._key] as _NativeOverrides?;
  final useWorker = overrides?.worker ?? worker;
  final idle = overrides?.idleTimeoutMs ?? idleTimeoutMs;
  final limit = overrides?.timeoutMs ?? timeoutMs;
  final request = jsonEncode({
    'id': 1,
    'method': method,
    'args': args,
    'named': named,
  });

  // Both paths speak the same JSONL, so the reply handling below is shared.
  // A worker keeps the executable alive and assigns its own ids, since it can
  // have several calls in flight; a one-shot spawn writes a line and reads the
  // answer back.
  final List<String> lines;
  ProcessResult? result;

  if (useWorker) {
    final options = JSObject()
      ..['idleTimeoutMs'] = idle.toJS
      ..['timeoutMs'] = limit.toJS;
    final replies =
        await _nativeCall('build/native/$binary', request, options).toDart;
    lines = replies.toDart.map((line) => line.toDart).toList();
  } else {
    result = await runProcess(
      'build/native/$binary',
      stdin: '$request\n',
      timeout: limit > 0 ? Duration(milliseconds: limit) : null,
    );
    lines = const LineSplitter().convert(result.stdout);
  }

  for (final line in lines) {
    if (line.trim().isEmpty) continue;

    final Map<String, Object?> message;
    try {
      message = (jsonDecode(line) as Map).cast<String, Object?>();
    } catch (_) {
      // Anything that is not JSON came from the program writing to stdout
      // directly, which the generated wrapper avoids. Surface it rather than
      // failing on a parse error nobody can act on.
      print('[native $binary] $line');
      continue;
    }

    if (message.containsKey(r'$log')) {
      print('[native $binary] ${message[r'$log']}');
      continue;
    }
    if (message.containsKey(r'$err')) {
      throw NativeTaskException(
        message[r'$err'] as String,
        nativeStackTrace: message[r'$stack'] as String?,
        binary: binary,
        method: method,
      );
    }
    if (message.containsKey(r'$ok')) return message[r'$ok'];
  }

  // No reply at all: the process died before it could answer. A worker
  // rejects on its own with the child's exit status, so this only covers the
  // one-shot path.
  throw NativeTaskException(
    result == null || result.exitCode == 0
        ? 'no response from build/native/$binary'
        : 'build/native/$binary exited ${result.exitCode}'
            '${result.stderr.trim().isEmpty ? '' : ': ${result.stderr.trim()}'}',
    binary: binary,
    method: method,
  );
}

/// How Render should retry a failing task.
class Retry {
  const Retry({required this.maxRetries, this.waitDurationMs, this.backoffScaling});

  final int maxRetries;
  final int? waitDurationMs;
  final double? backoffScaling;
}

/// Instance size a task runs on. Larger tiers need access from Render.
enum TaskPlan { starter, standard, pro, proPlus, proMax, proUltra }

const _planWire = {
  TaskPlan.starter: 'starter',
  TaskPlan.standard: 'standard',
  TaskPlan.pro: 'pro',
  TaskPlan.proPlus: 'pro_plus',
  TaskPlan.proMax: 'pro_max',
  TaskPlan.proUltra: 'pro_ultra',
};

/// Registers [body] as a Render task named [name].
///
/// Call this at top level, before [start]. Arguments arrive as a positional
/// list matching whatever the caller passed; the return value must be
/// JSON-serialisable, and Render caps input at 4 MB.
///
/// [timeoutSeconds] accepts 30–86,400 and defaults to two hours.
void task(
  String name,
  Future<Object?> Function(List<Object?> args) body, {
  Retry? retry,
  int? timeoutSeconds,
  TaskPlan? plan,
}) {
  if (timeoutSeconds != null &&
      (timeoutSeconds < 30 || timeoutSeconds > 86400)) {
    throw ArgumentError.value(
      timeoutSeconds,
      'timeoutSeconds',
      'Render allows 30 to 86,400 seconds.',
    );
  }

  JSPromise<JSAny?> wrapper(JSArray args) => _guard(() async {
        final dartArgs = args.toDart.map(_toDart).toList();
        return _toJs(await body(dartArgs));
      });

  _registerTask(name, wrapper.toJS, _options(retry, timeoutSeconds, plan));
}

/// Runs [name] as a child task and waits for its result.
///
/// Each call becomes a separate task run on its own Render instance, so this
/// is how you fan work out. Safe to call after an `await`.
Future<Object?> callTask(String name, List<Object?> args) async {
  final result = await _callTask(name, args.map(_toJs).toList().toJS).toDart;
  return _toDart(result);
}

/// Starts the task server. Call once, at the end of `main`.
void start() => _start();

JSObject? _options(Retry? retry, int? timeoutSeconds, TaskPlan? plan) {
  if (retry == null && timeoutSeconds == null && plan == null) return null;

  final options = JSObject();
  if (retry != null) {
    final r = JSObject();
    r['maxRetries'] = retry.maxRetries.toJS;
    if (retry.waitDurationMs != null) {
      r['waitDurationMs'] = retry.waitDurationMs!.toJS;
    }
    if (retry.backoffScaling != null) {
      r['backoffScaling'] = retry.backoffScaling!.toJS;
    }
    options['retry'] = r;
  }
  if (timeoutSeconds != null) options['timeoutSeconds'] = timeoutSeconds.toJS;
  if (plan != null) options['plan'] = _planWire[plan]!.toJS;
  return options;
}

/// Dart must never throw across the JS boundary.
///
/// A Dart exception converted by `Future.toJS` reaches Render as the opaque
/// "Dart exception thrown from converted Future...", with the real message
/// boxed where the SDK's `error.message` cannot see it. Returning an envelope
/// lets the JS side rethrow a genuine Error carrying the real text.
JSPromise<JSAny?> _guard(Future<JSAny?> Function() body) {
  Future<JSAny?> wrapped() async {
    final out = JSObject();
    try {
      out[r'$ok'] = await body();
    } catch (e, stackTrace) {
      out[r'$err'] = '$e\n$stackTrace'.toJS;
    }
    return out;
  }

  return wrapped().toJS;
}

JSAny? _toJs(Object? value) => switch (value) {
      null => null,
      final String v => v.toJS,
      final bool v => v.toJS,
      final int v => v.toJS,
      final double v => v.toJS,
      final List<Object?> v => v.map(_toJs).toList().toJS,
      final Map<String, Object?> v => (() {
          final o = JSObject();
          v.forEach((key, val) => o[key] = _toJs(val));
          return o;
        })(),
      _ => throw ArgumentError.value(
          value,
          'value',
          'Task arguments and results must be JSON-serialisable. '
              '${value.runtimeType} is not.',
        ),
    };

Object? _toDart(JSAny? value) => value?.dartify();
