const PAPERCLIP_PIPELINE_SCHEMA_MODULE_URL =
  "file:///C:/Users/dell/AppData/Roaming/npm/node_modules/paperclipai/node_modules/@paperclipai/server/dist/routes/pipelines-schemas.js";
const PAPERCLIP_PIPELINE_CONFIG_SCHEMA_MODULE_URL =
  "file:///C:/Users/dell/AppData/Roaming/npm/node_modules/paperclipai/node_modules/@paperclipai/shared/dist/validators/pipeline.js";

import { APPROVED_REJECT_REVISION_EDGES, FROZEN_STAGE_IDS } from "./validate-workflow-contract.mjs";
import {
  PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY,
  applyPaperclipCancelledStageCompatibility,
} from "./paperclip-cancelled-stage-compatibility.mjs";

const PAPERCLIP_STAGE_KINDS = new Set(["working", "review", "done", "cancelled"]);

function allStageKeys(projection) {
  return new Set(projection.stages.map((stage) => stage.contractStageId));
}

function nextStageKey(projection, stageId) {
  const index = projection.stages.findIndex((stage) => stage.contractStageId === stageId);
  return index >= 0 ? projection.stages[index + 1]?.contractStageId ?? null : null;
}

function rejectRevisionStageKey(projection, stageId) {
  return projection.transitions.find((transition) => (
    transition.fromStageKey === stageId && transition.kind === "reject-revision"
  ))?.toStageKey ?? null;
}

function reviewPolicyBlockers(projection, reviewRoutes) {
  const blockers = [];
  const stageKeys = allStageKeys(projection);

  for (const stage of projection.stages.filter((item) => item.humanGate !== null)) {
    const route = reviewRoutes?.[stage.contractStageId];
    const approvedTarget = nextStageKey(projection, stage.contractStageId);
    const rejectedTarget = rejectRevisionStageKey(projection, stage.contractStageId);

    if (!route?.rejectToStageKey || !route?.requestChangesToStageKey) {
      blockers.push({
        code: "HUMAN_GATE_REVIEW_POLICY_REQUIRED",
        stageId: stage.contractStageId,
        message: "Human-owned reject and request-changes destinations are required; the frozen contract does not define them.",
      });
      continue;
    }
    if (!stageKeys.has(route.rejectToStageKey)) {
      throw new Error(`${stage.contractStageId} rejectToStageKey must reference a frozen stage.`);
    }
    if (!stageKeys.has(route.requestChangesToStageKey)) {
      throw new Error(`${stage.contractStageId} requestChangesToStageKey must reference a frozen stage.`);
    }
    if (route.rejectToStageKey !== rejectedTarget) {
      throw new Error(`${stage.contractStageId} rejectToStageKey must use approved reject revision stage ${rejectedTarget}.`);
    }
    if (route.requestChangesToStageKey !== rejectedTarget) {
      throw new Error(`${stage.contractStageId} requestChangesToStageKey must use approved reject revision stage ${rejectedTarget}.`);
    }
    if (route.approveToStageKey !== undefined && route.approveToStageKey !== approvedTarget) {
      throw new Error(`${stage.contractStageId} must approve only to the adjacent frozen stage ${approvedTarget}.`);
    }
  }

  return blockers;
}

function createStages(projection, reviewRoutes) {
  return projection.stages.map((stage) => {
    const isGate = stage.humanGate !== null;
    const isTerminal = stage.contractStageId === "done";
    const kind = isGate ? "review" : isTerminal ? "done" : "working";
    const position = (stage.contractOrder + 1) * 100;

    if (!isGate) {
      return { key: stage.contractStageId, name: stage.name, kind, position };
    }

    const route = reviewRoutes[stage.contractStageId];
    return {
      key: stage.contractStageId,
      name: stage.name,
      kind,
      position,
      config: {
        requireApproval: true,
        approver: { kind: "any_human" },
        approveToStageKey: nextStageKey(projection, stage.contractStageId),
        rejectToStageKey: route.rejectToStageKey,
        requestChangesToStageKey: route.requestChangesToStageKey,
      },
    };
  });
}

