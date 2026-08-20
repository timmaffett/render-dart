// Compiled AOT, so this gets the real Dart platform.
//
// Everything here is impossible under dart2js: files, subprocesses, FFI and
// isolates. That is the point of a native task — not speed, but reach.
import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';

import '../native_task.dart';

/// Reads a file, which dart2js cannot do at all.
///
/// `dart:io` compiles under dart2js and then throws `Unsupported operation` on
/// first use, so `render-dart build` refuses a direct import in task code.
/// Here it is exactly what we want.
@nativeTask
Future<Map<String, Object?>> readFile(String path, {int previewLines = 3}) async {
  final file = File(path);
  if (!file.existsSync()) {
    // Throwing gives the caller the real message, not an exit code.
    throw ArgumentError.value(path, 'path', 'no such file');
  }

  final lines = await file.readAsLines();
  return {
    'path': file.absolute.path,
    'bytes': await file.length(),
    'lines': lines.length,
    'preview': lines.take(previewLines).toList(),
  };
}

/// Runs a command and reports what it did.
///
/// A task can also shell out through render-dart's `runProcess` without going
/// native. Doing it here instead keeps the whole operation on one side of the
/// boundary, which matters when the surrounding logic needs dart:io anyway.
@nativeTask
Future<Map<String, Object?>> runCommand(String command, List<String> args) async {
  final result = await Process.run(command, args);
  return {
    'exitCode': result.exitCode,
    'stdout': '${result.stdout}'.trim(),
    'stderr': '${result.stderr}'.trim(),
  };
}

/// What the platform looks like from inside a native task.
@nativeTask
Map<String, Object?> platformInfo() => {
      'os': Platform.operatingSystem,
      'version': Platform.operatingSystemVersion,
      'dart': Platform.version.split(' ').first,
      'abi': Abi.current().toString(),
      // dart:ffi — the size of a native pointer on this machine.
      'pointerSize': sizeOf<IntPtr>(),
      // Reports the host's core count, which is not the same as the CPU share
      // this container actually gets. Measure before sizing anything by it.
      'numberOfProcessors': Platform.numberOfProcessors,
      'processId': pid,
    };

/// Spreads work across isolates — real parallelism, on real cores.
///
/// This is the one thing native is genuinely *faster* at. dart2js inherits
/// JavaScript's single thread, so identical work there runs one job at a time.
/// For plain arithmetic on a single job, dart2js is as quick or quicker.
///
/// Runs the batch both ways so the difference is measured rather than claimed.
@nativeTask
Future<Map<String, Object?>> parallelHash(List<String> inputs) async {
  final sequentialStarted = DateTime.now();
  final sequential = [for (final s in inputs) _expensiveHash(s)];
  final sequentialMs = DateTime.now().difference(sequentialStarted).inMilliseconds;

  final parallelStarted = DateTime.now();
  final parallel = await Future.wait(
    inputs.map((s) => Isolate.run(() => _expensiveHash(s))),
  );
  final parallelMs = DateTime.now().difference(parallelStarted).inMilliseconds;

  return {
    'jobs': inputs.length,
    'sequentialMs': sequentialMs,
    'parallelMs': parallelMs,
    'speedup': parallelMs == 0 ? null : (sequentialMs / parallelMs * 10).round() / 10,
    'agree': sequential.first == parallel.first,
    'hashes': parallel,
  };
}

/// Deliberately slow, so the parallel version has something to show.
///
/// The loop count is what makes this a demonstration rather than a
/// measurement of isolate startup: too cheap, and spawning costs more than the
/// work itself.
int _expensiveHash(String input) {
  var hash = 0;
  for (var round = 0; round < 4000000; round++) {
    for (final unit in input.codeUnits) {
      hash = (hash * 31 + unit + round) & 0x7fffffff;
    }
  }
  return hash;
}
