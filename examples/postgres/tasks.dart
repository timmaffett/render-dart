import 'render_dart.dart';
// The natural name. Nothing here says these run in another process, or that
// they touch dart:io — the facade resolves to a stub under dart2js.
import 'native/db.dart';

/// Render Workflows tasks backed by a Render Postgres database.
///
/// package:postgres cannot run under dart2js, so every one of these reaches a
/// natively compiled binary. Nothing at the call site says so.
///
/// The table is created and filled by `seed/`, which runs on your machine over
/// the database's *external* connection string. These tasks read the same rows
/// from inside Render over the *internal* one — so a change made by a task and
/// seen by `seed/bin/show.dart` has crossed two machines and two connections.
void main() {
  /// Query, optionally filtered.
  task('listWidgets', (args) async => await listWidgets(
        sku: args.isEmpty ? null : args[0] as String?,
        limit: args.length < 2 ? 20 : args[1]! as int,
      ));

  /// A single aggregate row.
  task('widgetStats', (args) async => await widgetStats());

  /// Insert or update.
  task('upsertWidget', (args) async => await upsertWidget(
        args[0]! as String,
        args[1]! as String,
        args[2]! as int,
        args[3]! as int,
      ));

  /// Update one row and return it.
  task('restock', (args) async => await restock(
        args[0]! as String,
        args[1]! as int,
      ));

  /// Calls dbConnection repeatedly to show that a worker holds one Postgres
  /// session: the backend pid stays put while the call counter climbs.
  ///
  /// Reconnecting per call would show a different pid every time — and pay for
  /// a TCP handshake, TLS negotiation and authentication each round.
  task('connectionReuse', (args) async {
    final n = args.isEmpty ? 5 : args[0]! as int;
    final started = DateTime.now();

    final backendPids = <Object?>{};
    Map<String, Object?> last = const {};
    for (var i = 0; i < n; i++) {
      last = await dbConnection();
      backendPids.add(last['backend_pid']);
    }

    return {
      'calls': n,
      'ms': DateTime.now().difference(started).inMilliseconds,
      'distinctBackendPids': backendPids.length,
      'callsThisProcess': last['callsThisProcess'],
      'connectionAgeMs': last['connectionAgeMs'],
      'database': last['database'],
    };
  }, timeoutSeconds: 120);

  start();
}
