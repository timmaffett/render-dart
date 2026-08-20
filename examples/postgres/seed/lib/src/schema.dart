/// The table this example uses, and the rows it starts with.
///
/// Kept in one place deliberately: the workflow tasks only ever read and write
/// this table, they never define it. One definition means the seeder is the
/// single answer to "what shape is the data".
library;

/// Creating the table is idempotent, so seeding can be re-run at will —
/// which matters because a free Render Postgres instance is deleted 30 days
/// after it is created, and this is what makes it reproducible.
const createWidgetsTable = '''
create table if not exists widgets (
  id          serial primary key,
  sku         text not null unique,
  name        text not null,
  quantity    integer not null default 0,
  price_cents integer not null,
  updated_at  timestamptz not null default now()
)
''';

/// Inserting is idempotent too: a re-run refreshes a row rather than failing
/// on the unique sku, or quietly doubling the inventory.
const upsertWidget = '''
insert into widgets (sku, name, quantity, price_cents)
values (@sku, @name, @quantity, @priceCents)
on conflict (sku) do update set
  name        = excluded.name,
  quantity    = excluded.quantity,
  price_cents = excluded.price_cents,
  updated_at  = now()
returning id, sku, name, quantity, price_cents, updated_at
''';

/// A small, boring inventory. Enough rows to make a `where` and an aggregate
/// mean something, few enough to read in a terminal.
const dummyWidgets = <Map<String, Object?>>[
  {'sku': 'WDG-001', 'name': 'Hex bolt, M8', 'quantity': 500, 'priceCents': 12},
  {'sku': 'WDG-002', 'name': 'Hex nut, M8', 'quantity': 480, 'priceCents': 7},
  {'sku': 'WDG-003', 'name': 'Flat washer, M8', 'quantity': 1200, 'priceCents': 3},
  {'sku': 'WDG-004', 'name': 'Socket cap screw, M6', 'quantity': 220, 'priceCents': 21},
  {'sku': 'WDG-005', 'name': 'Ball bearing, 608', 'quantity': 64, 'priceCents': 145},
  {'sku': 'WDG-006', 'name': 'Timing belt, 200mm', 'quantity': 18, 'priceCents': 890},
  {'sku': 'WDG-007', 'name': 'Linear rail, 300mm', 'quantity': 6, 'priceCents': 2450},
  {'sku': 'WDG-008', 'name': 'Stepper motor, NEMA 17', 'quantity': 12, 'priceCents': 1799},
];
