import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadPaperclipPipelineProjection } from "../../src/workflow/paperclip-pipeline-projection.mjs";
import {
  buildReviewRoutesFromHumanGateConfiguration,
  loadHumanGateReviewRouting,
} from "../../src/workflow/human-gate-review-routing.mjs";
import {
  buildPaperclipPipelineDryRun,
  validatePaperclipPipelineDryRun,
} from "../../src/workflow/paperclip-pipeline-adapter.mjs";

const contractUrl = new URL("../../config/one-qa-agent-v1.workflow-contract.json", import.meta.url);
const routingUrl = new URL("../../config/human-gate-review-routing.json", import.meta.url);
const projection = loadPaperclipPipelineProjection(contractUrl);
const routing = loadHumanGateReviewRouting(routingUrl);
const frozenContract = JSON.parse(readFileSync(contractUrl, "utf8"));

test("declares a separate human-only policy for all three frozen Human Gates", () => {
  const result = buildReviewRoutesFromHumanGateConfiguration(projection, routing);

  assert.equal(result.status, "ROUTING_VALIDATION_REQUIRED");
  assert.equal(routing.gates.length, 3);
  assert.deepEqual(
    routing.gates.map((gate) => gate.stageId),
    frozenContract.stages.filter((stage) => stage.humanGate).map((stage) => stage.id),
  );
  assert.ok(routing.gates.every((gate) => gate.requireApproval === true));
  assert.ok(routing.gates.every((gate) => gate.approver.kind === "any_human"));
});

test("resolves Reject and Request changes to the same approved revision destinations", () => {
  const result = buildReviewRoutesFromHumanGateConfiguration(projection, routing);

  assert.equal(result.status, "ROUTING_VALIDATION_REQUIRED");
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.rejectRoutes, {
    "human-gate-1": "qa-overview",
    "human-gate-2-automation-candidate": "triage",
    "human-gate-3": "automation-triage",
  });
  assert.deepEqual(result.reviewRoutes, {
    "human-gate-1": { rejectToStageKey: "qa-overview", requestChangesToStageKey: "qa-overview" },
    "human-gate-2-automation-candidate": { rejectToStageKey: "triage", requestChangesToStageKey: "triage" },
    "human-gate-3": { rejectToStageKey: "automation-triage", requestChangesToStageKey: "automation-triage" },
  });
});

test("fails closed when a required Human Gate route is missing", () => {
  const missingGate = structuredClone(routing);
  missingGate.gates = missingGate.gates.slice(1);

  const result = buildReviewRoutesFromHumanGateConfiguration(projection, missingGate);

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reviewRoutes, null);
  assert.ok(result.blockers.some((blocker) => blocker.code === "HUMAN_GATE_ROUTE_MISSING"));
});

test("constructs a schema-valid deployable payload only after all approved routes are resolved", async () => {
  const routes = buildReviewRoutesFromHumanGateConfiguration(projection, routing);
  const dryRun = buildPaperclipPipelineDryRun(projection, { reviewRoutes: routes.reviewRoutes });

  assert.equal(dryRun.status, "DRY_RUN_VALIDATION_REQUIRED");
  assert.equal(dryRun.candidate.createPipelineRequest.stages.length, 19);
  assert.equal(dryRun.candidate.replaceTransitionsRequest.transitions.length, 20);
  for (const stage of dryRun.candidate.createPipelineRequest.stages.filter((stage) => stage.kind === "review")) {
    assert.equal(stage.config.requireApproval, true);
    assert.deepEqual(stage.config.approver, { kind: "any_human" });
    assert.equal(stage.config.rejectToStageKey, stage.config.requestChangesToStageKey);
  }
  assert.equal((await validatePaperclipPipelineDryRun(dryRun)).valid, true);
});

test("does not perform network, API, or database side effects", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error("Review routing validation must not call fetch");
  };

  try {
    const result = buildReviewRoutesFromHumanGateConfiguration(projection, routing);

    assert.equal(result.status, "ROUTING_VALIDATION_REQUIRED");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects configuration that attempts to bypass a frozen Human Gate", () => {
  const bypass = structuredClone(routing);
  bypass.gates[0].approveToStageKey = "manual-preflight";

  assert.throws(
    () => buildReviewRoutesFromHumanGateConfiguration(projection, bypass),
    /must approve only to the adjacent frozen stage/,
  );
});

test("rejects any resolved Reject target other than the approved revision stage", () => {
  const invalidReject = structuredClone(routing);
  invalidReject.gates[0].reject.toStageKey = "scope";

  assert.throws(
    () => buildReviewRoutesFromHumanGateConfiguration(projection, invalidReject),
    /must use approved reject revision stage qa-overview/,
  );
});

test("rejects any resolved Request changes target other than the approved revision stage", () => {
  const invalidRequestChanges = structuredClone(routing);
  invalidRequestChanges.gates[0].requestChanges.toStageKey = "scope";

  assert.throws(
    () => buildReviewRoutesFromHumanGateConfiguration(projection, invalidRequestChanges),
    /requestChanges routing must use approved reject revision stage qa-overview/,
  );
});
