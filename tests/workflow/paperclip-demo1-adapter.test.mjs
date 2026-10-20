import assert from "node:assert/strict";
import test from "node:test";

import { loadHumanGateReviewRouting, buildReviewRoutesFromHumanGateConfiguration } from "../../src/workflow/human-gate-review-routing.mjs";
import { buildPaperclipPipelineDryRun } from "../../src/workflow/paperclip-pipeline-adapter.mjs";
import { buildDemo1PaperclipPreparation } from "../../src/workflow/paperclip-demo1-adapter.mjs";
import { loadPaperclipPipelineProjection } from "../../src/workflow/paperclip-pipeline-projection.mjs";

const contractUrl = new URL("../../config/one-qa-agent-v1.workflow-contract.json", import.meta.url);
const routingUrl = new URL("../../config/human-gate-review-routing.json", import.meta.url);
const projection = loadPaperclipPipelineProjection(contractUrl);
const routing = buildReviewRoutesFromHumanGateConfiguration(
  projection,
  loadHumanGateReviewRouting(routingUrl),
);
const dryRun = buildPaperclipPipelineDryRun(projection, { reviewRoutes: routing.reviewRoutes });

test("prepares only DEMO/MOCK pipeline, case, and first-Gate requests", () => {
  const preparation = buildDemo1PaperclipPreparation(projection, dryRun);

  assert.equal(preparation.mode, "OFFLINE_REQUEST_PREPARATION_ONLY");
  assert.equal(preparation.pipeline.create.body, dryRun.candidate.createPipelineRequest);
  assert.equal(preparation.pipeline.replaceTransitions.body, dryRun.candidate.replaceTransitionsRequest);
  assert.equal(preparation.case.create.body.stageKey, "scope");
  assert.equal("requestKey" in preparation.case.create.body, false);
  assert.match(preparation.case.create.body.title, /DEMO\/MOCK/);
  assert.match(preparation.case.create.body.summary, /DEMO\/MOCK/);
  assert.equal(preparation.case.create.body.fields.demo, true);
  assert.equal(preparation.case.create.body.fields.artifacts.qaOverview.label, "DEMO/MOCK");

  assert.deepEqual(
    preparation.transitions.map((step) => [step.fromStageKey, step.bodyTemplate.toStageKey]),
    [
      ["scope", "sources-requirements"],
      ["sources-requirements", "qa-overview"],
      ["qa-overview", "human-gate-1"],
    ],
  );
  assert.ok(preparation.transitions.every((step) => step.bodyTemplate.expectedVersionBinding));
  assert.ok(preparation.transitions.every((step) => !("force" in step.bodyTemplate)));
});

test("prepares a read-only Gate #1 stop verification without approval or Test Design", () => {
  const preparation = buildDemo1PaperclipPreparation(projection, dryRun);

  assert.deepEqual(preparation.gateStopVerification, {
    operation: "LIST_PIPELINE_CASES",
    method: "GET",
    pathTemplate: "/pipelines/:pipelineId/cases",
    query: { stageKey: "human-gate-1" },
    expected: {
      caseKey: "DEMO-MOCK-ONE-QA-001",
      stageKey: "human-gate-1",
      humanGateState: "UNAPPROVED",
      requiresExplicitHumanApproval: true,
    },
  });
  assert.equal(preparation.reviewOperations.length, 0);
  assert.ok(preparation.transitions.every((step) => step.bodyTemplate.toStageKey !== "test-design-testcases"));
});

test("fails closed without a deployable dry-run candidate", () => {
  assert.throws(
    () => buildDemo1PaperclipPreparation(projection, { status: "BLOCKED", candidate: null }),
    /deployable, schema-validated pipeline candidate/i,
  );
});

test("has no network, API, or database side effects", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error("Offline Demo 1 preparation must not call fetch");
  };

  try {
    buildDemo1PaperclipPreparation(projection, dryRun);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
