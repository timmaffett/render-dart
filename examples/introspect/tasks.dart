import 'package:render_api/render_api.dart';

import 'node_env.dart';
import 'render_dart.dart';

/// Tasks that inspect and orchestrate Render itself.
///
/// Both SDKs run under dart2js — they use `package:http`, whose web
/// implementation goes through the browser's networking rather than dart:io
/// sockets — so none of this needs a native task.
///
/// Two things follow from running on the web target:
///
///   * There is no environment, so the API token must be passed explicitly.
///     `node_env.dart` reaches Node's `process.env` through the bridge.
///   * Server-sent events are unreliable there, so `runElsewhere` polls.
///
/// Needs `RENDER_API_KEY` set on the service. A workflow's environment can only
/// be set when it is created, so pass it then — `PATCH /workflows/{id}` cannot
/// add one afterwards.
void main() {
  /// Reports every Postgres instance, and how long a free one has left.
  ///
  /// A free instance is **deleted** 30 days after creation, which is the sort
  /// of thing worth a scheduled task rather than a diary entry.
  task('auditDatabases', (args) async {
    final render = RenderApi(token: requireEnv('RENDER_API_KEY'));
    try {
      final instances = await render.listPostgres(limit: 50);
      final now = DateTime.now();

      return [
        for (final entry in instances)
          {
            'name': entry.postgres.name,
            'id': entry.postgres.id,
            'plan': entry.postgres.plan.wireValue,
            'region': entry.postgres.region.wireValue,
            'status': entry.postgres.status.wireValue,
            'expiresInDays': entry.postgres.expiresAt == null
                ? null
                : entry.postgres.expiresAt!.difference(now).inDays,
          },
      ];
    } finally {
      render.close();
    }
  });

  /// Lists the workflow services in this workspace.
  ///
  /// Root directory is the field worth reading: autodeploy fires only for
  /// commits touching it.
  task('listServices', (args) async {
    final render = RenderApi(token: requireEnv('RENDER_API_KEY'));
    try {
      final workflows = await render.listWorkflows(limit: 50);
      return [
        for (final entry in workflows)
          {
            'name': entry.workflow.name,
            'id': entry.workflow.id,
            'rootDir': entry.workflow.buildConfig.rootDir ?? '(repo root)',
            'autoDeploy': entry.workflow.autoDeployTrigger?.wireValue ?? 'off',
          },
      ];
    } finally {
      render.close();
    }
  });

  /// Runs a task in a **different** workflow, and waits for it.
  ///
  /// This is the thing `callTask` cannot do. `callTask` starts a subtask of
  /// *this* workflow; reaching another service means going through the API, so
  /// cross-workflow orchestration needs the SDK rather than the bridge.
  ///
  /// The slug is `workflow-slug/task-name`.
  task('runElsewhere', (args) async {
    final slug = args[0]! as String;
    final input = args.length < 2 ? const <Object?>[] : args[1]! as List<Object?>;

    final render = RenderApi(token: requireEnv('RENDER_API_KEY'));
    try {
      // Render calls this operation `createTask`, but it is "run task".
      final started = await render.createTask(
        body: CreateTaskRequest(task: slug, input: input),
      );

      final finished = await _awaitRun(render, started.id);
      return {
        'taskRunId': finished.id,
        'status': finished.status.wireValue,
        'result': finished.results.isEmpty ? null : finished.results.first,
        'error': finished.error,
      };
    } finally {
      render.close();
    }
  }, timeoutSeconds: 300);

  start();
}

/// Terminal states for a task run.
///
/// Both `completed` and `succeeded` exist in the API, which is exactly the
/// sort of detail that makes a hand-rolled status check wrong.
const _terminal = {
  GetTaskRunStatus.completed,
  GetTaskRunStatus.succeeded,
  GetTaskRunStatus.failed,
  GetTaskRunStatus.canceled,
};

/// Polls a task run until it finishes.
///
/// Watch the **run's own** status. A run has attempts, and an attempt reaches a
/// terminal state before the run does — polling `attempts[].status` reports a
/// run as finished while it is still going, which is a mistake that looks like
/// it works until a retry happens.
///
/// `package:render_workflows` has `waitFor`, which does this properly and
/// handles timeouts. Prefer it once that package is on pub.dev; this loop
/// exists because a git dependency on it cannot resolve yet.
Future<GetTaskRunResponse> _awaitRun(
  RenderApi render,
  String taskRunId, {
  Duration pollInterval = const Duration(milliseconds: 500),
  Duration timeout = const Duration(minutes: 5),
}) async {
  final deadline = DateTime.now().add(timeout);

  while (true) {
    final run = await render.getTaskRun(taskRunId: taskRunId);
    if (_terminal.contains(run.status)) return run;

    if (DateTime.now().isAfter(deadline)) {
      throw StateError('$taskRunId did not finish within ${timeout.inSeconds}s '
          '(last status: ${run.status.wireValue})');
    }
    await Future<void>.delayed(pollInterval);
  }
}
