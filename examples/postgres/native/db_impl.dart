// Database access for the workflow tasks, compiled AOT.
//
// This is the case where native is not a convenience but the only option:
// package:postgres speaks the wire protocol over a raw socket, so it needs
// dart:io. pub.dev marks it runtime:native-aot and runtime:native-jit, with no
// runtime:web — under dart2js it cannot run at all.
//
// Every task here declares worker: true. That keeps one process alive, and
// with it one open connection, so the TCP handshake, TLS negotiation and
// Postgres authentication happen once instead of on every call.
import 'dart:io';

import 'package:postgres/postgres.dart';

import '../native_task.dart';

const _worker = NativeTask(
  worker: true,
  idleTimeout: Duration(minutes: 2),
  timeout: Duration(seconds: 30),
);

Connection? _connection;
int _calls = 0;
DateTime? _connectedAt;

/// The held connection, opened on first use and re-established if it died.
///
/// A worker's state surviving between calls is what makes it fast, and also
/// what makes this necessary: Postgres can hang up on an idle client, a deploy
/// restarts the database, and the socket is then dead in a way that only shows
/// up on the next query. Checking beats surfacing a broken pipe to the caller.
Future<Connection> _db() async {
  final existing = _connection;
  if (existing != null && existing.isOpen) return existing;

  if (existing != null) {
    stderr.writeln('[db] connection was closed, reconnecting');
    _connection = null;
  }

  final url = Platform.environment['DATABASE_URL'];
  if (url == null || url.isEmpty) {
    throw StateError(
      'DATABASE_URL is not set on this service. It should hold the database\'s '
      'internal connection string — set it when creating the workflow, or in '
      'the Dashboard under the service\'s Environment.',
    );
  }

  final uri = Uri.parse(url);
  final userInfo = uri.userInfo.split(':');

  final connection = await Connection.open(
    Endpoint(
      host: uri.host,
      // Render's internal connection string carries no port, and Uri reports 0
      // rather than null for that, which is not a port.
      port: uri.hasPort ? uri.port : 5432,
      database: uri.pathSegments.isEmpty ? 'postgres' : uri.pathSegments.first,
      username: userInfo.isNotEmpty ? Uri.decodeComponent(userInfo.first) : null,
      password: userInfo.length > 1 ? Uri.decodeComponent(userInfo[1]) : null,
    ),
    settings: const ConnectionSettings(
      sslMode: SslMode.require,
      applicationName: 'render-dart-db-test',
      connectTimeout: Duration(seconds: 15),
    ),
  );

  _connection = connection;
  _connectedAt = DateTime.now();
  return connection;
}

/// Rows come back with DateTime values, which are not JSON. Converting here
/// keeps every task's return type inside what can cross the boundary —
/// otherwise `render-dart build` rejects the signature, correctly but
/// confusingly if you were not expecting it.
Map<String, Object?> _jsonRow(ResultRow row) => {
      for (final entry in row.toColumnMap().entries)
        entry.key: switch (entry.value) {
          final DateTime v => v.toIso8601String(),
          final v => v,
        },
    };

/// Lists widgets, newest update first, optionally filtered by sku.
@_worker
Future<List<Map<String, Object?>>> listWidgets({String? sku, int limit = 20}) async {
  _calls++;
  final db = await _db();

  final result = sku == null
      ? await db.execute(
          Sql.named('select * from widgets order by sku limit @limit'),
          parameters: {'limit': limit},
        )
      : await db.execute(
          Sql.named('select * from widgets where sku = @sku'),
          parameters: {'sku': sku},
        );

  return result.map(_jsonRow).toList();
}

/// A single aggregate row: how much stock there is and what it is worth.
@_worker
Future<Map<String, Object?>> widgetStats() async {
  _calls++;
  final db = await _db();

  final result = await db.execute('''
    select count(*)                        as widgets,
           coalesce(sum(quantity), 0)      as units,
           coalesce(sum(quantity * price_cents), 0) as value_cents,
           max(updated_at)                 as newest_update
    from widgets
  ''');

  return _jsonRow(result.first);
}

/// Inserts a widget, or updates it if the sku already exists.
@_worker
Future<Map<String, Object?>> upsertWidget(
  String sku,
  String name,
  int quantity,
  int priceCents,
) async {
  _calls++;
  final db = await _db();

  final result = await db.execute(
    Sql.named('''
      insert into widgets (sku, name, quantity, price_cents)
      values (@sku, @name, @quantity, @priceCents)
      on conflict (sku) do update set
        name        = excluded.name,
        quantity    = excluded.quantity,
        price_cents = excluded.price_cents,
        updated_at  = now()
      returning *
    '''),
    parameters: {
      'sku': sku,
      'name': name,
      'quantity': quantity,
      'priceCents': priceCents,
    },
  );

  return _jsonRow(result.first);
}

/// Adds [delta] to a widget's quantity and returns the row that changed.
///
/// Done in one statement rather than read-then-write, so two concurrent runs
/// cannot lose an update between them.
@_worker
Future<Map<String, Object?>> restock(String sku, int delta) async {
  _calls++;
  final db = await _db();

  final result = await db.execute(
    Sql.named('''
      update widgets
         set quantity = quantity + @delta,
             updated_at = now()
       where sku = @sku
      returning *
    '''),
    parameters: {'sku': sku, 'delta': delta},
  );

  if (result.isEmpty) throw ArgumentError.value(sku, 'sku', 'no widget with that sku');
  return _jsonRow(result.first);
}

/// Proves the connection is being reused, from the server's point of view.
///
/// `pg_backend_pid()` is the Postgres process serving this session. If it holds
/// steady across calls, the worker really is reusing one connection rather than
/// reconnecting — the database-side counterpart to the process pid in
/// nativeLoop.
@_worker
Future<Map<String, Object?>> dbConnection() async {
  _calls++;
  final db = await _db();

  final result = await db.execute(
    'select pg_backend_pid() as backend_pid, current_database() as database, '
    'version() as server',
  );
  final row = _jsonRow(result.first);

  return {
    ...row,
    'processPid': pid,
    'callsThisProcess': _calls,
    'connectionAgeMs':
        _connectedAt == null ? 0 : DateTime.now().difference(_connectedAt!).inMilliseconds,
  };
}
