// Generates the two halves of a native task from an annotated Dart file.
//
// Reads a file containing `@nativeTask` top-level functions and writes:
//
//   <name>.g.dart          typed stubs, imported by the dart2js task code
//   <name>.main.dart       the dispatcher main(), which is what compiles AOT
//
// The analyzer is used rather than pattern matching because the stubs have to
// reproduce parameter names, defaults, nullability and generics exactly — a
// regex that is right most of the time would produce code that fails to
// compile in ways the author cannot fix.
import 'dart:convert';
import 'dart:io';

import 'package:analyzer/dart/analysis/analysis_context_collection.dart';
import 'package:analyzer/dart/analysis/results.dart';
import 'package:analyzer/dart/element/element.dart';
import 'package:analyzer/dart/element/nullability_suffix.dart';
import 'package:analyzer/dart/element/type.dart';

Future<int> main(List<String> argv) async {
  final args = _parseArgs(argv);
  final project = args['project']!;
  final entry = args['entry']!;
  final name = args['name']!;
  final stubPath = args['stub']!;
  final mainPath = args['main']!;
  final facadePath = args['facade']!;
  // package.json overrides the annotation; absent means "annotation decides".
  final override = _Options(
    worker: args['worker'] == null ? null : args['worker'] == 'true',
    idleTimeoutMs: int.tryParse(args['idle'] ?? ''),
    timeoutMs: int.tryParse(args['timeout'] ?? ''),
  );

  final collection = AnalysisContextCollection(includedPaths: [project, entry]);
  final session = collection.contextFor(entry).currentSession;
  final resolved = await session.getResolvedLibrary(entry);

  if (resolved is! ResolvedLibraryResult) {
    return _fail('could not analyse $entry: $resolved');
  }

  final errors = <String>[];
  for (final unit in resolved.units) {
    for (final d in unit.diagnostics) {
      if (d.severity.name == 'ERROR') {
        errors.add('  ${d.message} (line ${unit.lineInfo.getLocation(d.offset).lineNumber})');
      }
    }
  }
  if (errors.isNotEmpty) {
    return _fail('${_rel(project, entry)} does not analyse cleanly:\n${errors.join('\n')}');
  }

  final fns = resolved.element.topLevelFunctions.where(_isNativeTask).toList();
  if (fns.isEmpty) {
    return _fail(
      'no @nativeTask functions in ${_rel(project, entry)}.\n'
      'Annotate a top-level function with @nativeTask, or declare this entry '
      'with "mode": "exe" if it owns its own main().',
    );
  }

  final problems = <String>[];
  for (final fn in fns) {
    problems.addAll(_validate(fn));
  }
  if (problems.isNotEmpty) {
    return _fail(
      'these @nativeTask signatures cannot cross a JSON boundary:\n'
      '${problems.map((p) => '  $p').join('\n')}\n\n'
      'Supported: bool, int, double, num, String, List<T>, Map<String, T>, '
      'Object?, dynamic, and Future<T> of those.',
    );
  }

  File(stubPath)
    ..createSync(recursive: true)
    ..writeAsStringSync(_stubs(name, fns, stubPath, project, override));
  File(facadePath)
    ..createSync(recursive: true)
    ..writeAsStringSync(_facade(name, stubPath, facadePath, entry));
  File(mainPath)
    ..createSync(recursive: true)
    ..writeAsStringSync(_dispatcher(name, fns, mainPath, entry, project));

  stdout.writeln(jsonEncode({
    'name': name,
    'methods': [for (final f in fns) f.name],
  }));
  return 0;
}

// ---------------------------------------------------------------- annotations

/// Effective settings for one native task.
class _Options {
  const _Options({this.worker, this.idleTimeoutMs, this.timeoutMs});

  final bool? worker;
  final int? idleTimeoutMs;
  final int? timeoutMs;

  /// [other] wins where it has an opinion. Used for package.json over the
  /// annotation, so a deployment can change behaviour without editing code.
  _Options overriddenBy(_Options other) => _Options(
        worker: other.worker ?? worker,
        idleTimeoutMs: other.idleTimeoutMs ?? idleTimeoutMs,
        timeoutMs: other.timeoutMs ?? timeoutMs,
      );
}

/// Reads `@NativeTask(...)` arguments off the function.
_Options _optionsOf(TopLevelFunctionElement fn) {
  for (final a in fn.metadata.annotations) {
    final value = a.computeConstantValue();
    if (value?.type?.element?.name != 'NativeTask') continue;

    // A const Duration exposes its microseconds as a field on the constant.
    // Current SDKs name it `inMicroseconds`; older ones used the private
    // `_duration`, so both are tried rather than silently reading null and
    // falling back to a default the author did not ask for.
    int? ms(String field) {
      final duration = value!.getField(field);
      if (duration == null || duration.isNull) return null;

      final micros = duration.getField('inMicroseconds')?.toIntValue() ??
          duration.getField('_duration')?.toIntValue();
      if (micros == null) {
        stderr.writeln(
          'warning: could not read $field from @NativeTask on ${fn.name}; '
          'using the default instead',
        );
        return null;
      }
      return micros ~/ 1000;
    }

    return _Options(
      worker: value!.getField('worker')?.toBoolValue(),
      idleTimeoutMs: ms('idleTimeout'),
      timeoutMs: ms('timeout'),
    );
  }
  return const _Options();
}

