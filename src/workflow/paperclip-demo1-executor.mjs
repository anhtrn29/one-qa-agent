import { assertOneQaGenericTransitionAllowed } from "./paperclip-review-execution-policy.mjs";

const REQUIRED_STAGE_KEYS = ["scope", "sources-requirements", "qa-overview", "human-gate-1"];

export class Demo1ExecutionError extends Error {
  constructor(message) {
    super(message);
    this.name = "Demo1ExecutionError";
  }
}

function fail(message) {
  throw new Demo1ExecutionError(message);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sameInstanceConfiguration(expected, observed) {
  return ["deploymentMode", "deploymentExposure", "bind"].every((key) => expected?.[key] === observed?.[key]);
}

function isLoopbackHttpEndpoint(endpoint) {
  if (endpoint.protocol !== "http:") return false;
  const host = endpoint.hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]") return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(ipv4 && Number(ipv4[1]) === 127 && ipv4.slice(1).every((part) => Number(part) <= 255));
}

function validateLocalTrustedIsolationEvidence(evidence) {
  if (!evidence || !nonEmptyString(evidence.dedicatedDataDirectoryIdentity)
    || !nonEmptyString(evidence.observedDataDirectoryIdentity)
    || evidence.dedicatedDataDirectoryIdentity !== evidence.observedDataDirectoryIdentity
    || !sameInstanceConfiguration(evidence.expectedInstanceConfiguration, evidence.observedInstanceConfiguration)) {
    fail("Demo execution requires independently comparable local_trusted isolation evidence.");
  }
  const configuration = evidence.observedInstanceConfiguration;
  if (configuration.deploymentMode !== "local_trusted" || configuration.deploymentExposure !== "private" || configuration.bind !== "loopback") {
    fail("Demo execution requires independently comparable local_trusted isolation evidence.");
  }
}

function validateRuntimeConfiguration(runtime, transport) {
  if (!runtime || runtime.isolatedEnvironment !== true) fail("Demo execution requires an explicitly isolated environment.");
  if (runtime.explicitDemoExecutionAuthorization !== true) fail("Demo execution requires explicit authorization.");
  if (!nonEmptyString(runtime.companyId)) fail("Demo execution requires an approved demo company.");
  if (typeof transport !== "function") fail("Demo execution requires an injected HTTP transport.");
  let endpoint;
  try {
    endpoint = new URL(runtime.endpoint);
  } catch {
    fail("Demo execution requires an isolated Paperclip endpoint URL.");
  }
  if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password) {
    fail("Demo execution requires a safe isolated Paperclip endpoint URL.");
  }
  const authenticationMode = runtime.authenticationMode ?? "authorization_header";
  if (authenticationMode === "authorization_header") {
    if (!nonEmptyString(runtime.authorizationHeader)) fail("Demo execution requires authentication authorization.");
  } else if (authenticationMode === "local_trusted") {
    if (!isLoopbackHttpEndpoint(endpoint)) fail("Demo execution local_trusted mode requires a loopback HTTP endpoint.");
    validateLocalTrustedIsolationEvidence(runtime.isolationEvidence);
  } else {
    fail("Demo execution requires a supported authentication mode.");
  }
  return { endpoint: endpoint.toString().replace(/\/$/, ""), authenticationMode };
}

function requireStatus(response, expectedStatus, operation) {
  if (!response || response.status !== expectedStatus) {
    fail(`${operation} returned an unexpected status.`);
  }
  return response.body;
}

function requirePipeline(body) {
  if (!nonEmptyString(body?.id) || !Array.isArray(body.stages)) fail("Invalid pipeline response.");
  const stageByKey = new Map(body.stages.map((stage) => [stage?.key, stage]));
  for (const key of REQUIRED_STAGE_KEYS) {
    if (!nonEmptyString(stageByKey.get(key)?.id)) fail("Invalid pipeline response: required Demo 1 stage is missing.");
  }
  return stageByKey;
}

function requireTransitions(body, count) {
  if (!Array.isArray(body?.transitions) || body.transitions.length !== count) {
    fail("Invalid transition replacement response.");
  }
}

function requireCase(body, expected, stageByKey) {
  const observed = body?.case;
  if (!nonEmptyString(observed?.id) || observed.caseKey !== expected.caseKey || !Number.isInteger(observed.version) || observed.version < 1) {
    fail("Invalid case response.");
  }
  if (observed.stageId !== stageByKey.get(expected.stageKey)?.id) fail("Unexpected case stage in API response.");
  return observed;
}

