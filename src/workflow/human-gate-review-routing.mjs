import { readFileSync } from "node:fs";

const UNRESOLVED = "UNRESOLVED";
const RESOLVED = "RESOLVED";

function adjacentStageKey(projection, stageId) {
  const index = projection.stages.findIndex((stage) => stage.contractStageId === stageId);
  return index < 0 ? null : projection.stages[index + 1]?.contractStageId ?? null;
}

function rejectRevisionStageKey(projection, stageId) {
  return projection.transitions.find((transition) => (
    transition.fromStageKey === stageId && transition.kind === "reject-revision"
  ))?.toStageKey ?? null;
}

function routeBlocker(stageId, routeName) {
  return {
    code: "HUMAN_GATE_ROUTE_UNRESOLVED",
    stageId,
    routeName,
    destination: UNRESOLVED,
    message: `${stageId} ${routeName} destination needs an explicit business decision.`,
  };
}

function targetFor(gate, routeName) {
  const route = gate[routeName];
  if (!route || typeof route !== "object") {
    return { kind: "missing" };
  }
  if (route.destination === UNRESOLVED) {
    return { kind: "unresolved" };
  }
  if (route.destination !== RESOLVED || typeof route.toStageKey !== "string" || route.toStageKey.length === 0) {
    throw new Error(`${gate.stageId} ${routeName} must be UNRESOLVED or a RESOLVED frozen stage key.`);
  }
  return { kind: "resolved", toStageKey: route.toStageKey };
}

/**
 * Converts an approved, separate routing configuration into the adapter's
 * reviewRoutes shape. No unresolved route is inferred or emitted.
 */
export function buildReviewRoutesFromHumanGateConfiguration(projection, configuration) {
  if (!projection?.sourceContract?.contractId || !Array.isArray(projection.stages)) {
    throw new Error("A valid frozen workflow projection is required.");
  }
  if (configuration?.sourceContractId !== projection.sourceContract.contractId) {
    throw new Error("Human Gate routing configuration must identify the frozen workflow contract.");
  }
  if (!Array.isArray(configuration.gates)) {
    throw new Error("Human Gate routing configuration must contain gates.");
  }

  const gateStages = projection.stages.filter((stage) => stage.humanGate !== null);
  const frozenGateIds = new Set(gateStages.map((stage) => stage.contractStageId));
  const configuredGates = new Map();
  configuration.gates.forEach((gate) => {
    if (configuredGates.has(gate.stageId)) {
      throw new Error(`Human Gate routing configuration contains a duplicate ${gate.stageId}.`);
    }
    if (!frozenGateIds.has(gate.stageId)) {
      throw new Error(`Human Gate routing configuration references unknown gate ${gate.stageId}.`);
    }
    configuredGates.set(gate.stageId, gate);
  });

  const blockers = [];
  const reviewRoutes = {};
  const rejectRoutes = {};
  for (const stage of gateStages) {
    const gate = configuredGates.get(stage.contractStageId);
    if (!gate) {
      blockers.push({
        code: "HUMAN_GATE_ROUTE_MISSING",
        stageId: stage.contractStageId,
        message: `${stage.contractStageId} has no separate review-routing configuration.`,
      });
      continue;
    }
    if (gate.requireApproval !== true || gate.approver?.kind !== "any_human") {
      throw new Error(`${stage.contractStageId} must require approval from any_human.`);
    }
    const approvedTarget = adjacentStageKey(projection, stage.contractStageId);
    if (gate.approveToStageKey !== approvedTarget) {
      throw new Error(`${stage.contractStageId} must approve only to the adjacent frozen stage ${approvedTarget}.`);
    }

    const reject = targetFor(gate, "reject");
    const requestChanges = targetFor(gate, "requestChanges");
    const approvedRejectTarget = rejectRevisionStageKey(projection, stage.contractStageId);
    if (reject.kind === "resolved" && reject.toStageKey !== approvedRejectTarget) {
      throw new Error(`${stage.contractStageId} reject routing must use approved reject revision stage ${approvedRejectTarget}.`);
    }
    if (requestChanges.kind === "resolved" && requestChanges.toStageKey !== approvedRejectTarget) {
      throw new Error(`${stage.contractStageId} requestChanges routing must use approved reject revision stage ${approvedRejectTarget}.`);
    }
    if (reject.kind !== "resolved") {
      blockers.push(reject.kind === "missing"
        ? { code: "HUMAN_GATE_ROUTE_MISSING", stageId: stage.contractStageId, routeName: "reject", message: `${stage.contractStageId} reject routing is missing.` }
        : routeBlocker(stage.contractStageId, "reject"));
    } else {
      rejectRoutes[stage.contractStageId] = reject.toStageKey;
    }
    if (requestChanges.kind !== "resolved") {
      blockers.push(requestChanges.kind === "missing"
        ? { code: "HUMAN_GATE_ROUTE_MISSING", stageId: stage.contractStageId, routeName: "requestChanges", message: `${stage.contractStageId} request-changes routing is missing.` }
        : routeBlocker(stage.contractStageId, "requestChanges"));
    }
    if (reject.kind === "resolved" && requestChanges.kind === "resolved") {
      reviewRoutes[stage.contractStageId] = {
        rejectToStageKey: reject.toStageKey,
        requestChangesToStageKey: requestChanges.toStageKey,
      };
    }
  }

  if (blockers.length > 0) {
    return { status: "BLOCKED", blockers, reviewRoutes: null, rejectRoutes };
  }
  return { status: "ROUTING_VALIDATION_REQUIRED", blockers: [], reviewRoutes, rejectRoutes };
}

export function loadHumanGateReviewRouting(configurationUrl) {
  return JSON.parse(readFileSync(configurationUrl, "utf8"));
}