function assertCandidateInvariants(candidate) {
  const stages = candidate.createPipelineRequest.stages;
  const transitions = candidate.replaceTransitionsRequest.transitions;
  const stageKeys = stages.map((stage) => stage.key);
  const businessStages = stages.filter((stage) => stage.key !== PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY);
  const businessStageKeys = businessStages.map((stage) => stage.key);
  const technicalStages = stages.filter((stage) => stage.key === PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY);

  if (stages.length !== 19 || new Set(stageKeys).size !== 19) {
    return ["Candidate must contain 19 unique Paperclip stages."];
  }
  if (businessStages.length !== 18 || businessStageKeys.some((key, index) => key !== FROZEN_STAGE_IDS[index])) {
    return ["Candidate must preserve the 18 frozen business stages in order."];
  }
  if (technicalStages.length !== 1 || technicalStages[0].kind !== "cancelled") {
    return ["Candidate must contain exactly one technical cancelled stage."];
  }
  if (transitions.length !== 20) {
    return ["Candidate must preserve exactly 20 transitions."];
  }

  const errors = [];
  stages.forEach((stage) => {
    if (!PAPERCLIP_STAGE_KINDS.has(stage.kind)) {
      errors.push(`Stage ${stage.key} has an unsupported Paperclip kind.`);
    }
    if (!Number.isInteger(stage.position)) {
      errors.push(`Stage ${stage.key} must have an integer position.`);
    }
  });
  const doneStage = businessStages.find((stage) => stage.key === "done");
  if (doneStage?.kind !== "done") errors.push("The frozen business Done stage must have Paperclip kind done.");
  if (transitions.some((transition) => (
    transition.fromStageKey === PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY
    || transition.toStageKey === PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY
  ))) errors.push("Technical cancelled stage must be unreachable by business transitions.");
  transitions.slice(0, FROZEN_STAGE_IDS.length - 1).forEach((transition, index) => {
    if (transition.fromStageKey !== businessStageKeys[index] || transition.toStageKey !== businessStageKeys[index + 1]) {
      errors.push("Candidate contains a skipped, reversed, or altered forward transition.");
    }
  });
  transitions.slice(FROZEN_STAGE_IDS.length - 1).forEach((transition, index) => {
    const [fromStageKey, toStageKey] = APPROVED_REJECT_REVISION_EDGES[index] ?? [];
    if (transition.fromStageKey !== fromStageKey || transition.toStageKey !== toStageKey) {
      errors.push("Candidate contains an unapproved reject revision transition.");
    }
  });
  businessStages.filter((stage) => stage.kind === "review").forEach((stage) => {
    const transition = transitions.find((item) => item.fromStageKey === stage.key);
    if (stage.config?.requireApproval !== true || stage.config?.approver?.kind !== "any_human") {
      errors.push(`Human Gate ${stage.key} must require an any_human approval.`);
    }
    if (stage.config?.approveToStageKey !== transition?.toStageKey) {
      errors.push(`Human Gate ${stage.key} approval must use its adjacent frozen transition.`);
    }
  });
  return errors;
}

/**
 * Builds a dry-run only candidate from the existing projection.
 * A rejection destination is intentionally caller-supplied: the frozen QA
 * contract defines approvals but does not define rejection behavior.
 */
export function buildPaperclipPipelineDryRun(projection, { reviewRoutes } = {}) {
  if (projection?.pipeline?.enforceTransitions !== true) {
    throw new Error("Projection must enforce frozen transitions.");
  }

  const blockers = reviewPolicyBlockers(projection, reviewRoutes);
  if (blockers.length > 0) {
    return { status: "BLOCKED", blockers, candidate: null };
  }

  const createPipelineRequest = {
    key: projection.sourceContract.contractId,
    name: projection.sourceContract.contractId,
    enforceTransitions: true,
    stages: createStages(projection, reviewRoutes),
  };
  const replaceTransitionsRequest = {
    enforceTransitions: true,
    transitions: projection.transitions.map((transition) => ({
      fromStageKey: transition.fromStageKey,
      toStageKey: transition.toStageKey,
      label: null,
    })),
  };

  const candidate = applyPaperclipCancelledStageCompatibility({ createPipelineRequest, replaceTransitionsRequest });
  const invariantErrors = assertCandidateInvariants(candidate);
  if (invariantErrors.length > 0) {
    throw new Error(`Invalid Paperclip dry-run candidate. ${invariantErrors.join(" ")}`);
  }
  return { status: "DRY_RUN_VALIDATION_REQUIRED", blockers: [], candidate };
}

/**
 * Validates the request bodies against the installed Paperclip 2026.916.1
 * route schemas. This imports local package code only; it makes no API,
 * database, or runtime call.
 */
export async function validatePaperclipPipelineDryRun(dryRun, {
  schemaModuleUrl = PAPERCLIP_PIPELINE_SCHEMA_MODULE_URL,
  configSchemaModuleUrl = PAPERCLIP_PIPELINE_CONFIG_SCHEMA_MODULE_URL,
} = {}) {
  if (dryRun?.status !== "DRY_RUN_VALIDATION_REQUIRED" || !dryRun.candidate) {
    return { valid: false, errors: ["No deployable candidate exists while the dry run is BLOCKED."] };
  }

  const invariantErrors = assertCandidateInvariants(dryRun.candidate);
  const { createPipelineSchema, replaceTransitionsSchema } = await import(schemaModuleUrl);
  const { pipelineStageConfigSchema } = await import(configSchemaModuleUrl);
  const pipelineResult = createPipelineSchema.safeParse(dryRun.candidate.createPipelineRequest);
  const transitionResult = replaceTransitionsSchema.safeParse(dryRun.candidate.replaceTransitionsRequest);
  const schemaErrors = [pipelineResult, transitionResult]
    .filter((result) => !result.success)
    .flatMap((result) => result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  const configErrors = dryRun.candidate.createPipelineRequest.stages
    .filter((stage) => stage.kind === "review")
    .flatMap((stage) => {
      const result = pipelineStageConfigSchema.safeParse(stage.config);
      return result.success
        ? []
        : result.error.issues.map((issue) => `${stage.key}.config.${issue.path.join(".")}: ${issue.message}`);
    });

  return {
    valid: invariantErrors.length === 0 && schemaErrors.length === 0 && configErrors.length === 0,
    errors: [...invariantErrors, ...schemaErrors, ...configErrors],
  };
}