bool _isNativeTask(TopLevelFunctionElement fn) {
  for (final a in fn.metadata.annotations) {
    // Matches both `@nativeTask` (a const instance) and `@NativeTask()`.
    final value = a.computeConstantValue();
    final typeName = value?.type?.element?.name;
    if (typeName == 'NativeTask') return true;
  }
  return false;
}

// ----------------------------------------------------------------- validation

/// Unwraps `Future<T>` to `T`; other types are returned unchanged.
DartType _unwrapFuture(DartType t) {
  if (t is InterfaceType && t.isDartAsyncFuture && t.typeArguments.length == 1) {
    return t.typeArguments.single;
  }
  return t;
}

bool _jsonable(DartType t) {
  if (t is VoidType || t is DynamicType) return true;
  if (t.isDartCoreBool || t.isDartCoreInt || t.isDartCoreDouble) return true;
  if (t.isDartCoreNum || t.isDartCoreString || t.isDartCoreNull) return true;
  if (t.isDartCoreObject) return true;
  if (t is InterfaceType) {
    if (t.isDartCoreList) return _jsonable(t.typeArguments.single);
    if (t.isDartCoreMap) {
      return t.typeArguments[0].isDartCoreString && _jsonable(t.typeArguments[1]);
    }
  }
  return false;
}

List<String> _validate(TopLevelFunctionElement fn) {
  final out = <String>[];
  final ret = _unwrapFuture(fn.returnType);
  if (!_jsonable(ret)) {
    out.add('${fn.name}: return type ${_display(fn.returnType)}');
  }
  for (final p in fn.formalParameters) {
    if (!_jsonable(p.type)) {
      out.add('${fn.name}: parameter "${p.name}" of type ${_display(p.type)}');
    }
  }
  return out;
}

// -------------------------------------------------------------------- codegen

String _display(DartType t) => t.getDisplayString();

bool _nullable(DartType t) =>
    t.nullabilitySuffix == NullabilitySuffix.question || t is DynamicType;

/// A Dart expression converting `expr` (raw decoded JSON) into [t].
///
/// A plain `as` cast is not enough: jsonDecode produces `List<dynamic>` and
/// `Map<String, dynamic>`, so `as List<int>` throws even when every element is
/// an int. Collections are rebuilt element by element, and doubles go through
/// num because JSON does not distinguish 3 from 3.0.
String _decode(DartType t, String expr) {
  if (t is VoidType || t is DynamicType || t.isDartCoreObject) return expr;

  final q = _nullable(t);
  final bang = q ? '?' : '';

  if (t.isDartCoreDouble) {
    return q ? '($expr as num?)?.toDouble()' : '($expr as num).toDouble()';
  }
  if (t.isDartCoreBool || t.isDartCoreInt || t.isDartCoreNum || t.isDartCoreString) {
    return '$expr as ${_display(t)}';
  }
  if (t is InterfaceType && t.isDartCoreList) {
    final e = t.typeArguments.single;
    return '($expr as List$bang)$bang.map((e) => ${_decode(e, 'e')}).toList()';
  }
  if (t is InterfaceType && t.isDartCoreMap) {
    final v = t.typeArguments[1];
    return '($expr as Map$bang)$bang.map((k, e) => '
        'MapEntry(k as String, ${_decode(v, 'e')}))';
  }
  return expr;
}

String _rel(String from, String to) {
  final f = Directory(from).absolute.path.split(Platform.pathSeparator);
  final t = File(to).absolute.path.split(Platform.pathSeparator);
  var i = 0;
  while (i < f.length && i < t.length && f[i] == t[i]) i++;
  return [...List.filled(f.length - i, '..'), ...t.sublist(i)].join('/');
}

/// Import path from the file at [fromFile] to [toFile].
String _importPath(String fromFile, String toFile) =>
    _rel(File(fromFile).parent.path, toFile);

String _header(String name) => '''
// GENERATED by render-dart from a @nativeTask source. Do not edit.
//
// Regenerated by `render-dart build`; changes here are overwritten.
''';

