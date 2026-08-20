/// Getting a connection to the Render Postgres instance.
///
/// Two credential sources, in order:
///
///   DATABASE_URL      if set, used as-is. Works offline, against a local
///                     Postgres, or anywhere an API key is unavailable.
///   RENDER_API_KEY    otherwise, the connection string is fetched through
///                     package:render_api. Nothing to copy, nothing to keep in
///                     a file, and it survives the database being recreated.
library;

import 'dart:io';

import 'package:postgres/postgres.dart';
import 'package:render_api/render_api.dart';

// Callers need Sql and Connection alongside these helpers; re-exporting
// keeps them to a single import.
export 'package:postgres/postgres.dart' show Connection, Endpoint, Sql, SslMode;

/// The example's database. An id is an identifier, not a secret.
const defaultDatabaseId = 'dpg-da3b13gae00c73ag6t8g-a';

/// Resolves a connection string without opening anything.
///
/// [internal] picks Render's private hostname, which only resolves from inside
/// Render's network and in the same region. Local programs want the external
/// one; a workflow task wants internal — faster, and it never leaves Render.
Future<String> resolveConnectionString({
  String databaseId = defaultDatabaseId,
  bool internal = false,
}) async {
  final fromEnv = Platform.environment['DATABASE_URL'];
  if (fromEnv != null && fromEnv.isNotEmpty) return fromEnv;

  if ((Platform.environment['RENDER_API_KEY'] ?? '').isEmpty) {
    throw StateError(
      'Neither DATABASE_URL nor RENDER_API_KEY is set.\n'
      '  export RENDER_API_KEY=rnd_...   and the connection string is fetched for you\n'
      '  export DATABASE_URL=postgresql://...   to point somewhere else entirely',
    );
  }

  final render = RenderApi();
  try {
    final info = await render.retrievePostgresConnectionInfo(postgresId: databaseId);
    return internal ? info.internalConnectionString : info.externalConnectionString;
  } finally {
    render.close();
  }
}

/// Turns a connection string into an [Endpoint].
///
/// `Connection.openFromUrl` exists, but it takes TLS from an `sslmode` query
/// parameter that Render's strings do not carry, and Render's *internal*
/// string has no port at all — `Uri.port` reports 0 for that, which is not a
/// port. Both are handled here rather than left to chance.
Endpoint endpointFor(String connectionString) {
  final uri = Uri.parse(connectionString);
  final userInfo = uri.userInfo.split(':');

  return Endpoint(
    host: uri.host,
    port: uri.hasPort ? uri.port : 5432,
    database: uri.pathSegments.isEmpty ? 'postgres' : uri.pathSegments.first,
    username: userInfo.isNotEmpty ? Uri.decodeComponent(userInfo.first) : null,
    password: userInfo.length > 1 ? Uri.decodeComponent(userInfo[1]) : null,
  );
}

/// Opens a connection, with TLS.
///
/// Render requires TLS for external connections and supports it internally.
/// [SslMode.require] encrypts without verifying the certificate chain, which
/// is what Render's managed certificates need; [SslMode.verifyFull] would want
/// a `securityContext` carrying their CA.
Future<Connection> openConnection(String connectionString) => Connection.open(
      endpointFor(connectionString),
      settings: const ConnectionSettings(
        sslMode: SslMode.require,
        applicationName: 'render_postgres_example',
        connectTimeout: Duration(seconds: 15),
      ),
    );

/// Hides the password in a connection string, for printing.
String describe(String connectionString) {
  final uri = Uri.parse(connectionString);
  final user = uri.userInfo.split(':').first;
  final port = uri.hasPort ? uri.port : 5432;
  return '$user@${uri.host}:$port${uri.path}';
}
