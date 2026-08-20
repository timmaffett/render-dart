import 'dart:convert';

import 'package:http/http.dart' as http;

import 'render_dart.dart';

/// Calling an external API from a task.
///
/// `package:http` works under dart2js — its web implementation goes through
/// the browser's networking, which render-dart's runtime provides on Node. That
/// is why fetching a URL needs no native task, while touching a file or a
/// socket does.
///
/// `dart:io`'s `HttpClient` does **not** work: it compiles and then throws
/// `Unsupported operation` on first use. The build refuses a direct `dart:io`
/// import for exactly this reason.
void main() {
  /// A single request, with a timeout.
  ///
  /// Render bounds a task run anyway, but a per-request timeout turns a hung
  /// dependency into a quick, legible failure instead of burning the run's
  /// whole budget.
  task('fetchRepo', (args) async {
    final name = args.isEmpty ? 'dart-lang/sdk' : args[0]! as String;

    final response = await http
        .get(
          Uri.https('api.github.com', '/repos/$name'),
          headers: {'accept': 'application/vnd.github+json'},
        )
        .timeout(const Duration(seconds: 10));

    if (response.statusCode != 200) {
      // Throwing gives Render the real message in the run record.
      throw StateError('GitHub answered ${response.statusCode} for $name');
    }

    final json = jsonDecode(response.body) as Map<String, Object?>;
    return {
      'name': json['full_name'],
      'stars': json['stargazers_count'],
      'language': json['language'],
      'pushedAt': json['pushed_at'],
    };
  });

  /// Retrying on the failures that are worth retrying.
  ///
  /// Render's own `retry` option re-runs the whole task, which is the right
  /// tool for a task that fails. This is the finer-grained version: retry one
  /// request without paying for another run.
  task('fetchWithRetry', (args) async {
    final url = Uri.parse(args[0]! as String);
    final attempts = args.length < 2 ? 3 : args[1]! as int;

    for (var attempt = 1; ; attempt++) {
      try {
        final response = await http.get(url).timeout(const Duration(seconds: 10));

        // 4xx will not improve by asking again; 5xx and timeouts might.
        if (response.statusCode < 500) {
          return {
            'status': response.statusCode,
            'attempts': attempt,
            'bytes': response.bodyBytes.length,
          };
        }
        if (attempt >= attempts) {
          throw StateError('$url still answering ${response.statusCode} '
              'after $attempt attempt(s)');
        }
      } catch (e) {
        if (attempt >= attempts) rethrow;
        print('attempt $attempt failed: $e');
      }

      // Exponential backoff, so a struggling service is not hammered.
      await Future<void>.delayed(Duration(milliseconds: 250 * (1 << (attempt - 1))));
    }
  });

  /// Fetching several URLs at once.
  ///
  /// dart2js is single-threaded, but HTTP is I/O — these overlap happily. Work
  /// that needs actual cores is the case for a native task with isolates.
  task('fetchMany', (args) async {
    final urls = (args[0]! as List<Object?>).cast<String>();

    final responses = await Future.wait(
      urls.map((u) => http.get(Uri.parse(u)).timeout(const Duration(seconds: 10))),
    );

    return [
      for (var i = 0; i < urls.length; i++)
        {'url': urls[i], 'status': responses[i].statusCode, 'bytes': responses[i].bodyBytes.length},
    ];
  });

  start();
}
