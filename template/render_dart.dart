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
