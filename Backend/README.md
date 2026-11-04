# Guideline intake pipeline (local mode)

Upload -> S3 -> S3 event -> queue -> worker: extract -> digest -> logic model (JSON) -> served to the review UI.

Local mode emulates S3, the S3 event notification, SQS and the state table on disk under `.local-data/`, so no AWS account is needed. Each emulator sits behind an interface (`ObjectStore`, `Queue`, `GuidelineStore`) that an AWS adapter replaces.

## Run

Node 22.18 or later (runs TypeScript directly, no build step).

    cd Backend && npm install && npm run dev     # http://localhost:8787
    cd Frontend && npm run dev                   # uses VITE_API_URL from Frontend/.env.local

`Frontend/.env.local` holds `VITE_API_URL=http://localhost:8787`. Remove it to go back to sample data.

Sample file to upload: `samples/cough-guideline-sample.pdf` (synthetic; regenerate with `npm run sample-pdf`).

Tests: `npm test` (end to end through the HTTP API). Types: `npm run typecheck`.

## Flow

1. `POST /guidelines/upload-url {fileName, size, contentType}` creates the record and returns a presigned PUT URL.
2. Browser PUTs the file. The bucket fires an `ObjectCreated:Put` event (S3 notification JSON) for `uploads/` into the queue.
3. Worker polls the queue (visibility timeout, 3 receives, then dead-letter) and runs:
   - extract: PDF text layer, TXT, MD, CSV, HTML -> `extracted/<id>/pages.json`. Other types end `Unsupported` (need Textract).
   - digest: labelled blocks with page, kind, numbers with units, decision words -> `digested/<id>/digest.json`.
   - logic model: `LogicModelBuilder` -> shared compiler checks (`validateSpec`, structure + semantics) -> quote check against the digest (found, and on the cited page) -> `logic-models/<id>/logic-model.json`.
4. UI polls `GET /guidelines` for step progress, then reads `GET /guidelines/<id>/logic-model` to start the draft.

Also: `GET /guidelines/<id>`, `/guidelines/<id>/digest`, `/guidelines/<id>/extracted`, `/health`.

## Logic model step

The logic model is a pathway spec (`schema_version` 1.0): questions, derived values, outcomes, rules (first match by priority) and open questions. Format: `shared/pathway/types.ts`; sample: `shared/pathway/samples/cough_fast_breathing.v1.json`.

`placeholderBuilder` runs no model. It returns that sample spec. Replace it with an AgentCore-backed `LogicModelBuilder` that returns the same format; `buildLogicModel` rejects anything with compiler errors before it is stored. Warnings are kept in the envelope's `diagnostics`.

## Pathway compiler (`shared/pathway`)

Shared by this service and the review UI (no dependencies, plain TypeScript):

- `cond.ts`: condition AST, readable text form (`danger_sign is yes and (fast_breathing is yes or chest_indrawing is yes)`), parser, XPath.
- `analyze.ts`: structural check, then semantics: unknown fields, yes/no vs number operators, derived-value cycles, show conditions that use later questions, duplicate priorities, missing or misplaced `otherwise`, unknown outcomes, unused questions.
- `evaluate.ts`: the interpreter. Hidden questions are unanswered; a comparison on an unanswered field is false; first matching rule wins.
- `compile.ts`: flow graph, XLSForm survey rows, source quotes, boundary-value test patients and threshold mutants.
- `patch.ts`: edits as data (`set`/`unset` by path, `addQ`, `removeQ`).

Tests: `test/pathway.test.ts`.

## Moving to AWS

Swap `LocalObjectStore` for S3 (presigned PUT from the SDK, bucket notification to SQS), `LocalQueue` for SQS (`ReceiveMessage`/`DeleteMessage`, redrive policy), `GuidelineStore` for DynamoDB, and the extract step for Textract. The worker and HTTP API stay the same.
