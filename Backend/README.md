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
   - logic model: `LogicModelBuilder` -> Zod check (`src/pipeline/schema.ts`) -> quote check against the digest -> `logic-models/<id>/logic-model.json`.
4. UI polls `GET /guidelines` for step progress, then reads `GET /guidelines/<id>/logic-model` to start the draft.

Also: `GET /guidelines/<id>`, `/guidelines/<id>/digest`, `/guidelines/<id>/extracted`, `/health`.

## Logic model step

`placeholderBuilder` runs no model. It returns `src/pipeline/templates/logic-model.template.json` (the sample cough pathway) so the review screen works. Replace it with an AgentCore-backed `LogicModelBuilder`; its output is validated against `ModelSchema` before it is stored. `ModelSchema` mirrors `Model` in `Frontend/src/domain/types.ts`; keep them in step.

## Moving to AWS

Swap `LocalObjectStore` for S3 (presigned PUT from the SDK, bucket notification to SQS), `LocalQueue` for SQS (`ReceiveMessage`/`DeleteMessage`, redrive policy), `GuidelineStore` for DynamoDB, and the extract step for Textract. The worker and HTTP API stay the same.
