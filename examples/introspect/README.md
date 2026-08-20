# introspect

A workflow task that uses Render's own API — to inspect the workspace, and to
run a task in a *different* workflow.

No native compilation. `package:render_api` runs under dart2js because it uses
`package:http`, whose web implementation goes through the platform's
networking.

| Task | Shows |
| --- | --- |
| `auditDatabases` | Every Postgres instance, and how long a free one has left |
| `listServices` | The workflow services, with the root dir that governs autodeploy |
| `runElsewhere` | Starting a task in another workflow and waiting for it |

```bash
npm install && npx render-dart dev
render workflows start auditDatabases --local --input='[]'
render workflows start runElsewhere --local \
  --input='["some-workflow/someTask", [7]]'
```

Needs `RENDER_API_KEY` on the service.

## Why this is not just a curiosity

`callTask` starts a **subtask of the current workflow**. Reaching a task in
another service has no bridge equivalent — it goes through the API. So
cross-workflow orchestration genuinely needs the SDK, and `runElsewhere` is
the shape of it.

The other natural use is scheduled operations: `auditDatabases` is one query
away from a task that warns before a free instance is deleted.

## Two things the web target forces

**There is no environment**, so `Platform.environment` is unavailable and a
client cannot pick up `RENDER_API_KEY` by itself. `node_env.dart` reaches
Node's `process.env` through the `require` that render-dart's runtime hoists,
and the token is passed explicitly.

**Server-sent events are unreliable there**, so `runElsewhere` polls.

`_awaitRun` polls the **run's own** status. A run has attempts, and an attempt
reaches a terminal state before the run does — watching `attempts[].status`
reports a run as finished while it is still going, which looks fine until a
retry happens. `package:render_workflows` has `waitFor`, which does this
properly; this example cannot depend on it yet, because that package depends on
`render_api` by path and a path dependency cannot resolve outside its own git
repository. That resolves when `render_api` reaches pub.dev.
