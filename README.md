# ONE QA Agent

Local workflow contract, Paperclip integration adapters, and the Windows launcher for ONE QA Agent V1.

## Project layout

- `src/workflow/` — workflow validation, projections, policies, adapters, and demo executor.
- `tests/workflow/` — Node.js tests for the workflow modules.
- `config/` — authoritative workflow contract and Human Gate routing configuration.
- `launcher/` — Windows preflight launcher and its configuration.
- `docs/` — workflow documentation.
- `logs/` — launcher output retained locally.
- `.demo-runtime/` — local Paperclip demo runtime data; do not edit while the demo service is running.

## Run

Start the local services by double-clicking `Start-One-QA-Agent.cmd`.

Validate the workflow contract and run its tests:

```powershell
node .\src\workflow\validate-workflow-contract.mjs
node --test .\tests\workflow\*.test.mjs
```

See [the workflow contract](docs/WORKFLOW-CONTRACT.md) for the stage and approval policy.
