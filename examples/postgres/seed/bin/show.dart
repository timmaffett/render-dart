// Prints what is actually in the widgets table.
//
//   dart run bin/show.dart
//   dart run bin/show.dart --sku WDG-005
//
// Useful as the independent check on a workflow task: run a task that mutates
// a row, then run this from your laptop and see the change. Different machine,
// different connection string, same data.
import 'dart:io';

import 'package:render_dart_postgres_seed/src/connect.dart';

Future<void> main(List<String> args) async {
  final sku = _option(args, 'sku');

  final connectionString = await resolveConnectionString();
  final db = await openConnection(connectionString);

  try {
    final result = sku == null
        ? await db.execute(
            'select sku, name, quantity, price_cents, updated_at '
            'from widgets order by sku')
        : await db.execute(
            Sql.named('select sku, name, quantity, price_cents, updated_at '
                'from widgets where sku = @sku'),
            parameters: {'sku': sku},
          );

    if (result.isEmpty) {
      stdout.writeln(sku == null ? 'widgets is empty' : 'no widget with sku $sku');
      return;
    }

    stdout.writeln('${'sku'.padRight(10)} ${'name'.padRight(24)} '
        '${'qty'.padLeft(6)} ${'price'.padLeft(9)}  updated');
    var totalCents = 0;
    for (final row in result) {
      final r = row.toColumnMap();
      final quantity = r['quantity'] as int;
      final priceCents = r['price_cents'] as int;
      totalCents += quantity * priceCents;

      stdout.writeln('${(r['sku'] as String).padRight(10)} '
          '${(r['name'] as String).padRight(24)} '
          '${quantity.toString().padLeft(6)} '
          '${_money(priceCents).padLeft(9)}  '
          '${(r['updated_at'] as DateTime).toIso8601String().substring(0, 19)}');
    }
    stdout.writeln('\n${result.length} row(s), inventory value ${_money(totalCents)}');
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
