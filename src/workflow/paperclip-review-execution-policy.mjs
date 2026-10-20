function gateStage(projection, stageId) {
  const stage = projection?.stages?.find((item) => item.contractStageId === stageId);
  if (!stage?.humanGate) {
    throw new Error(`${stageId} is not a frozen Human Gate.`);
  }
  return stage;
}

function targetFor(projection, stageId, kind) {
  return projection.transitions.find((edge) => (
    edge.fromStageKey === stageId && edge.kind === kind
  ))?.toStageKey ?? null;
}

/**
 * Returns an intent for the Paperclip review endpoint. It deliberately never
 * returns a generic transition intent for a Human Gate exit.
 */
export function buildOneQaReviewOperation(projection, {
  stageId,
  decision,
  actorType,
  reason,
  priorApprovalEventId,
} = {}) {
  gateStage(projection, stageId);
  if (actorType !== "human") {
    throw new Error("Human Gate review requires a human actor.");
  }
  if (priorApprovalEventId !== undefined) {
    throw new Error("A Human Gate exit requires a fresh review decision; prior approval evidence cannot be reused.");
  }
  if (decision !== "approve" && decision !== "reject" && decision !== "request_changes") {
    throw new Error("Human Gate review decision must be approve, reject, or request_changes.");
  }
  if (decision === "request_changes" && (typeof reason !== "string" || reason.trim().length === 0)) {
    throw new Error("Request changes requires a non-empty reason.");
  }

  const kind = decision === "approve" ? "forward" : "reject-revision";
  const toStageKey = targetFor(projection, stageId, kind);
  if (!toStageKey) {
    throw new Error(`${stageId} has no approved ${decision} transition.`);
  }
  return { operation: "PAPERCLIP_REVIEW", stageId, decision, toStageKey, ...(decision === "request_changes" ? { reason: reason.trim() } : {}) };
}

/**
 * ONE QA's adapter must never use Paperclip's generic transition endpoint to
 * leave a Human Gate. Direct external Paperclip API callers are out of scope.
 */
export function assertOneQaGenericTransitionAllowed(projection, { fromStageKey, toStageKey } = {}) {
  if (projection?.stages?.some((stage) => stage.contractStageId === fromStageKey && stage.humanGate)) {
    throw new Error("Human Gate exits must use a Paperclip review operation, not a generic transition.");
  }
  const allowed = projection?.transitions?.some((edge) => (
    edge.fromStageKey === fromStageKey && edge.toStageKey === toStageKey
  ));
  if (!allowed) {
    throw new Error("Generic transition is not an approved frozen workflow transition.");
  }
  return true;
}
