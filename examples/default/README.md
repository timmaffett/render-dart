# default

The Workflows basics, with no dependencies beyond the SDK. This is what
`render-dart init` produces with no `--template`.

| Task | Shows |
| --- | --- |
| `calculateSquare` | A leaf task: arguments in, JSON out |
| `sumSquares` | Fan-out — each `callTask` is its own run on its own instance |
| `flaky` | Retry policy, and a failure reaching Render with its real message |

```bash
npm install && npx render-dart dev
render workflows start sumSquares --local --input='[[2, 3, 4]]'   # 29
```

`callTask` starts a **subtask of this workflow**. Reaching a task in a
*different* service goes through the API instead — see [`../introspect`](../introspect).
