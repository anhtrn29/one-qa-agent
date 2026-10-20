import assert from "node:assert/strict";
import test from "node:test";

import {
  PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY,
  applyPaperclipCancelledStageCompatibility,
} from "../../src/workflow/paperclip-cancelled-stage-compatibility.mjs";
import { loadHumanGateReviewRouting, buildReviewRoutesFromHumanGateConfiguration } from "../../src/workflow/human-gate-review-routing.mjs";
import { buildPaperclipPipelineDryRun } from "../../src/workflow/paperclip-pipeline-adapter.mjs";
import { loadPaperclipPipelineProjection } from "../../src/workflow/paperclip-pipeline-projection.mjs";

const projection = loadPaperclipPipelineProjection(new URL("../../config/one-qa-agent-v1.workflow-contract.json", import.meta.url));
const routing = buildReviewRoutesFromHumanGateConfiguration(
  projection,
  loadHumanGateReviewRouting(new URL("../../config/human-gate-review-routing.json", import.meta.url)),
);

function businessOnlyCandidate() {
  return {
    createPipelineRequest: {
      key: "demo",
      name: "demo",
      enforceTransitions: true,
      stages: projection.stages.map((stage) => ({
        key: stage.contractStageId,
        name: stage.name,
        kind: stage.contractStageId === "done" ? "done" : stage.humanGate ? "review" : "working",
        position: (stage.contractOrder + 1) * 100,
        ...(stage.humanGate ? { config: { requireApproval: true, approver: { kind: "any_human" } } } : {}),
      })),
    },
    replaceTransitionsRequest: {
      enforceTransitions: true,
      transitions: projection.transitions.map((edge) => ({ fromStageKey: edge.fromStageKey, toStageKey: edge.toStageKey, label: null })),
    },
  };
}

test("adds exactly one isolated Paperclip-only cancelled stage without changing business stages or edges", () => {
  const business = businessOnlyCandidate();
  const compatible = applyPaperclipCancelledStageCompatibility(business);

  assert.equal(business.createPipelineRequest.stages.length, 18);
  assert.equal(business.replaceTransitionsRequest.transitions.length, 20);
  assert.equal(compatible.createPipelineRequest.stages.length, 19);
  assert.deepEqual(
    compatible.createPipelineRequest.stages.slice(0, 18),
    business.createPipelineRequest.stages,
  );
  const technical = compatible.createPipelineRequest.stages.at(-1);
  assert.deepEqual(technical, {
    key: PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY,
    name: "Paperclip Compatibility Cancelled (Technical Only)",
    kind: "cancelled",
    position: 1900,
  });
  assert.equal(compatible.replaceTransitionsRequest.transitions.length, 20);
  assert.ok(compatible.replaceTransitionsRequest.transitions.every((edge) => (
    edge.fromStageKey !== technical.key && edge.toStageKey !== technical.key
  )));
});

test("is deterministic and idempotent without duplicating the technical stage", () => {
  const once = applyPaperclipCancelledStageCompatibility(businessOnlyCandidate());
  const twice = applyPaperclipCancelledStageCompatibility(once);

  assert.deepEqual(twice, once);
  assert.equal(twice.createPipelineRequest.stages.filter((stage) => stage.key === PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY).length, 1);
});

test("rejects a technical-stage transition or review destination", () => {
  const edgeCandidate = businessOnlyCandidate();
  edgeCandidate.replaceTransitionsRequest.transitions[0].toStageKey = PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY;
  assert.throws(() => applyPaperclipCancelledStageCompatibility(edgeCandidate), /technical cancelled stage/i);

  const reviewCandidate = businessOnlyCandidate();
  reviewCandidate.createPipelineRequest.stages.find((stage) => stage.key === "human-gate-1")
    .config.rejectToStageKey = PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY;
  assert.throws(() => applyPaperclipCancelledStageCompatibility(reviewCandidate), /technical cancelled stage/i);
});

test("rejects replacing the frozen business Done stage with cancelled semantics", () => {
  const candidate = businessOnlyCandidate();
  candidate.createPipelineRequest.stages.find((stage) => stage.key === "done").kind = "cancelled";

  assert.throws(() => applyPaperclipCancelledStageCompatibility(candidate), /business Done stage/i);
});

test("dry-run candidate uses the compatibility stage while business projection stays at 18 stages", () => {
  const dryRun = buildPaperclipPipelineDryRun(projection, { reviewRoutes: routing.reviewRoutes });
  const stages = dryRun.candidate.createPipelineRequest.stages;

  assert.equal(projection.stages.length, 18);
  assert.equal(stages.length, 19);
  assert.equal(stages.filter((stage) => stage.kind === "done").length, 1);
  assert.equal(stages.filter((stage) => stage.kind === "cancelled").length, 1);
  assert.equal(stages.at(-1).key, PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY);
  assert.equal(dryRun.candidate.replaceTransitionsRequest.transitions.length, 20);
  for (const stage of stages.filter((stage) => stage.kind === "review")) {
    assert.notEqual(stage.config.approveToStageKey, PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY);
    assert.notEqual(stage.config.rejectToStageKey, PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY);
    assert.notEqual(stage.config.requestChangesToStageKey, PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY);
  }
});
