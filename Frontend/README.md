# Frontend: guideline to form review

React 19 + Vite. The clinician reviews the logic model (View tab: flowchart, test patients, six checks; Edit tab: rule table with a live flow) and talks to an assistant. An AI agent stands in for the program officer. The IT approver deploys.

## Run

```
npm ci
npm run dev                                   # sample data, no backend
VITE_API_URL=<APIURL> npm run dev             # against the orchestrator API (Backend/src)
npm run build && npm run lint
```

`<APIURL>` is the `APIURL` output of `OrchestratorLambdaStack` (DEPLOYMENT.md), without the trailing slash. The API allows the origins in the CDK context `uiOrigins` (default `http://localhost:5173`). Optional: `VITE_CLINICIAN_ID` is the clinician's user id for signatures (default `clinician`).

## How it uses the backend (live mode)

| UI step | API calls (Backend/src/contract/routes.ts) |
|---|---|
| Upload a guideline | `POST /runs {filename}`, then `PUT` the PDF to the returned presigned URL (Content-Type `application/pdf`). The backend reads every page. |
| Library and progress | `GET /runs`, `GET /runs/:id` (state and steps) |
| Start the review | `GET /runs/:id/versions`, `GET /runs/:id/versions/:n`, `GET .../findings?audience=clinician` and `program_officer` |
| Approve | Optional `POST /runs/:id/versions` saved by the AI agent as `program_officer` (answers to questions routed to the program officer); `POST /runs/:id/versions` saved by the clinician (edits and the clinician's answers); `GET .../status` for the modelSha; `POST .../signatures/program_officer` (userId `ai-agent`); `POST .../signatures/clinician`. The version is then locked. |

Edits, the assistant and the in-browser checks run locally; nothing reaches the backend until Approve. Every open question is written into the model as resolved with a written answer, saved by the role it is routed to, as the backend's open-question check requires. The backend refuses a signature while its gate has blocking findings; the refusal and its blockers show as an error banner.

Not wired yet: quote check and cross check in the browser need the guideline text and draft B, which the API does not return (the backend runs its own quote grounding; see the findings in the assistant). Release (synthetic check, IT approve) is local; the release build runs on the build host (`npm run compile:locked` in Backend).

## Code

- `src/domain/agent.ts`: the AI agent's pass (checks 1 to 3, safe fixes) and the assistant.
- `src/domain/workflow.ts`: state machine none -> clinician -> verify -> deploy -> done.
- `src/api/index.ts`: the only file that talks to the backend.
- `../shared/pathway`: the logic model types, evaluator and compiler (`toGraph` builds the flowchart graph); tests: `cd shared && npm test`.
