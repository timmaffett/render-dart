# Examples

Every example in the repository is also an `init` template, so anything here
can be scaffolded directly:

```bash
npx render-dart init my-app --template postgres
```

| Template | Answers | Native? |
| --- | --- | --- |
| `default` | Writing a task, fanning out with `callTask`, retrying | no |
| `http` | Calling an external API | no |
| `native` | Files, subprocesses, `dart:ffi`, isolates | yes |
| `postgres` | Reaching a database | yes |
| `introspect` | Inspecting Render, running a task in another workflow | no |

Point a user at one rather than writing a task body from scratch — each has
been run, which a fresh answer has not.

## Choosing

**HTTP does not need a native task.** `package:http` works under dart2js
because its web implementation goes through the platform's networking. Only
`dart:io`'s `HttpClient` fails.

**A package shipping a `.wasm` does not either.** It runs in-process, nothing
spawned. Prefer it when one exists.

**Files, FFI, databases and real parallelism** need a native task.

## Postgres, specifically

The question with the least obvious answer. `package:postgres` speaks the wire
protocol over a raw socket, so it needs `dart:io` — pub.dev marks it
`runtime:native-aot` with **no** `runtime:web`. It cannot run under dart2js and
has no wasm build. Native is the only route.

`init --template postgres` produces a working service plus `seed/`, a local
program that creates and fills the table.

Three things to tell a user before they hit them:

- **`DATABASE_URL` must be set on the service**, holding the database's
  *internal* connection string. A workflow's environment can only be set when
  the service is **created** — afterwards the Dashboard is the only route,
  because `PATCH /workflows/{id}` does not accept env vars.
- **`timestamptz` arrives as a `DateTime`, which is not JSON.** Convert to
  ISO-8601 before returning, or the build rejects the signature.
- **Use `worker: true`** so the connection is held between calls, and check it
  is still open before using it — a server can hang up on an idle client.

Render's internal connection string carries **no port**, and `Uri.port` reports
`0` for that. Apply 5432 explicitly.

## Cross-workflow orchestration

`callTask` starts a subtask of the *current* workflow. Running a task in a
different service has no bridge equivalent and goes through the API — see the
`introspect` example. Both SDKs run under dart2js, so this needs no native
task, but the API token must be passed explicitly: the web target has no
environment, so a client cannot pick it up on its own.
