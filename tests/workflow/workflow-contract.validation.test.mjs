import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateWorkflowContract } from '../../src/workflow/validate-workflow-contract.mjs';

const contract = JSON.parse(
  readFileSync(new URL('../../config/one-qa-agent-v1.workflow-contract.json', import.meta.url), 'utf8')
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function errorsFor(value) {
  return validateWorkflowContract(value).map((error) => error.code);
}

assert.deepEqual(errorsFor(contract), []);
assert.equal(contract.stages.length, 18);
assert.equal(contract.transitions.length, 20);

const forwardEdges = contract.transitions.filter((transition) => transition.kind !== 'reject-revision');
const rejectRevisionEdges = contract.transitions.filter((transition) => transition.kind === 'reject-revision');
assert.equal(forwardEdges.length, 17);
assert.deepEqual(
  rejectRevisionEdges.map(({ from, to }) => [from, to]),
  [
    ['human-gate-1', 'qa-overview'],
    ['human-gate-2-automation-candidate', 'triage'],
    ['human-gate-3', 'automation-triage']
  ]
);

const duplicateId = clone(contract);
duplicateId.stages[1].id = duplicateId.stages[0].id;
assert.ok(errorsFor(duplicateId).includes('DUPLICATE_STAGE_ID'));

const reordered = clone(contract);
[reordered.stages[0], reordered.stages[1]] = [reordered.stages[1], reordered.stages[0]];
assert.ok(errorsFor(reordered).includes('FROZEN_STAGE_ORDER_MISMATCH'));

const gateBypass = clone(contract);
gateBypass.transitions = gateBypass.transitions.filter(
  (transition) => transition.from !== 'human-gate-1'
);
gateBypass.transitions.push({
  from: 'qa-overview',
  to: 'test-design-testcases',
  condition: 'always'
});
assert.ok(errorsFor(gateBypass).includes('NON_ADJACENT_TRANSITION'));

const unapprovedReverse = clone(contract);
unapprovedReverse.transitions.push({
  from: 'human-gate-1',
  to: 'scope',
  kind: 'reject-revision',
  condition: 'unapproved'
});
assert.ok(errorsFor(unapprovedReverse).includes('UNAPPROVED_REJECT_REVISION_EDGE'));

const assumedPaperclip = clone(contract);
assumedPaperclip.integration.paperclip.stageMapping[0].verificationStatus = 'VERIFIED';
assert.ok(errorsFor(assumedPaperclip).includes('UNVERIFIED_INTEGRATION_CLAIM'));

console.log('Workflow contract static tests passed.');
