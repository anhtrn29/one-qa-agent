import { assertOneQaGenericTransitionAllowed } from "./paperclip-review-execution-policy.mjs";

const DEMO_CASE_KEY = "DEMO-MOCK-ONE-QA-001";
const DEMO_STAGE_PATH = [
  ["scope", "sources-requirements"],
  ["sources-requirements", "qa-overview"],
  ["qa-overview", "human-gate-1"],
];

function assertDeployableCandidate(dryRun) {
  if (dryRun?.status !== "DRY_RUN_VALIDATION_REQUIRED" || !dryRun.candidate) {
    throw new Error("Demo 1 requires a deployable, schema-validated pipeline candidate; blocked routing cannot be prepared.");
  }
}

function transitionTemplate(projection, fromStageKey, toStageKey, sequence) {
  assertOneQaGenericTransitionAllowed(projection, { fromStageKey, toStageKey });
  return {
    operation: "TRANSITION_CASE",
    method: "POST",
    pathTemplate: "/cases/:caseId/transition",
    fromStageKey,
    bodyTemplate: {
      toStageKey,
      expectedVersionBinding: sequence === 1
        ? "caseVersionAfterCreate"
        : `caseVersionAfterTransition${sequence - 1}`,
    },
  };
}

/**
 * Prepares, but never sends, the requests for the narrow Demo 1 path.
 * Runtime identifiers and optimistic-lock versions are deliberately bindings,
 * because this module has no state store and performs no Paperclip calls.
 */
export function buildDemo1PaperclipPreparation(projection, dryRun) {
  assertDeployableCandidate(dryRun);

  const transitions = DEMO_STAGE_PATH.map(([fromStageKey, toStageKey], index) => (
    transitionTemplate(projection, fromStageKey, toStageKey, index + 1)
  ));

  return {
    mode: "OFFLINE_REQUEST_PREPARATION_ONLY",
    pipeline: {
      create: {
        operation: "CREATE_PIPELINE",
        method: "POST",
        pathTemplate: "/companies/:companyId/pipelines",
        body: dryRun.candidate.createPipelineRequest,
      },
      replaceTransitions: {
        operation: "REPLACE_PIPELINE_TRANSITIONS",
        method: "PUT",
        pathTemplate: "/pipelines/:pipelineId/transitions",
        body: dryRun.candidate.replaceTransitionsRequest,
      },
    },
    case: {
      create: {
        operation: "CREATE_CASE",
        method: "POST",
        pathTemplate: "/pipelines/:pipelineId/cases",
        body: {
          caseKey: DEMO_CASE_KEY,
          title: "DEMO/MOCK — ONE QA Agent V1 Demo 1",
          summary: "DEMO/MOCK only: Scope through Human Gate #1; no live QA target or external source.",
          stageKey: "scope",
          fields: {
            demo: true,
            label: "DEMO/MOCK",
            requirements: {
              label: "DEMO/MOCK",
              summary: "Mock QA requirements for Demo 1 only.",
            },
            artifacts: {
              scope: { label: "DEMO/MOCK", summary: "Mock scope artifact." },
              sourcesRequirements: { label: "DEMO/MOCK", summary: "Mock requirements artifact." },
              qaOverview: { label: "DEMO/MOCK", summary: "Mock QA Overview artifact." },
            },
          },
        },
      },
    },
    transitions,
    reviewOperations: [],
    gateStopVerification: {
      operation: "LIST_PIPELINE_CASES",
      method: "GET",
      pathTemplate: "/pipelines/:pipelineId/cases",
      query: { stageKey: "human-gate-1" },
      expected: {
        caseKey: DEMO_CASE_KEY,
        stageKey: "human-gate-1",
        humanGateState: "UNAPPROVED",
        requiresExplicitHumanApproval: true,
      },
    },
  };
}
