import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FROZEN_STAGE_IDS = [
  'scope', 'sources-requirements', 'qa-overview', 'human-gate-1',
  'test-design-testcases', 'manual-preflight', 'manual-execution',
  'evidence-tc-result', 'triage', 'human-gate-2-automation-candidate',
  'command-code-playwright', 'automation-review', 'playwright-run',
  'automation-evidence', 'automation-triage', 'human-gate-3',
  'final-report', 'done'
];

const GATES = [
  ['human-gate-1', 1],
  ['human-gate-2-automation-candidate', 2],
  ['human-gate-3', 3]
];

export const APPROVED_REJECT_REVISION_EDGES = [
  ['human-gate-1', 'qa-overview'],
  ['human-gate-2-automation-candidate', 'triage'],
  ['human-gate-3', 'automation-triage']
];

function error(code, message) {
  return { code, message };
}

export function validateWorkflowContract(contract) {
  const errors = [];
  const stages = Array.isArray(contract?.stages) ? contract.stages : [];
  const ids = stages.map((stage) => stage.id);

  if (ids.length !== FROZEN_STAGE_IDS.length) {
    errors.push(error('STAGE_COUNT_MISMATCH', `Expected ${FROZEN_STAGE_IDS.length} stages, received ${ids.length}.`));
  }
  if (new Set(ids).size !== ids.length) {
    errors.push(error('DUPLICATE_STAGE_ID', 'Stage IDs must be unique.'));
  }
  if (JSON.stringify(ids) !== JSON.stringify(FROZEN_STAGE_IDS)) {
    errors.push(error('FROZEN_STAGE_ORDER_MISMATCH', 'Stage IDs must match the frozen workflow order exactly.'));
  }

  for (const [stageId, gateNumber] of GATES) {
    const stage = stages.find((item) => item.id === stageId);
    if (stage?.humanGate?.number !== gateNumber ||
        stage?.humanGate?.defaultState !== 'UNAPPROVED' ||
        stage?.humanGate?.requiredForNextStage !== 'APPROVED') {
      errors.push(error('INVALID_HUMAN_GATE_POLICY', `${stageId} must require explicit APPROVED human approval.`));
    }
    if (contract?.humanGateStates?.[stageId] !== 'UNAPPROVED') {
      errors.push(error('INVALID_INITIAL_GATE_STATE', `${stageId} must initialize as UNAPPROVED.`));
    }
  }

  const transitions = Array.isArray(contract?.transitions) ? contract.transitions : [];
  if (transitions.length !== FROZEN_STAGE_IDS.length - 1 + APPROVED_REJECT_REVISION_EDGES.length) {
    errors.push(error('TRANSITION_COUNT_MISMATCH', 'Exactly 17 forward transitions and 3 approved reject revision transitions are required.'));
  }
  for (const transition of transitions) {
    const fromIndex = FROZEN_STAGE_IDS.indexOf(transition.from);
    const toIndex = FROZEN_STAGE_IDS.indexOf(transition.to);
    const isForward = fromIndex >= 0 && toIndex === fromIndex + 1;
    const isApprovedRejectRevision = APPROVED_REJECT_REVISION_EDGES.some(
      ([from, to]) => transition.from === from && transition.to === to,
    );
    if (isForward) {
      if (transition.kind !== undefined) {
        errors.push(error('INVALID_FORWARD_TRANSITION', `${transition.from} -> ${transition.to} must remain a frozen forward transition.`));
      }
    } else if (isApprovedRejectRevision) {
      if (transition.kind !== 'reject-revision') {
        errors.push(error('INVALID_REJECT_REVISION_EDGE', `${transition.from} -> ${transition.to} must be identified as reject-revision.`));
      }
    } else {
      errors.push(error(
        transition.kind === 'reject-revision' ? 'UNAPPROVED_REJECT_REVISION_EDGE' : 'NON_ADJACENT_TRANSITION',
        `${transition.from} -> ${transition.to} is not an approved workflow transition.`,
      ));
    }
  }
  for (let index = 0; index < FROZEN_STAGE_IDS.length - 1; index += 1) {
    const from = FROZEN_STAGE_IDS[index];
    const to = FROZEN_STAGE_IDS[index + 1];
    if (!transitions.some((transition) => transition.from === from && transition.to === to)) {
      errors.push(error('MISSING_REQUIRED_TRANSITION', `Missing frozen transition ${from} -> ${to}.`));
    }
  }
  for (const [from, to] of APPROVED_REJECT_REVISION_EDGES) {
    if (!transitions.some((transition) => transition.from === from && transition.to === to && transition.kind === 'reject-revision')) {
      errors.push(error('MISSING_APPROVED_REJECT_REVISION_EDGE', `Missing approved reject revision transition ${from} -> ${to}.`));
    }
  }

  const mappings = contract?.integration?.paperclip?.stageMapping ?? [];
  if (contract?.integration?.paperclip?.verificationStatus !== 'UNKNOWN' ||
      mappings.some((mapping) => mapping.verificationStatus !== 'UNKNOWN')) {
    errors.push(error('UNVERIFIED_INTEGRATION_CLAIM', 'Paperclip mappings must remain UNKNOWN until verified.'));
  }
  if (contract?.integration?.hermes?.verificationStatus !== 'UNKNOWN') {
    errors.push(error('UNVERIFIED_INTEGRATION_CLAIM', 'Hermes integration must remain UNKNOWN until verified.'));
  }
  return errors;
}

function run() {
  const contractPath = fileURLToPath(new URL('../../config/one-qa-agent-v1.workflow-contract.json', import.meta.url));
  const errors = validateWorkflowContract(JSON.parse(readFileSync(contractPath, 'utf8')));
  if (errors.length) {
    for (const item of errors) console.error(`[${item.code}] ${item.message}`);
    process.exitCode = 1;
    return;
  }
  console.log('Workflow contract is valid: 18 frozen stages, 17 forward transitions, 3 approved reject revision transitions, 3 human gates.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();
