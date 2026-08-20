import 'render_dart.dart';

/// Your Render Workflows tasks, in Dart.
///
/// Arguments and return values must be JSON-serialisable, and Render caps a
/// single invocation's input at 4 MB.
void main() {
  // A leaf task: pure computation.
  task('calculateSquare', (args) async {
    final n = args[0]! as int;
    print('calculateSquare($n)');
    return n * n;
  });

  // A parent task. Every callTask becomes its own task run on its own
  // instance, which is how you fan work out across Render.
  task('sumSquares', (args) async {
    final values = args[0]! as List<Object?>;

    var total = 0;
    for (final v in values) {
      final square = await callTask('calculateSquare', [v]);
      total += square! as int;
    }
    return total;
  });

  // Options are typed and validated before they reach Render.
  task(
    'flaky',
    (args) async {
      throw StateError('this always fails, to show error reporting');
    },
    retry: const Retry(maxRetries: 2, waitDurationMs: 1000),
    plan: TaskPlan.starter,
  );

  start();
}
