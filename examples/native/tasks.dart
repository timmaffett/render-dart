import 'render_dart.dart';
// The plain name. Nothing here says these run in another process.
import 'native/tools.dart';

/// Tasks backed by natively compiled Dart.
///
/// `render-dart build` compiles `native/tools_impl.dart` to an executable and
/// generates `native/tools.dart`, which resolves to a process call under
/// dart2js and to the real function when compiled natively.
///
/// Always `await` one: the stub returns a `Future` where the implementation
/// may return a plain value.
void main() {
  /// Reading a file — impossible from dart2js.
  task('readFile', (args) async => await readFile(
        args[0]! as String,
        previewLines: args.length < 2 ? 3 : args[1]! as int,
      ));

  /// Shelling out.
  task('runCommand', (args) async => await runCommand(
        args[0]! as String,
        (args.length < 2 ? const <Object?>[] : args[1]! as List<Object?>).cast<String>(),
      ));

  /// dart:ffi and platform details.
  task('platformInfo', (args) async => await platformInfo());

  /// Real parallelism across cores.
  task('parallelHash', (args) async => await parallelHash(
        (args[0]! as List<Object?>).cast<String>(),
      ), timeoutSeconds: 120);

  start();
}
