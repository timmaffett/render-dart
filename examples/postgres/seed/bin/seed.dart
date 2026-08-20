// Creates the widgets table and fills it with sample rows.
//
//   dart run bin/seed.dart
//   dart run bin/seed.dart --database-id dpg-...
//   DATABASE_URL=postgresql://... dart run bin/seed.dart
//
// Safe to re-run: the table is created only if absent, and rows are upserted
// by sku. That matters because a free Render Postgres instance is deleted 30
// days after creation, so this is the recipe for getting the demo back.
//
// This is deliberately NOT a workflow task. It runs from a laptop over the
// external connection string, which is the other half of the demonstration —
// the tasks later read the same rows from inside Render.
import 'dart:io';

import 'package:render_dart_postgres_seed/src/connect.dart';
import 'package:render_dart_postgres_seed/src/schema.dart';

Future<void> main(List<String> args) async {
  final databaseId = _option(args, 'database-id') ?? defaultDatabaseId;

  final connectionString = await resolveConnectionString(databaseId: databaseId);
  stdout.writeln('connecting to ${describe(connectionString)}');

  final db = await openConnection(connectionString);
  try {
    await db.execute(createWidgetsTable);
    stdout.writeln('table widgets is ready');

    for (final widget in dummyWidgets) {
      final result = await db.execute(
        Sql.named(upsertWidget),
        parameters: widget,
      );
      final row = result.first.toColumnMap();
      stdout.writeln('  ${row['sku']}  ${row['name']}'
          '  qty ${row['quantity']}'
          '  ${_money(row['price_cents'] as int)}');
    }

    final count = await db.execute('select count(*) from widgets');
    stdout.writeln('\n${count.first.first} row(s) in widgets');
  } finally {
    await db.close();
  }
}

String _money(int cents) => '\$${(cents / 100).toStringAsFixed(2)}';

String? _option(List<String> args, String name) {
  for (var i = 0; i < args.length; i++) {
    if (args[i] == '--$name' && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith('--$name=')) return args[i].substring(name.length + 3);
  }
  return null;
}
