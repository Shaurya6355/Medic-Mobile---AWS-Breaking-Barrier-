# Area 06: Platform
Scope: Infra/ (lib, bin, test, cdk.json, package.json), AgentService/ (src, tests, Dockerfile, package.json), .github/workflows/ci.yml, Backend/Dockerfile, Backend/.dockerignore, dependency audit of the three package.json files.
Not covered: no docker builds or npm installs (rule 1); image sizes are estimates from node_modules sizes in the local Backend install. Other area files did not exist when I wrote this.
Summary: Biggest real win is the Docker build context (.dockerignore uses root-only `node_modules`, so ~456 MB of nested compile-demo node_modules is sent to the daemon on every build, local and CDK asset hash). Second is CI: the Backend job installs and tests twice, and docker builds three images with QEMU. The AgentCore option totals about 1,320 lines of code and tests (plus 3,100 lockfile lines) for a path that is off by default. Dependencies are mostly clean: exceljs and jszip are live in the Lambda (sign-off compile check). Image weight is dominated by node_modules (about 203 MB dev+prod local; prod-only is smaller) and apt poppler and python3 (needed).

## Findings

### PLT-01  .dockerignore misses nested node_modules and demo folders: ~456 MB build context
- Category: PERF
- Where: Backend/.dockerignore (lines: node_modules, dist, tests, extraction/pages, extraction/*.json, extraction/flow.html, .env*); consumed by Infra/lib/lambda-stack.ts:107 (DockerImageCode.fromImageAsset on Backend) and CI docker job (context: Backend)
- Evidence: Docker `.dockerignore` patterns are rooted at the context, so `node_modules` ignores only Backend/node_modules. Local du: compile-demo/preview/node_modules 243 MB and compile-demo/tools/node_modules 213 MB (both gitignored, so absent in CI, but present on any dev machine running `cdk deploy`). Also sent: compile-demo/output 7.2 MB, pipeline-demo 272 KB, cross-check 124 KB, scripts, validation, README. The Dockerfile only COPYs package.json, package-lock.json, tsconfig*.json, src, and four extraction files. CDK also hashes the whole non-ignored directory to compute the asset fingerprint, so these files slow synth and can change the image hash.
- Proposed action: simplify. Add `**/node_modules`, `compile-demo`, `pipeline-demo`, `cross-check`, `validation`, `scripts`, `*.md`, `Dockerfile`, `.dockerignore`, `extraction/*.png`. (Keep extraction/prepare_input.py, final_prompt.txt, fill_prompt.txt; do not ignore `extraction` wholesale.) No image content changes because the Dockerfile COPYs are explicit.
- Size: build context about 456 MB down to under 5 MB on dev machines (CI unaffected)
- Risk: CHECK (verify the four extraction files and src/compiler/template still arrive; src is not ignored)
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### PLT-02  AgentCore option: total carried code (summary for owner decision)
- Category: OVER
- Where: Backend/src/model/agentcore.ts (150), agentcoreWire.ts (42), Backend/tests/model/agentcore.test.ts (202); AgentService/src (index 31, contract 49, server 81, agent 98 = 259), AgentService/tests (agent 74, contract 49, server 117, wireDrift 91 = 331), AgentService/Dockerfile 26, README 71, package.json 26, package-lock.json 3102; Infra/lib/agentcore-stack.ts 147, Infra/test/agentcore-stack.test.ts 189; plus branches in Infra/lib/lambda-stack.ts (agentCoreRuntimeArn prop, lines 54, 73-74, 98, 119-128), Infra/bin/app.ts (3 lines), Backend/src/index.ts:13,42-44, Backend config.ts/api server.ts/background.ts/contract schemas.ts (about 16 mentions), Infra data-stack.ts bedrockPolicy split (comment line 176), and CI: agentservice job (about 25 lines), second `cdk synth -c modelBackend=agentcore` step, third docker build (arm64 AgentService).
- Evidence: `grep -rli "agentcore"` over Backend/src, Infra/lib, Infra/bin, Infra/test, AgentService, ci.yml. Default MODEL_BACKEND is bedrock (Infra/bin/app.ts:16: opt-in, "not organiser-approved yet, DEC-008"). Default deploy never creates the stack. Only Backend/tests/model/agentcore.test.ts, AgentService tests and Infra tests exercise it.
- Totals: code+tests about 1,320 lines (Backend 394, AgentService 590 incl. tests, Infra 336), plus about 220 lines of docs/Dockerfile/package, plus 3,102 lockfile lines, plus about 40 lines of branching in shared files and CI. Dependencies tied to it: @aws-sdk/client-bedrock-agentcore (2.6 MB, Backend prod dep, only agentcore.ts imports it), and the whole AgentService package (130 MB node_modules locally). @strands-agents/sdk (7.9 MB) is NOT removable with this option because the default bedrock path (Backend/src/model/strands.ts) uses it too.
- Proposed action: keep but note, or owner decision. If dropped: delete the listed files and branches (git history keeps them). If kept: apply PLT-03, PLT-05 to cut its cost to near zero for the default deploy.
- Size: about 1,320 code/test lines plus 3,100 lockfile lines removable in one commit
- Risk: CHECK (DEC-008 may still want it as a fallback; wireDrift is the only test tying both sides' wire contracts together)
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### PLT-03  Both model clients imported eagerly in the Lambda entry
- Category: PERF
- Where: Backend/src/index.ts:13-14 (static imports), used at 42-44; Backend/src/model/agentcore.ts:2, strands.ts:1
- Evidence: `grep -rnE "import\(" Backend/src` finds no dynamic import of either model client; both are top-level `import`. So with MODEL_BACKEND=bedrock the Lambda still loads @aws-sdk/client-bedrock-agentcore (2.6 MB on disk, its module graph parsed at cold start) and with agentcore it still loads @strands-agents/sdk (7.9 MB plus its transitive deps). Both are module-evaluation costs on every cold start; I did not measure ms.
- Proposed action: simplify. Use `await import("./model/strands.js")` / `agentcore.js` inside the ternary in index.ts (main is already async-capable). Only the chosen client loads.
- Size: about 2 to 8 MB of JS not parsed per cold start; 0 lines (3-line change)
- Risk: CHECK (runtime entry; tests that mock these modules must still pass)
- Confidence: MED (cost size is estimated, not benchmarked)
- Decision: [ ] remove  [ ] keep  [ ] later

### PLT-04  CI: Backend installed and tested twice; AgentService job duplicates Backend setup
- Category: DUP
- Where: .github/workflows/ci.yml jobs `backend` and `agentservice` (lines 13-46)
- Evidence: `agentservice` runs `npm ci` in Backend (needed by AgentService/tests/wireDrift.test.ts, which imports ../../Backend/src/model/agentcore.js) then `npm ci`, tsc, test, build again in AgentService. Backend gets a second npm ci (about 200 MB) just so one drift test can import two source files. The backend job already runs Backend tests.
- Proposed action: simplify. If AgentCore is kept, merge agentservice into the backend job as extra steps (shares the Backend install and checkout), or move wireDrift into the Backend job. If AgentCore is dropped (PLT-02), the job disappears.
- Size: about 25 workflow lines; one fewer runner and one npm ci of Backend per CI run
- Risk: SAFE
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### PLT-05  CI docker job: three builds, two with QEMU, the first two share most layers
- Category: PERF
- Where: .github/workflows/ci.yml docker job (lines 78-109)
- Evidence: Build 1 (Backend default target, amd64+arm64), build 2 (Backend `--target lambda`, arm64), build 3 (AgentService arm64). Builds 1 and 2 share the same `runtime` stage; build 2's arm64 leg repeats build 1's arm64 leg but with separate cache scope (`container` vs `lambda`), so the shared stages are cached twice rather than reused. QEMU arm64 apt-get/npm ci is the slowest step in the workflow. Docker build checks only that the image builds; nothing runs it.
- Proposed action: simplify. Build once with `target: lambda` on linux/arm64 (the stage that deploys; it contains runtime) and use a shared cache scope; build `container` for amd64 only (no QEMU) if the generic container target needs a smoke check. Drop build 3 with PLT-02.
- Size: about 12 workflow lines; likely 5 to 10 minutes of CI time (estimate)
- Risk: CHECK (the multi-arch comment in the Dockerfile claims arm64 for AgentCore; AgentService build is only needed if that option stays)
- Confidence: MED
- Decision: [ ] remove  [ ] keep  [ ] later

### PLT-06  Infra README and DEPLOY_CHECKLIST overlap; AgentCore stack docs
- Category: DOC
- Where: Infra/README.md (130 lines), Infra/DEPLOY_CHECKLIST.md (35), AgentService/README.md (71), plus the root "deployment doc" commit
- Evidence: not fully diffed; flagged for the docs reviewer. I did not read them line by line.
- Proposed action: keep but note
- Size: unknown
- Risk: SAFE
- Confidence: LOW
- Decision: [ ] remove  [ ] keep  [ ] later

### PLT-07  Duplicated constants between Backend and Infra
- Category: DUP
- Where: Infra/lib/lambda-stack.ts:25-39 (API_ROUTES, 13 entries) vs Backend/src/contract/routes.ts; Infra/lib/data-stack.ts:11 DEFAULT_MODEL_ID vs Backend config (reads MODEL_ID env, no default) ; Infra data-stack.ts:17 VISIBILITY_TIMEOUT 5400 vs Backend/src/trigger/queueConsumer.ts:28 default 900
- Evidence: API_ROUTES is deliberately mirrored and guarded by Infra/test/lambda-stack.test.ts (comment at lambda-stack.ts:21-23), because Infra cannot import Backend. Model id lives only in Infra (default) with Backend requiring the env var, so not a real duplicate. The queueConsumer 900 default is a standalone fallback; the deployed value is 5400 set by Infra (the Backend extends visibility itself, line 70). Mild mismatch, not bloat.
- Proposed action: keep but note. The route list duplication is protective (public API surface allow-list; test guards drift). Do not merge.
- Size: 0
- Risk: RISKY (public API surface, IAM/route scoping)
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### PLT-08  Dev-only tooling inside the production image build context: `dist` includes template copy only
- Category: PERF
- Where: Backend/Dockerfile build stage, `npm run build`
- Evidence: runtime stage copies only deps node_modules, dist, package.json, and four extraction files. No tests, demos, compile-demo or scripts reach the image (checked every COPY). The `build` and `deps` stages use separate `npm ci` runs (two installs of the dependency tree, one of them full dev); this is standard and cached. Nothing to cut here other than PLT-01.
- Proposed action: keep but note
- Size: 0
- Risk: SAFE
- Confidence: HIGH
- Decision: [ ] remove  [ ] keep  [ ] later

### PLT-09  Infra test overlap
- Category: TEST
- Where: Infra/test/data-stack.test.ts (263 lines), lambda-stack.test.ts (174), agentcore-stack.test.ts (189)
- Evidence: Tests are CDK template assertions; the VisibilityTimeout 5400 test exists once (data-stack.test.ts:131) and route test once. No obvious duplicate assertions found in a skim; not read line by line. agentcore-stack.test.ts (189 lines) is the only block tied to PLT-02.
- Proposed action: keep but note (agentcore test goes with PLT-02 if dropped)
- Size: 189 lines tied to PLT-02
- Risk: CHECK
- Confidence: LOW
- Decision: [ ] remove  [ ] keep  [ ] later

## Looked at and fine
- exceljs (22 MB) and jszip (1 MB): used only by Backend/src/compiler/xlsx.ts (and tests/compiler/xlsx.test.ts). xlsx.ts is reached from the Lambda via compiler/index.ts and compileSnapshot, which are imported by src/validation/checks/compileReady.ts and src/signoff/*. So they ship in the Lambda image legitimately. Not removable.
- @strands-agents/sdk is the default (bedrock) model path (src/model/strands.ts); not removable. AgentService also depends on it separately.
- Backend devDependencies (tsx, vitest, typescript, @types/*, aws-sdk-client-mock): tsx is used by npm scripts dev/compile:demo/pipeline:demo; aws-sdk-client-mock is used by tests. @types/aws-lambda not grepped deeply; low value either way (LOW).
- Backend production deps: dynamodb, lib-dynamodb, s3, s3-request-presigner, sqs, fastify, zod all imported in src.
- Infra deps: aws-cdk-lib, constructs, ts-node (cdk.json app command), aws-cdk CLI, vitest: all used. Two managed policies (app vs bedrock) are an intentional split so the Lambda role can omit Bedrock under agentcore; keep (IAM scoping).
- Backend Dockerfile: poppler-utils and python3 are required by ingest (prepare_input.py, pdftoppm/pdftotext). The `container` and `lambda` targets are both used (CI and CDK). Final image: node:22-slim base about 200 MB plus poppler/python about 80 to 100 MB plus prod node_modules (about 150 MB with exceljs 22, aws-sdk 19+smithy 7, strands 8, fastify, zod) gives an estimated 450 to 500 MB uncompressed; no unused COPYs.
- CI infra job runs `cdk synth` and `cdk synth -c modelBackend=agentcore`; the second is only needed if the AgentCore stack stays.
- Infra package.json pins exact versions (fine). AgentService package-lock (3,102 lines) is a lockfile, normal.

## Cross-area pointers
- Backend/compile-demo node_modules (243 MB + 213 MB, untracked) and compile-demo/output (7.2 MB, 83 tracked demo files, uncommitted deletes in progress): see COMPILE area for gitignore of output/screenshots; PLT-01 is the Docker-side fix.
- Backend/tests/model/agentcore.test.ts (202 lines) belongs to TESTS but is counted in PLT-02.
