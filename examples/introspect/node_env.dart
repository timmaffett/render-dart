/// Reading environment variables from a task.
///
/// dart2js selects the *web* implementation of anything platform-specific, and
/// the web has no environment — so `Platform.environment` is unavailable and
/// packages that read it find nothing. Node does have one; this reaches it
/// through the `require` that render-dart's runtime hoists.
///
/// This is why a task must pass an API token explicitly rather than letting a
/// client pick it up from the environment.
library;

import 'dart:js_interop';
import 'dart:js_interop_unsafe';

@JS('__require')
external JSObject _require(String id);

/// The value of [name] in the process environment, or null.
String? nodeEnv(String name) {
  final env = _require('node:process')['env'] as JSObject;
  final value = env[name];
  return value.isUndefinedOrNull ? null : (value! as JSString).toDart;
}

/// The value of [name], or a clear failure naming what to set.
String requireEnv(String name) {
  final value = nodeEnv(name);
  if (value == null || value.isEmpty) {
    throw StateError(
      '$name is not set on this service. Add it in the Dashboard under the '
      "service's Environment, or pass it when creating the workflow.",
    );
  }
  return value;
}
