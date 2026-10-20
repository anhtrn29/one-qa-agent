import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadPaperclipPipelineProjection } from "../../src/workflow/paperclip-pipeline-projection.mjs";
import {
  buildPaperclipPipelineDryRun,
  validatePaperclipPipelineDryRun,
} from "../../src/workflow/paperclip-pipeline-adapter.mjs";

const contractUrl = new URL("../../config/one-qa-agent-v1.workflow-contract.json", import.meta.url);
const projection = loadPaperclipPipelineProjection(contractUrl);
const contract = JSON.parse(readFileSync(contractUrl, "utf8"));

function explicitReviewRoutes() {
  return Object.fromEntries(
    projection.stages
      .filter((stage) => stage.humanGate !== null)
      .map((stage) => [stage.contractStageId, {
        // Both revision decisions share the approved reject-revision edge.
        rejectToStageKey: projection.transitions.find((transition) => (
          transition.fromStageKey === stage.contractStageId && transition.kind === "reject-revision"
        )).toStageKey,
        requestChangesToStageKey: projection.transitions.find((transition) => (
          transition.fromStageKey === stage.contractStageId && transition.kind === "reject-revision"
        )).toStageKey,
      }]),
  );
}

test("fails closed when review destinations have not been explicitly supplied", () => {
  const dryRun = buildPaperclipPipelineDryRun(projection);

  assert.equal(dryRun.status, "BLOCKED");
  assert.equal(dryRun.candidate, null);
  assert.match(dryRun.blockers[0].code, /HUMAN_GATE_REVIEW_POLICY_REQUIRED/);
});

test("maps the valid frozen projection into schema-valid dry-run requests", async () => {
  const dryRun = buildPaperclipPipelineDryRun(projection, {
    reviewRoutes: explicitReviewRoutes(),
  });

  assert.equal(dryRun.status, "DRY_RUN_VALIDATION_REQUIRED");
  assert.equal(dryRun.candidate.createPipelineRequest.stages.length, 19);
  assert.equal(dryRun.candidate.replaceTransitionsRequest.transitions.length, 20);
  assert.deepEqual(
    dryRun.candidate.createPipelineRequest.stages.slice(0, 18).map((stage) => stage.key),
    contract.stages.map((stage) => stage.id),
  );

  const validation = await validatePaperclipPipelineDryRun(dryRun);
  assert.equal(validation.valid, true);
});

test("configures each Human Gate as a human-only review with the frozen approved transition", () => {
  const dryRun = buildPaperclipPipelineDryRun(projection, {
    reviewRoutes: explicitReviewRoutes(),
  });
  const stages = dryRun.candidate.createPipelineRequest.stages;

  for (const stage of stages.filter((item) => item.kind === "review")) {
    const transition = dryRun.candidate.replaceTransitionsRequest.transitions
      .find((item) => item.fromStageKey === stage.key);

    assert.equal(stage.config.requireApproval, true);
    assert.deepEqual(stage.config.approver, { kind: "any_human" });
    assert.equal(stage.config.approveToStageKey, transition.toStageKey);
    assert.equal(stage.config.rejectToStageKey, stage.config.requestChangesToStageKey);
  }
});

test("rejects invalid Paperclip stage kinds and positions", async () => {
  const dryRun = buildPaperclipPipelineDryRun(projection, {
    reviewRoutes: explicitReviewRoutes(),
  });
  dryRun.candidate.createPipelineRequest.stages[0].kind = "invalid-kind";
  dryRun.candidate.createPipelineRequest.stages[1].position = 1.5;

  const validation = await validatePaperclipPipelineDryRun(dryRun);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((message) => message.includes("kind")));
  assert.ok(validation.errors.some((message) => message.includes("position")));
});

test("validates review config against the installed Paperclip config schema", async () => {
  const dryRun = buildPaperclipPipelineDryRun(projection, {
    reviewRoutes: explicitReviewRoutes(),
  });
  dryRun.candidate.createPipelineRequest.stages.find((stage) => stage.kind === "review")
    .config.approver = { kind: "user" };

  const validation = await validatePaperclipPipelineDryRun(dryRun);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((message) => message.includes("Specific stage approvers require an id")));
});

test("rejects any attempt to bypass a Human Gate", () => {
  const reviewRoutes = explicitReviewRoutes();
  reviewRoutes["human-gate-1"].approveToStageKey = "manual-preflight";

  assert.throws(
    () => buildPaperclipPipelineDryRun(projection, { reviewRoutes }),
    /must approve only to the adjacent frozen stage/,
  );
});

test("does not perform network, API, or database side effects", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error("Dry-run adapter must not call fetch");
  };

  try {
    const dryRun = buildPaperclipPipelineDryRun(projection, {
      reviewRoutes: explicitReviewRoutes(),
    });
    const validation = await validatePaperclipPipelineDryRun(dryRun);

    assert.equal(validation.valid, true);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
