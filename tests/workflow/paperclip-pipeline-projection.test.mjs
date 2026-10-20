import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FROZEN_STAGE_IDS } from "../../src/workflow/validate-workflow-contract.mjs";
import {
  buildPaperclipPipelineProjection,
  loadPaperclipPipelineProjection,
} from "../../src/workflow/paperclip-pipeline-projection.mjs";

const contractPath = new URL("../../config/one-qa-agent-v1.workflow-contract.json", import.meta.url);
const contract = JSON.parse(readFileSync(contractPath, "utf8"));

test("projects the frozen contract without changing its stages or order", () => {
  const projection = buildPaperclipPipelineProjection(contract);

  assert.equal(projection.pipeline.enforceTransitions, true);
  assert.equal(projection.stages.length, 18);
  assert.deepEqual(projection.stages.map((stage) => stage.contractStageId), FROZEN_STAGE_IDS);
  assert.equal(new Set(projection.stages.map((stage) => stage.contractStageId)).size, 18);
});

test("derives 17 frozen forward transitions and only the three approved reject revision edges", () => {
  const projection = buildPaperclipPipelineProjection(contract);
  const stageIds = projection.stages.map((stage) => stage.contractStageId);
  const forwardTransitions = projection.transitions.filter((transition) => transition.kind !== "reject-revision");
  const revisionTransitions = projection.transitions.filter((transition) => transition.kind === "reject-revision");

  assert.equal(projection.transitions.length, 20);
  assert.equal(forwardTransitions.length, 17);
  assert.equal(revisionTransitions.length, 3);
  forwardTransitions.forEach((transition, index) => {
    assert.equal(transition.fromStageKey, stageIds[index]);
    assert.equal(transition.toStageKey, stageIds[index + 1]);
  });
  assert.deepEqual(
    revisionTransitions.map((transition) => [transition.fromStageKey, transition.toStageKey]),
    [
      ["human-gate-1", "qa-overview"],
      ["human-gate-2-automation-candidate", "triage"],
      ["human-gate-3", "automation-triage"],
    ],
  );
});

test("preserves all human gates as unapproved and requires approval for the next stage", () => {
  const projection = buildPaperclipPipelineProjection(contract);
  const gates = projection.stages
    .filter((stage) => stage.humanGate !== null)
    .map((stage) => stage.humanGate);

  assert.deepEqual(gates.map((gate) => gate.number), [1, 2, 3]);
  assert.deepEqual(gates.map((gate) => gate.defaultState), ["UNAPPROVED", "UNAPPROVED", "UNAPPROVED"]);
  assert.ok(gates.every((gate) => gate.requiredForNextStage === "APPROVED"));
});

test("rejects an invalid contract before making a projection", () => {
  const invalidContract = structuredClone(contract);
  invalidContract.stages[1].id = invalidContract.stages[0].id;

  assert.throws(
    () => buildPaperclipPipelineProjection(invalidContract),
    /Cannot project an invalid workflow contract/,
  );
});

test("is deterministic and does not invoke Paperclip or runtime APIs", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error("The projection must not perform network I/O");
  };

  try {
    const firstProjection = buildPaperclipPipelineProjection(contract);
    const secondProjection = loadPaperclipPipelineProjection(contractPath);

    assert.deepEqual(firstProjection, secondProjection);
    assert.equal(fetchCalls, 0);
    assert.equal(firstProjection.paperclip.apiPayloadGenerated, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
