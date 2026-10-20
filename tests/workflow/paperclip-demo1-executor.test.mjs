import assert from "node:assert/strict";
import test from "node:test";

import { loadHumanGateReviewRouting, buildReviewRoutesFromHumanGateConfiguration } from "../../src/workflow/human-gate-review-routing.mjs";
import { buildPaperclipPipelineDryRun } from "../../src/workflow/paperclip-pipeline-adapter.mjs";
import { buildDemo1PaperclipPreparation } from "../../src/workflow/paperclip-demo1-adapter.mjs";
import { executeDemo1PreparedRequests } from "../../src/workflow/paperclip-demo1-executor.mjs";
import { loadPaperclipPipelineProjection } from "../../src/workflow/paperclip-pipeline-projection.mjs";

const projection = loadPaperclipPipelineProjection(new URL("../../config/one-qa-agent-v1.workflow-contract.json", import.meta.url));
const routing = buildReviewRoutesFromHumanGateConfiguration(
  projection,
  loadHumanGateReviewRouting(new URL("../../config/human-gate-review-routing.json", import.meta.url)),
);
const preparation = buildDemo1PaperclipPreparation(
  projection,
  buildPaperclipPipelineDryRun(projection, { reviewRoutes: routing.reviewRoutes }),
);

function runtime(overrides = {}) {
  return {
    endpoint: "https://paperclip-demo.invalid",
    isolatedEnvironment: true,
    companyId: "demo-company",
    projectId: "demo-project",
    authorizationHeader: "Bearer mock-secret",
    explicitDemoExecutionAuthorization: true,
    ...overrides,
  };
}

function localTrustedRuntime(overrides = {}) {
  return {
    endpoint: "http://127.0.0.1:4310",
    isolatedEnvironment: true,
    companyId: "demo-company",
    explicitDemoExecutionAuthorization: true,
    authenticationMode: "local_trusted",
    isolationEvidence: {
      dedicatedDataDirectoryIdentity: "one-qa-demo1-fresh-instance",
      observedDataDirectoryIdentity: "one-qa-demo1-fresh-instance",
      expectedInstanceConfiguration: {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        bind: "loopback",
      },
      observedInstanceConfiguration: {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        bind: "loopback",
      },
    },
    ...overrides,
  };
}

function mockTransport({ mutate } = {}) {
  const calls = [];
  const stageByKey = new Map(preparation.pipeline.create.body.stages.map((stage, index) => [stage.key, {
    id: `stage-${index + 1}`,
    key: stage.key,
    kind: stage.kind,
    config: stage.config ?? {},
  }]));
  let current = { id: "case-1", caseKey: "DEMO-MOCK-ONE-QA-001", stageId: stageByKey.get("scope").id, version: 1, terminalKind: null };
  const transport = async (request) => {
    calls.push(request);
    const response = (() => {
      if (request.path.endsWith("/pipelines")) return { status: 201, body: { id: "pipeline-1", stages: [...stageByKey.values()] } };
      if (request.path.endsWith("/transitions")) return { status: 200, body: { transitions: Array.from({ length: 20 }, (_, index) => ({ id: `edge-${index}` })) } };
      if (request.method === "GET") return { status: 200, body: [{ case: current, stage: stageByKey.get("human-gate-1") }] };
      if (request.path.endsWith("/cases")) return { status: 201, body: { case: current, created: true } };
      if (request.path.endsWith("/transition")) {
        const stage = stageByKey.get(request.body.toStageKey);
        current = { ...current, stageId: stage.id, version: current.version + 1 };
        return { status: 200, body: { case: current, event: { id: `event-${current.version}` } } };
      }
      throw new Error(`Unexpected mock request ${request.method} ${request.path}`);
    })();
    return mutate ? mutate(response, request, calls.length) : response;
  };
  return { calls, transport };
}

test("executes the prepared Demo 1 path with mocked transport and stops unapproved at Gate #1", async () => {
  const mock = mockTransport();
  const report = await executeDemo1PreparedRequests(projection, preparation, runtime(), mock.transport);

  assert.equal(report.status, "STOPPED_AT_HUMAN_GATE_1");
  assert.equal(report.gate.awaitingHumanApproval, true);
  assert.equal(report.gate.stageKey, "human-gate-1");
  assert.deepEqual(mock.calls.filter((call) => call.path.endsWith("/transition")).map((call) => call.body.toStageKey), [
    "sources-requirements", "qa-overview", "human-gate-1",
  ]);
  assert.ok(mock.calls.every((call) => !("force" in (call.body ?? {}))));
  assert.ok(mock.calls.every((call) => !call.path.endsWith("/review")));
  assert.ok(mock.calls.every((call) => call.headers.authorization === "Bearer mock-secret"));
});

test("blocks missing authorization before any request", async () => {
  const mock = mockTransport();
  await assert.rejects(
    () => executeDemo1PreparedRequests(projection, preparation, runtime({ authorizationHeader: "" }), mock.transport),
    /authorization/i,
  );
  assert.equal(mock.calls.length, 0);
});

test("blocks a non-isolated environment before any request", async () => {
  const mock = mockTransport();
  await assert.rejects(
    () => executeDemo1PreparedRequests(projection, preparation, runtime({ isolatedEnvironment: false }), mock.transport),
    /isolated/i,
  );
  assert.equal(mock.calls.length, 0);
});