function assertPreparedPath(projection, preparation) {
  if (preparation?.mode !== "OFFLINE_REQUEST_PREPARATION_ONLY" || preparation.reviewOperations?.length !== 0) {
    fail("Demo execution accepts only the offline Demo 1 preparation with no review operation.");
  }
  if (!Array.isArray(preparation.transitions) || preparation.transitions.length !== 3) fail("Demo preparation must contain exactly three pre-Gate transitions.");
  for (const transition of preparation.transitions) {
    if ("force" in (transition.bodyTemplate ?? {})) fail("Forced transitions are prohibited.");
    assertOneQaGenericTransitionAllowed(projection, {
      fromStageKey: transition.fromStageKey,
      toStageKey: transition.bodyTemplate?.toStageKey,
    });
  }
  if (preparation.transitions.at(-1)?.bodyTemplate?.toStageKey !== "human-gate-1") {
    fail("Demo execution must stop at Human Gate #1.");
  }
}

function makeRequest(endpoint, runtime, descriptor, body, pathValues = {}, query) {
  const path = Object.entries(pathValues).reduce(
    (result, [key, value]) => result.replace(`:${key}`, encodeURIComponent(value)),
    descriptor.pathTemplate,
  );
  const url = new URL(path, `${endpoint}/`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return {
    method: descriptor.method,
    path,
    url: url.toString(),
    headers: {
      "content-type": "application/json",
      ...(runtime.authenticationMode === "local_trusted" ? {} : { authorization: runtime.authorizationHeader }),
    },
    ...(body === undefined ? {} : { body }),
  };
}

async function send(transport, request, audit, operation, expectedStatus) {
  let response;
  try {
    response = await transport(request);
  } catch {
    fail(`${operation} transport failed.`);
  }
  const body = requireStatus(response, expectedStatus, operation);
  audit.push({ operation, status: response.status });
  return body;
}

/**
 * Executes only an explicitly authorized Demo 1 preparation through an
 * injected transport. It owns no state: every identifier and version is read
 * from Paperclip responses, and no write is retried.
 */
export async function executeDemo1PreparedRequests(projection, preparation, runtime, transport) {
  const { endpoint, authenticationMode } = validateRuntimeConfiguration(runtime, transport);
  const resolvedRuntime = { ...runtime, authenticationMode };
  assertPreparedPath(projection, preparation);
  const audit = [];

  const createPipelineBody = {
    ...preparation.pipeline.create.body,
    ...(nonEmptyString(runtime.projectId) ? { projectId: runtime.projectId } : {}),
  };
  const pipeline = await send(transport, makeRequest(endpoint, resolvedRuntime, preparation.pipeline.create, createPipelineBody, {
    companyId: runtime.companyId,
  }), audit, "CREATE_PIPELINE", 201);
  const stageByKey = requirePipeline(pipeline);

  const transitions = await send(transport, makeRequest(endpoint, resolvedRuntime, preparation.pipeline.replaceTransitions,
    preparation.pipeline.replaceTransitions.body, { pipelineId: pipeline.id }), audit, "REPLACE_PIPELINE_TRANSITIONS", 200);
  requireTransitions(transitions, preparation.pipeline.replaceTransitions.body.transitions.length);

  const created = await send(transport, makeRequest(endpoint, resolvedRuntime, preparation.case.create,
    preparation.case.create.body, { pipelineId: pipeline.id }), audit, "CREATE_CASE", 201);
  if (created?.created !== true) fail("Invalid case response: Demo 1 requires a newly created case.");
  let currentCase = requireCase(created, preparation.case.create.body, stageByKey);

  for (const descriptor of preparation.transitions) {
    const expectedVersion = currentCase.version;
    const body = { toStageKey: descriptor.bodyTemplate.toStageKey, expectedVersion };
    const transitioned = await send(transport, makeRequest(endpoint, resolvedRuntime, descriptor, body, { caseId: currentCase.id }),
      audit, "TRANSITION_CASE", 200);
    const expected = { caseKey: currentCase.caseKey, stageKey: body.toStageKey };
    const observed = requireCase(transitioned, expected, stageByKey);
    if (observed.version !== expectedVersion + 1) fail("Unexpected case version in transition response.");
    currentCase = observed;
  }

  const verification = await send(transport, makeRequest(endpoint, resolvedRuntime, preparation.gateStopVerification, undefined,
    { pipelineId: pipeline.id }, preparation.gateStopVerification.query), audit, "VERIFY_HUMAN_GATE_1_STOP", 200);
  if (!Array.isArray(verification)) fail("Invalid Human Gate verification response.");
  const row = verification.find((item) => item?.case?.id === currentCase.id && item?.case?.caseKey === currentCase.caseKey);
  if (row?.stage?.key !== "human-gate-1" || row.stage.kind !== "review" || row.stage.config?.requireApproval !== true) {
    fail("Human Gate #1 is not awaiting required human approval.");
  }

  return {
    status: "STOPPED_AT_HUMAN_GATE_1",
    pipelineId: pipeline.id,
    caseId: currentCase.id,
    gate: { stageKey: row.stage.key, awaitingHumanApproval: true },
    audit,
  };
}
