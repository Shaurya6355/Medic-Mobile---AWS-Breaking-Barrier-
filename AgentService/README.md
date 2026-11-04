# AgentService

Small HTTP service that runs on Amazon Bedrock AgentCore Runtime (HTTP protocol contract) and executes ONE Strands agent call on Bedrock per request. The orchestrator uses it as the "agent step" host instead of calling Bedrock directly. The platform SigV4-authenticates callers, so the service does no auth itself.

Status: NOT verified on real AgentCore Runtime or real Bedrock. Tests use a fake agent factory only; nothing here has been run with AWS credentials.

## Wire contract

Defined once with Zod in `src/contract.ts`.

`POST /invocations` request:

```json
{
  "modelId": "string (1..256)",
  "system": "string (<= 200000 chars)",
  "maxTokens": 1,
  "content": [
    { "type": "text", "text": "..." },
    { "type": "image", "format": "png", "base64": "..." }
  ]
}
```

`maxTokens` is an integer 1..64000; `content` has 1..700 blocks (3 blocks per page plus 2 for the default 200 pages is 602).

Response: always HTTP 200 with an envelope. AgentCore wraps a container 4xx/5xx into an opaque `RuntimeClientError` (HTTP 424), so status codes cannot carry the classification.

- success: `{ "ok": true, "raw": string, "usage": { "inputTokens": number, "outputTokens": number, "modelId": string } }`
- failure: `{ "ok": false, "kind": "transient" | "permanent" | "invalid_request", "message": string }`
  - `transient`: throttling, timeouts, 5xx from Bedrock (same detection as `isTransientBedrockError` in Backend, re-implemented in `src/agent.ts`); the Backend maps it to a retryable error
  - `invalid_request`: schema failure, malformed JSON, invalid base64, body over the limit; the message names paths and codes only
  - `permanent`: anything else
  - `message` is at most 300 chars and never contains request content

`GET /ping` -> 200 `{ "status": "Healthy" }` or `{ "status": "HealthyBusy" }` while a request is in flight. `time_of_last_update` (unix seconds) is included only after an actual status change and is not refreshed per ping.

The agent uses temperature 0, region from `AWS_REGION` (default `us-west-2`), no console printer, and SDK retries disabled (the orchestrator owns retries).

## Payload limit

AWS "Quotas for Amazon Bedrock AgentCore" (AgentCore Runtime, invocation limits) lists maximum request/response payload 100 MB (not adjustable) and a 15 minute synchronous request timeout. Source: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html (read 2026-11-03). The service default `BODY_LIMIT_BYTES` is 90 MiB, below that cap. Limits derive from the page limit: extract sends 3 blocks per page plus 2, `MAX_PAGES` defaults to 200, so content allows 700 blocks; 200 page PNGs of about 300 KB come to roughly 80 MB of base64 (base64 inflates by about 33%). The Backend mirrors these limits in `Backend/src/model/agentcoreWire.ts` and checks them before sending.

## Configuration

See `.env.example`: `AWS_REGION`, `PORT` (default 8080), `BODY_LIMIT_BYTES` (default 94371840, 90 MiB).

## Local run and tests

`tests/wireDrift.test.ts` imports `Backend/src/model/agentcoreWire.ts` and `agentcore.ts` by relative path to catch contract drift, so Backend dependencies must be installed too. The CI `agentservice` job must run `npm ci` in `Backend` as well as in `AgentService`.

```
npm install
npm test
npx tsc --noEmit
npm run build
PORT=8080 npm start        # needs AWS credentials in the environment to actually call Bedrock
curl localhost:8080/ping
```

## Build for AgentCore (ARM64)

```
docker buildx build --platform linux/arm64 -t agent-service:latest .
```

The image is multi-stage on `node:22-slim`, runs as `USER node`, and listens on `0.0.0.0:8080`. No Python or poppler is needed. Push to ECR and reference the image URI when creating the AgentCore runtime (image limit 2 GB).

## IAM

The runtime execution role needs `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the foundation model ARN(s) and, if using a cross-region inference profile, on the inference profile ARN as well as the underlying models in each routed region.