test("blocks missing endpoint, company, or explicit execution authorization", async () => {
  for (const overrides of [
    { endpoint: "" },
    { companyId: "" },
    { explicitDemoExecutionAuthorization: false },
  ]) {
    const mock = mockTransport();
    await assert.rejects(() => executeDemo1PreparedRequests(projection, preparation, runtime(overrides), mock.transport));
    assert.equal(mock.calls.length, 0);
  }
});

test("accepts no projectId because Paperclip pipeline creation makes it optional", async () => {
  const mock = mockTransport();
  await executeDemo1PreparedRequests(projection, preparation, runtime({ projectId: "" }), mock.transport);
  assert.equal(mock.calls[0].body.projectId, undefined);
});

test("uses explicitly selected local_trusted mode without an Authorization header", async () => {
  const mock = mockTransport();
  await executeDemo1PreparedRequests(projection, preparation, localTrustedRuntime(), mock.transport);
  assert.ok(mock.calls.length > 0);
  assert.ok(mock.calls.every((call) => !("authorization" in call.headers)));
  assert.ok(mock.calls.every((call) => call.url.startsWith("http://127.0.0.1:4310/")));
});

test("local_trusted fails closed without independently comparable isolation evidence", async () => {
  for (const overrides of [
    { isolationEvidence: undefined },
    { isolationEvidence: { dedicatedDataDirectoryIdentity: "one-qa-demo1-fresh-instance" } },
    { isolatedEnvironment: true, isolationEvidence: undefined },
  ]) {
    const mock = mockTransport();
    await assert.rejects(() => executeDemo1PreparedRequests(projection, preparation, localTrustedRuntime(overrides), mock.transport), /isolation evidence/i);
    assert.equal(mock.calls.length, 0);
  }
});

test("local_trusted rejects remote and non-loopback endpoints before any request", async () => {
  for (const endpoint of ["https://127.0.0.1:4310", "http://192.168.1.10:4310", "http://example.test:4310"]) {
    const mock = mockTransport();
    await assert.rejects(() => executeDemo1PreparedRequests(projection, preparation, localTrustedRuntime({ endpoint }), mock.transport), /loopback HTTP endpoint/i);
    assert.equal(mock.calls.length, 0);
  }
});

test("local_trusted rejects mismatched data-directory or instance configuration evidence", async () => {
  for (const isolationEvidence of [
    { ...localTrustedRuntime().isolationEvidence, observedDataDirectoryIdentity: "different-instance" },
    {
      ...localTrustedRuntime().isolationEvidence,
      observedInstanceConfiguration: { deploymentMode: "authenticated", deploymentExposure: "private", bind: "loopback" },
    },
  ]) {
    const mock = mockTransport();
    await assert.rejects(() => executeDemo1PreparedRequests(projection, preparation, localTrustedRuntime({ isolationEvidence }), mock.transport), /isolation evidence/i);
    assert.equal(mock.calls.length, 0);
  }
});

test("rejects a tampered generic transition that would exit a Human Gate", async () => {
  const tampered = structuredClone(preparation);
  tampered.transitions[0].fromStageKey = "human-gate-1";
  const mock = mockTransport();

  await assert.rejects(
    () => executeDemo1PreparedRequests(projection, tampered, runtime(), mock.transport),
    /Human Gate exits must use a Paperclip review operation/i,
  );
  assert.equal(mock.calls.length, 0);
});

test("stops on an invalid API response without advancing", async () => {
  const mock = mockTransport({ mutate: (response, request) => (
    request.path.endsWith("/pipelines") ? { status: 201, body: { id: "pipeline-1", stages: [] } } : response
  ) });
  await assert.rejects(() => executeDemo1PreparedRequests(projection, preparation, runtime(), mock.transport), /pipeline response/i);
  assert.equal(mock.calls.length, 1);
});

test("stops on a version conflict response without retrying the write", async () => {
  const mock = mockTransport({ mutate: (response, request) => (
    request.path.endsWith("/transition") ? { ...response, body: { ...response.body, case: { ...response.body.case, version: 99 } } } : response
  ) });
  await assert.rejects(() => executeDemo1PreparedRequests(projection, preparation, runtime(), mock.transport), /version/i);
  assert.equal(mock.calls.filter((call) => call.path.endsWith("/transition")).length, 1);
});

test("stops on an unexpected observed stage", async () => {
  const mock = mockTransport({ mutate: (response, request) => (
    request.path.endsWith("/transition") ? { ...response, body: { ...response.body, case: { ...response.body.case, stageId: "stage-wrong" } } } : response
  ) });
  await assert.rejects(() => executeDemo1PreparedRequests(projection, preparation, runtime(), mock.transport), /stage/i);
  assert.equal(mock.calls.filter((call) => call.path.endsWith("/transition")).length, 1);
});

test("stops failed writes without an unsafe retry", async () => {
  const mock = mockTransport({ mutate: (response, request) => (
    request.path.endsWith("/transitions") ? { status: 500, body: { error: "mock failure" } } : response
  ) });
  await assert.rejects(() => executeDemo1PreparedRequests(projection, preparation, runtime(), mock.transport), /unexpected status/i);
  assert.equal(mock.calls.filter((call) => call.path.endsWith("/transitions")).length, 1);
});

test("uses mocked transport only and never calls global network", async () => {
  const mock = mockTransport();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Live network must not be used by offline tests"); };
  try {
    await executeDemo1PreparedRequests(projection, preparation, runtime(), mock.transport);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
