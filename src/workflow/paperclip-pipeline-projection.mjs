import { readFileSync } from "node:fs";

import { validateWorkflowContract } from "./validate-workflow-contract.mjs";

const UNKNOWN = "UNKNOWN";

function invalidContractError(errors) {
  const detail = errors.map((item) => `[${item.code}] ${item.message}`).join(" ");
  return new Error(`Cannot project an invalid workflow contract. ${detail}`);
}

/**
 * Builds a local, serializable projection from the frozen QA workflow contract.
 *
 * This is deliberately not a Paperclip API payload.  It records only the
 * Paperclip fields verified in the installed package and leaves configuration
 * semantics that still need integration decisions as UNKNOWN/TODO.
 */
export function buildPaperclipPipelineProjection(contract) {
  const validationErrors = validateWorkflowContract(contract);
  if (validationErrors.length > 0) {
    throw invalidContractError(validationErrors);
  }

  const stages = contract.stages.map((stage, contractOrder) => ({
    contractStageId: stage.id,
    name: stage.name,
    contractOrder,
    humanGate: stage.humanGate
      ? {
          number: stage.humanGate.number,
          defaultState: contract.humanGateStates[stage.id],
          requiredForNextStage: stage.humanGate.requiredForNextStage,
          paperclipApprovalMapping: {
            status: UNKNOWN,
            todo: "Map this gate to a Paperclip review/approval configuration only after adapter policy is approved.",
          },
        }
      : null,
  }));

  const transitions = contract.transitions.map((transition) => ({
    fromStageKey: transition.from,
    toStageKey: transition.to,
    contractCondition: transition.condition,
    kind: transition.kind ?? "forward",
  }));

  return {
    projectionKind: "one-qa-agent-v1-paperclip-pipeline-projection",
    sourceContract: {
      contractId: contract.contractId,
      version: contract.version,
    },
    pipeline: {
      enforceTransitions: true,
    },
    stages,
    transitions,
    paperclip: {
      apiPayloadGenerated: false,
      verifiedImplementation: {
        status: "VERIFIED_IMPLEMENTATION",
        source: "Installed Paperclip shared pipeline validator and server pipeline routes",
        fields: {
          pipeline: ["enforceTransitions"],
          stage: ["key", "name", "kind", "position", "config"],
          transition: ["fromStageKey", "toStageKey", "label"],
        },
        stageKinds: ["working", "review", "done", "cancelled"],
      },
      unknownMappings: {
        status: UNKNOWN,
        stageKindSelection: "TODO: approve the local-stage-to-Paperclip-kind mapping.",
        stagePositionSemantics: "TODO: confirm create/update ordering semantics during adapter implementation.",
        humanGateApprovalConfig: "TODO: map each gate to Paperclip requireApproval/approver/review behavior.",
        APIRequestShape: "TODO: construct and validate an API payload only in the approved adapter slice.",
      },
    },
  };
}

/**
 * Reads only the supplied local contract file, then performs the pure build.
 * It does not contact Paperclip, Hermes, or any other runtime.
 */
export function loadPaperclipPipelineProjection(contractUrl) {
  const contract = JSON.parse(readFileSync(contractUrl, "utf8"));
  return buildPaperclipPipelineProjection(contract);
}