String _stubs(
  String name,
  List<TopLevelFunctionElement> fns,
  String stubPath,
  String project,
  _Options override,
) {
  final b = StringBuffer(_header(name))
    ..writeln("import '${_importPath(stubPath, '$project/render_dart.dart')}';")
    ..writeln();

  for (final fn in fns) {
    final ret = _unwrapFuture(fn.returnType);
    final isVoid = ret is VoidType;
    final sig = _stubSignature(fn);
    final positional = fn.formalParameters.where((p) => !p.isNamed).toList();
    final named = fn.formalParameters.where((p) => p.isNamed).toList();

    final args = '[${positional.map((p) => p.name).join(', ')}]';
    final namedMap = named.isEmpty
        ? 'const {}'
        : '{${named.map((p) => "'${p.name}': ${p.name}").join(', ')}}';

    b
      ..writeln('/// Runs `${fn.name}` in the `$name` native executable.')
      ..writeln('Future<${isVoid ? 'void' : _display(ret)}> $sig async {');
    // Settings ride with the declaration, so nothing at the call site has to
    // know this is native.
    final o = _optionsOf(fn).overriddenBy(override);
    final tail = (o.worker ?? false)
        ? ', true, ${o.idleTimeoutMs ?? 30000}, ${o.timeoutMs ?? 0}'
        : (o.timeoutMs != null ? ', false, 30000, ${o.timeoutMs}' : '');
    final call = "callNativeTask('$name', '${fn.name}', $args, $namedMap$tail)";
    if (isVoid) {
      b.writeln('  await $call;');
    } else {
      b
        ..writeln('  final r = await $call;')
        ..writeln('  return ${_decode(ret, 'r')};');
    }
    b
      ..writeln('}')
      ..writeln();
  }
  return b.toString();
}

String _stubSignature(TopLevelFunctionElement fn) {
  final positional = <String>[];
  final optional = <String>[];
  final named = <String>[];

  for (final p in fn.formalParameters) {
    final decl = '${_display(p.type)} ${p.name}';
    if (p.isNamed) {
      final def = p.hasDefaultValue ? ' = ${p.defaultValueCode}' : '';
      named.add(p.isRequiredNamed ? 'required $decl' : '$decl$def');
    } else if (p.isOptionalPositional) {
      optional.add(p.hasDefaultValue ? '$decl = ${p.defaultValueCode}' : decl);
    } else {
      positional.add(decl);
    }
  }

  final parts = [
    ...positional,
    if (optional.isNotEmpty) '[${optional.join(', ')}]',
    if (named.isNotEmpty) '{${named.join(', ')}}',
  ];
  return '${fn.name}(${parts.join(', ')})';
}

/// The file callers import.
///
/// A conditional export, so the same import resolves to the real
/// implementation when compiled AOT and to the process-spawning stub under
/// dart2js. That is what lets task code call a native task by its plain name
/// with no knowledge that it is native — and lets native code calling a
/// sibling native function skip the process hop entirely.
String _facade(String name, String stubPath, String facadePath, String entry) => '''
${_header(name)}// Callers import this file, not the implementation beside it.
//
// Under dart2js `dart.library.io` is false, so this resolves to the stub that
// spawns the executable. Compiled AOT it resolves to the implementation and the
// call is direct.
//
// Always `await` a native task: the stub returns a Future where the
// implementation may return a plain value, so awaiting is what makes one piece
// of code compile against both.
export '${_importPath(facadePath, stubPath)}'
    if (dart.library.io) '${_importPath(facadePath, entry)}';
''';

String _dispatcher(
  String name,
  List<TopLevelFunctionElement> fns,
  String mainPath,
  String entry,
  String project,
) {
  final b = StringBuffer(_header(name))
    ..writeln("import '${_importPath(mainPath, entry)}';")
    ..writeln("import '${_importPath(mainPath, '$project/native_task.dart')}';")
    ..writeln()
    ..writeln('Future<void> main(List<String> args) => nativeTaskMain(args, {');

  for (final fn in fns) {
    final call = <String>[];
    var i = 0;
    for (final p in fn.formalParameters) {
      if (p.isNamed) {
        final fallback = p.hasDefaultValue
            ? p.defaultValueCode!
            : (_nullable(p.type) ? 'null' : "_missing('${fn.name}', '${p.name}')");
        call.add(
          "${p.name}: n.containsKey('${p.name}') "
          '? ${_decode(p.type, "n['${p.name}']")} : $fallback',
        );
      } else {
        final idx = i++;
        final read = _decode(p.type, 'a[$idx]');
        if (p.isOptionalPositional) {
          final fallback = p.hasDefaultValue
              ? p.defaultValueCode!
              : (_nullable(p.type) ? 'null' : "_missing('${fn.name}', '${p.name}')");
          call.add('a.length > $idx ? $read : $fallback');
        } else {
          call.add(read);
        }
      }
    }
    b.writeln("  '${fn.name}': (a, n) async => ${fn.name}(${call.join(', ')}),");
  }

  b.writeln('});');

  final body = b.toString();
  if (!body.contains('_missing(')) return body;

  return '$body\n'
      'Never _missing(String fn, String param) =>\n'
      "    throw ArgumentError('\$fn requires the parameter \"\$param\"');\n";
}

// ------------------------------------------------------------------- plumbing

Map<String, String> _parseArgs(List<String> argv) {
  final out = <String, String>{};
  for (var i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].substring(2)] = argv[++i];
  }
  for (final k in ['project', 'entry', 'name', 'stub', 'main', 'facade']) {
    if (!out.containsKey(k)) {
      stderr.writeln('generate.dart: missing --$k');
      exit(2);
    }
  }
  return out;
}

int _fail(String message) {
  stderr.writeln(message);
  // An async main's return value is NOT the process exit code — only a
  // synchronous `int main()` works that way. Setting exitCode is what actually
  // makes the build fail instead of silently continuing with no output.
  exitCode = 1;
  return 1;
}
