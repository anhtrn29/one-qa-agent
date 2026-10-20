# ONE QA Agent V1 Workflow Contract

[`../config/one-qa-agent-v1.workflow-contract.json`](../config/one-qa-agent-v1.workflow-contract.json) is the authoritative local policy for the frozen ONE QA Agent V1 stage order. It is a contract only. It does not execute QA, persist workflow state, call Paperclip or Hermes, or alter the launcher.

## Ownership boundary

- ONE QA Agent owns QA-specific stage policy, artifact contracts, and transition rules.
- Paperclip is the proposed future owner of task/execution state, approvals, and audit. Every Paperclip mapping remains `UNKNOWN` until an adapter design verifies it.
- Hermes is the future agent runtime boundary for execution, tools, skills, and sessions. It is not the source of truth for QA stage or approval state.
- Playwright / Command Code is the automation execution layer.
- The launcher remains infrastructure readiness only.

## Static validation

Run locally without starting a workflow:

```powershell
node .\src\workflow\validate-workflow-contract.mjs
node --test .\tests\workflow\*.test.mjs
```

The validator rejects a changed stage count/order, duplicate IDs, skipped/reversed transitions, invalid default gate state, missing explicit gate policy, and integration claims that are not still `UNKNOWN`.

## Gate policy

- Human Gate #1 begins `UNAPPROVED` and blocks Test Design / Testcases.
- Human Gate #2 begins `UNAPPROVED` and blocks Command Code / Playwright.
- Human Gate #3 begins `UNAPPROVED` and blocks Final Report and Done.
- Agent output and infrastructure readiness are never approval records.
