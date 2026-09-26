/** Printed by the native-evaluator activity rig; LEG 8/9 cite the written deploy-time decision (#3346). */
export const NATIVE_EVALUATOR_ACTIVITY_LEGS: ReadonlyArray<readonly [string, string]> = [
  ['LEG 0  snapshot Anvil + locally-deployed V3 stack', 'PROVEN-hermetic'],
  ['LEG 1  two staked operators (real FleetBootstrapper)', 'PROVEN-hermetic'],
  ['LEG 2  solution leg via the production Daemon (claim -> deliver -> settle)', 'PROVEN-hermetic'],
  ['LEG 3  native evaluator identity stores (openRoleIdentitySet)', 'PROVEN-hermetic'],
  ['LEG 4  committed prediction-evaluator deployment registration, loaded + digest-pinned', 'PROVEN-hermetic'],
  ['LEG 5  real local backend: spawned evaluation-harness child produces the verdict', 'PROVEN-hermetic'],
  ['LEG 5b signed-source publisher announces the six evaluation records', 'PROVEN-hermetic'],
  ['LEG 5c NativeEvaluatorCoordinator + EvaluatorLoop settlement state machine', 'PROVEN-hermetic'],
  ['LEG 6  real VerdictPorts: claimEvaluation -> deliver -> claimVerdictDelivery', 'PROVEN-hermetic'],
  ['LEG 7  eligibleActivityWeight credit for solver + evaluator Safes', 'PROVEN-hermetic'],
  [
    'LEG 8  signed .well-known record-source ingestion (opportunity discovery)',
    'SEEDED (deploy-time; spec/2026-09-26-native-evaluator-ingestion-legs-deploy-time.md)',
  ],
  [
    'LEG 9  DSSE subject-authority + verdict gate over a live trust catalog',
    'SEEDED (deploy-time; spec/2026-09-26-native-evaluator-ingestion-legs-deploy-time.md)',
  ],
  ['LEG 10 container-graded evaluation (swe-rebench-v2)', 'DEPLOY-TIME (Docker; DR decision 3a)'],
];
