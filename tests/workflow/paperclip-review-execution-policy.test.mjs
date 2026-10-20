import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadPaperclipPipelineProjection } from "../../src/workflow/paperclip-pipeline-projection.mjs";
import {
  buildOneQaReviewOperation,
  assertOneQaGenericTransitionAllowed,
} from "../../src/workflow/paperclip-review-execution-policy.mjs";

const contractUrl = new URL("../../config/one-qa-agent-v1.workflow-contract.json", import.meta.url);
const projection = loadPaperclipPipelineProjection(contractUrl);
const contract = JSON.parse(readFileSync(contractUrl, "utf8"));

test("requires a human Paperclip review operation for each approved Human Gate exit", () => {
  for (const stage of contract.stages.filter((item) => item.humanGate)) {
    const operation = buildOneQaReviewOperation(projection, {
      stageId: stage.id,
      decision: "approve",
      actorType: "human",
    });

    assert.equal(operation.operation, "PAPERCLIP_REVIEW");
    assert.equal(operation.decision, "approve");
    assert.equal(operation.toStageKey, projection.transitions.find((edge) => (
      edge.fromStageKey === stage.id && edge.kind !== "reject-revision"
    )).toStageKey);
  }
});

test("reject and request changes use distinct decisions on the same approved revision target", () => {
  const reject = buildOneQaReviewOperation(projection, {
    stageId: "human-gate-1",
    decision: "reject",
    actorType: "human",
  });
  const requestChanges = buildOneQaReviewOperation(projection, {
    stageId: "human-gate-1",
    decision: "request_changes",
    reason: "Revise the QA Overview evidence.",
    actorType: "human",
  });

  assert.equal(reject.decision, "reject");
  assert.equal(requestChanges.decision, "request_changes");
  assert.equal(reject.toStageKey, "qa-overview");
  assert.equal(requestChanges.toStageKey, "qa-overview");
  assert.notEqual(reject.decision, "approve");
  assert.notEqual(requestChanges.decision, "approve");
});

test("rejects agents, generic Gate exits, request changes, and reused approval evidence", () => {
  assert.throws(
    () => buildOneQaReviewOperation(projection, {
      stageId: "human-gate-1", decision: "approve", actorType: "agent",
    }),
    /human actor/,
  );
  assert.throws(
    () => assertOneQaGenericTransitionAllowed(projection, {
      fromStageKey: "human-gate-1", toStageKey: "test-design-testcases", force: true,
    }),
    /must use a Paperclip review operation/,
  );
  assert.throws(
    () => buildOneQaReviewOperation(projection, {
      stageId: "human-gate-1", decision: "request_changes", actorType: "human", reason: " ",
    }),
    /non-empty reason/,
  );
  assert.throws(
    () => buildOneQaReviewOperation(projection, {
      stageId: "human-gate-1", decision: "approve", actorType: "human", priorApprovalEventId: "old-event",
    }),
    /fresh review decision/,
  );
});
