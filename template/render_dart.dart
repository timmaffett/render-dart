/// The Dart side of the render-dart bridge.
///
/// This file is boilerplate — you shouldn't need to edit it. It will become a
/// pub package (`render_workflows_node`); for now it ships with the template
/// so a project stays self-contained.
library;

import 'dart:js_interop';
import 'dart:js_interop_unsafe';

@JS('__registerTask')
external void _registerTask(String name, JSFunction fn, JSObject? options);

@JS('__callTask')
external JSPromise<JSAny?> _callTask(String name, JSArray args);

@JS('__start')
external JSPromise<JSAny?> _start();

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
