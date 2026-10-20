import { FROZEN_STAGE_IDS } from "./validate-workflow-contract.mjs";

export const PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY = "__one_qa_paperclip_cancelled__";

const TECHNICAL_STAGE_NAME = "Paperclip Compatibility Cancelled (Technical Only)";

function fail(message) {
  throw new Error(`Paperclip cancelled-stage compatibility error: ${message}`);
}

function reviewTargetsTechnicalStage(stage) {
  const config = stage.config ?? {};
  return [config.approveToStageKey, config.rejectToStageKey, config.requestChangesToStageKey]
    .includes(PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY);
}

function validateCandidate(candidate) {
  const stages = candidate?.createPipelineRequest?.stages;
  const transitions = candidate?.replaceTransitionsRequest?.transitions;
  if (!Array.isArray(stages) || !Array.isArray(transitions)) fail("candidate must contain Paperclip stages and transitions.");

  const technicalStages = stages.filter((stage) => stage.key === PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY);
  if (technicalStages.length > 1) fail("technical cancelled stage must not be duplicated.");
  if (technicalStages.length === 1) {
    const [technical] = technicalStages;
    if (technical.kind !== "cancelled" || technical.name !== TECHNICAL_STAGE_NAME) {
      fail("reserved technical cancelled stage has an invalid representation.");
    }
  }

  const businessStages = stages.filter((stage) => stage.key !== PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY);
  if (businessStages.length !== FROZEN_STAGE_IDS.length || businessStages.some((stage, index) => stage.key !== FROZEN_STAGE_IDS[index])) {
    fail("business stages must remain the 18 frozen stage IDs in order.");
  }
  if (businessStages.filter((stage) => stage.key === "done" && stage.kind === "done").length !== 1) {
    fail("the frozen business Done stage must remain the only business done stage.");
  }
  if (businessStages.some((stage) => stage.kind === "cancelled")) fail("a business stage cannot satisfy the technical cancelled-stage requirement.");
  if (transitions.some((edge) => (
    edge.fromStageKey === PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY
    || edge.toStageKey === PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY
  ))) fail("no transition may enter or leave the technical cancelled stage.");
  if (businessStages.some(reviewTargetsTechnicalStage)) fail("no Human Gate review destination may target the technical cancelled stage.");
  if (candidate.createPipelineRequest.enforceTransitions !== true || candidate.replaceTransitionsRequest.enforceTransitions !== true) {
    fail("transition enforcement must remain enabled.");
  }
  return { stages, technicalStages };
}

/**
 * Adds the service-required Paperclip terminal representation after the
 * business-only projection. It never changes business stages or transitions.
 */
export function applyPaperclipCancelledStageCompatibility(candidate) {
  const { stages, technicalStages } = validateCandidate(candidate);
  if (technicalStages.length === 1) return candidate;

  const maxPosition = Math.max(...stages.map((stage) => stage.position));
  if (!Number.isInteger(maxPosition)) fail("all Paperclip stage positions must be integers.");
  const technicalStage = {
    key: PAPERCLIP_CANCELLED_COMPATIBILITY_STAGE_KEY,
    name: TECHNICAL_STAGE_NAME,
    kind: "cancelled",
    position: maxPosition + 100,
  };
  return {
    ...candidate,
    createPipelineRequest: {
      ...candidate.createPipelineRequest,
      stages: [...stages, technicalStage],
    },
  };
}
