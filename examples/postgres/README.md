# postgres

Reading and writing a Render Postgres database from a Dart workflow task.

This is the clearest case for native tasks existing. `package:postgres` speaks
the wire protocol over a raw socket, so it needs `dart:io` — pub.dev marks it
`runtime:native-aot` and `runtime:native-jit`, with **no** `runtime:web`. It
cannot run under dart2js at all, and there is no WebAssembly build to fall back
on. Native or nothing.

## The two halves

`seed/` runs on **your machine**, over the database's *external* connection
string. It creates the table and fills it.

The tasks run **on Render**, over the *internal* one. So when a task changes a
row and `seed/bin/show.dart` sees it, the data has crossed two machines and two
connections — which is the thing worth demonstrating.

| Task | Shows |
| --- | --- |
| `listWidgets` | A parameterised query |
| `widgetStats` | An aggregate |
| `upsertWidget` | Insert or update |
| `restock` | `update … returning`, in one statement so concurrent runs cannot lose an update |
| `dbConnection` | `pg_backend_pid()` — proof the connection is held |

## Running it

```bash
cd seed
export RENDER_API_KEY=rnd_...        # the connection string is fetched for you
dart pub get && dart run bin/seed.dart

cd ..
export DATABASE_URL=<external connection string>
npm install && npx render-dart dev
render workflows start widgetStats --local --input='[]'
```

`seed.dart` is re-runnable: `create table if not exists`, rows upserted by sku.
That matters because a **free** Render Postgres instance is deleted 30 days
after creation, so this is the recipe for rebuilding the demo.

## Deploying

`DATABASE_URL` must hold the database's **internal** connection string. A
workflow's environment can only be set when the service is created — pass it
then, because `PATCH /workflows/{id}` cannot add one afterwards, leaving only
the Dashboard.

## Three things that will bite

**Worker mode is doing real work here.** Every task declares
`@NativeTask(worker: true)`, so the process stays alive and the TCP handshake,
TLS negotiation and authentication happen once rather than per call.
`dbConnection` proves it: the backend pid holds steady while a counter climbs.

**A held connection can die** — idle timeout, a restart, a deploy. `_db()`
checks and reconnects rather than surfacing a broken socket. That is the honest
cost of keeping state in a worker.

**`timestamptz` arrives as a `DateTime`, which is not JSON.** Rows are
converted to ISO-8601 strings before returning; otherwise the build rejects the
signature — correct, but puzzling if unexpected.

## A note on the connection string

Render's *internal* string carries no port, and `Uri.port` reports `0` for
that, which is not a port. `seed/lib/src/connect.dart` applies 5432 explicitly.
`Connection.openFromUrl` exists but takes TLS from an `sslmode` query parameter
Render's strings do not carry, so the endpoint is built by hand with
`SslMode.require`.
