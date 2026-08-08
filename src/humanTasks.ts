import * as vscode from 'vscode';
import * as path from 'node:path';

const TASK_TYPE = 'labviewBenchmarkActor';
const TASKS = [
  ['agent-preflight', 'LBA: Agent Preflight'],
  ['governance-review', 'LBA: Governance Review'],
  ['reviewer-readiness', 'LBA: Reviewer Mesh Readiness (compound)'],
  ['release-candidate', 'LBA: Release Candidate Check (compound)'],
] as const;

function taskFor(context: vscode.ExtensionContext, id: string, name: string): vscode.Task {
  const runner = path.join(context.extensionUri.fsPath, 'media', 'human-task-runner.mjs');
  const execution = new vscode.ProcessExecution(process.execPath, [runner, id], {
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  return new vscode.Task(
    { type: TASK_TYPE, task: id },
    vscode.TaskScope.Workspace,
    name,
    'LabVIEW Benchmark Actor',
    execution,
  );
}

export function registerHumanTasks(context: vscode.ExtensionContext): vscode.Disposable {
  if (!vscode.tasks?.registerTaskProvider) return { dispose() {} };
  return vscode.tasks.registerTaskProvider(TASK_TYPE, {
    provideTasks: () => TASKS.map(([id, name]) => taskFor(context, id, name)),
    resolveTask: (task) => {
      const id = String(task.definition.task ?? '');
      const match = TASKS.find(([candidate]) => candidate === id);
      return match ? taskFor(context, match[0], match[1]) : undefined;
    },
  });
}
