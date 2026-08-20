# http

Calling external APIs from a task. No native compilation needed.

`package:http` works under dart2js because its web implementation goes through
the platform's networking rather than `dart:io` sockets. `dart:io`'s
`HttpClient` does **not** — it compiles and then throws on first use, which is
why the build refuses a direct `dart:io` import.

| Task | Shows |
| --- | --- |
| `fetchRepo` | One request, with a timeout, and a real error on a bad status |
| `fetchWithRetry` | Retrying only what is worth retrying, with backoff |
| `fetchMany` | Overlapping requests — I/O concurrency needs no extra cores |

```bash
npm install && npx render-dart dev
render workflows start fetchRepo --local --input='["dart-lang/sdk"]'
```

Uses GitHub's public API, which is rate-limited without a token — fine for a
demonstration.

**Retry here, or Render's?** `Retry` on the task re-runs the whole thing, which
is right when a task fails. Retrying one request inside a task, as
`fetchWithRetry` does, avoids paying for another run.
