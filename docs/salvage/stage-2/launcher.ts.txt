import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  makeEvaluationLauncher,
  type EvaluationHarnessDeployment,
} from '@jinn-network/task-execution-evaluation-harness';
import {
  parseEvaluationSpec,
  type EvaluationSpec,
} from '@jinn-network/task-execution-profiles';
import type { LauncherContract } from '@jinn-network/task-execution-launchers';
import type { TaskView } from '@jinn-network/task-execution-workspace';

/** Resolves to `dist/evaluator/deployment.js` in production and the matching source in dev. */
export const evaluationDeploymentModule = new URL('./deployment.js', import.meta.url).href;

function evaluationSpecFromView(view: TaskView): EvaluationSpec | undefined {
  const inline = view.task.inputs?.find((input) => input.name === 'evaluation-spec.json')?.content;
  if (inline === undefined) return undefined;
  return parseEvaluationSpec(Buffer.from(inline, 'base64'));
}

export function buildEvaluationLauncher(input: {
  readonly deploymentModule: string;
  readonly deployment: EvaluationHarnessDeployment;
}): LauncherContract {
  const { registrations } = input.deployment;
  return makeEvaluationLauncher({
    deploymentModule: input.deploymentModule,
    registrations,
    selectRegistration(view) {
      const specification = evaluationSpecFromView(view);
      if (specification === undefined) {
        throw new TypeError('evaluation launcher requires evaluation-spec.json on the Task view');
      }
      const compatible = registrations.filter((registration) =>
        registration.specificationCompatibility(specification),
      );
      if (compatible.length !== 1) {
        throw new TypeError(
          compatible.length === 0
            ? 'no host evaluator registration supports the EvaluationSpec'
            : 'more than one host evaluator registration supports the EvaluationSpec',
        );
      }
      return compatible[0]!;
    },
  });
}

export async function readEvaluationSpecFromInput(
  inputDir: string,
): Promise<EvaluationSpec> {
  return parseEvaluationSpec(await readFile(join(inputDir, 'evaluation-spec.json')));
}
