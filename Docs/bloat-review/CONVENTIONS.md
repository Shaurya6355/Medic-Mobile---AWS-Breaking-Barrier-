# Bloat review: shared conventions (read this first)

Goal: find code, files, dependencies and docs that can be removed, merged or simplified, so the owner can decide what to cut. This is a READ-ONLY review of the repo.

Repo root: /Users/utg1209/vs code/Medic Mobile - AWS Breaking Barrier/Medic-Mobile---AWS-Breaking-Barrier-
Review folder: /private/tmp/claude-501/-Users-utg1209-vs-code-Medic-Mobile---AWS-Breaking-Barrier-Medic-Mobile---AWS-Breaking-Barrier-/bf07da26-9043-4d82-b612-3b02976a7057/scratchpad/bloat-review

## Hard rules
1. NEVER modify, create, move or delete anything inside the repo. No git commands that change state (no add/commit/checkout/stash/reset/clean). No npm install, no builds that write into the repo. Reading, grep, `git ls-files`, `git log`, `wc` are fine.
2. The ONLY file you may write is your own area file: `areas/<NN>-<name>.md` in the review folder. Never edit another agent's file or MASTER.md. Read the other area files that already exist before you add a finding, so you do not repeat one; if a finding belongs to another area, put it in your "Cross-area pointers" section.
3. Other people may be editing the repo while you read (uncommitted changes exist under Backend/). Do not touch them and do not report them as problems.
4. Be evidence-based. "Unused" means you grepped the whole repo (src, tests, scripts, Infra, Dockerfile, CI, package.json scripts, docs) for every way it could be reached (imports, dynamic imports, string references, npm scripts, CLI use, CDK) and found no live caller. State exactly what you searched. If it is only used by tests, say "tests only". If you are not sure, mark confidence LOW instead of guessing.
5. Protect the deployment path. The deployed system is: Backend runtime (Lambda via Docker target `lambda`), Infra CDK stacks, AgentService (optional AgentCore). Anything the Lambda image needs at runtime (see Backend/Dockerfile: dist/, extraction/prepare_input.py, final_prompt.txt, fill_prompt.txt, compiler/template) is NOT removable even if it looks unused. Flag risk accordingly.
6. Do not recommend removing correctness, security or sign-off enforcement (separation of duties, locking, conditional writes) just to cut lines. If something is over-built but protective, say so and mark risk HIGH.
7. No fluff. Every finding must be actionable. Do not pad. If an area is clean, say so briefly. Quality over count.

## What counts as bloat (categories)
- DEAD: code/exports/files/functions/config/env vars with no live caller
- DUP: duplicated logic or near-identical files that could be one
- GEN: generated or demo output committed to git (screenshots, build output, logs, lockfile copies, reports)
- DEP: unused or redundant dependency, devDependency or script
- OVER: over-engineering (abstractions with one user, options nobody sets, layers that only forward)
- TEST: redundant, overlapping or low-value tests; huge fixtures; test helpers used once
- DOC: stale, duplicated or contradictory docs/README text, AI-process notes committed as docs
- PERF: real runtime inefficiency (extra reads/writes, N+1, sequential work that could be parallel, big payloads, cold-start weight, image size). Only with a concrete mechanism.

## Finding format (use exactly this, one block per finding)
```
### <AREA-PREFIX>-<nn>  <short title>
- Category: DEAD | DUP | GEN | DEP | OVER | TEST | DOC | PERF
- Where: <file:line or path(s)>
- Evidence: <what you searched and what you found, with counts/paths>
- Proposed action: <remove | merge into X | gitignore | simplify | keep but note>
- Size: <approx lines / KB saved>
- Risk: SAFE | CHECK | RISKY   (SAFE = nothing references it; CHECK = owner should confirm intent; RISKY = touches runtime/deploy/sign-off)
- Confidence: HIGH | MED | LOW
- Decision: [ ] remove  [ ] keep  [ ] later
```

## Area file layout
```
# Area <NN>: <name>
Scope: <dirs/files you covered>   Not covered: <anything you skipped and why>
Summary: <3 to 6 lines: biggest wins, total estimated savings, overall health>
## Findings
<finding blocks, ordered by size saved, biggest first>
## Looked at and fine
<short list of things you checked that are NOT bloat, so nobody re-checks them>
## Cross-area pointers
<findings that belong to another area, one line each>
```
Finish by writing the file in full, then reply with a 5-line summary only (the doc is the deliverable).

## Area prefixes
01 CORE (Backend runtime) -> `CORE`   02 CHECKS (validation, signoff, logic) -> `CHK`   03 COMPILE (compiler, compile-demo, pipeline-demo, scripts) -> `CMP`
04 TESTS (Backend/tests) -> `TST`   05 REPO (python, extraction, cross-check, root files, claude_team, Docs, fixtures) -> `REPO`   06 PLATFORM (Infra, AgentService, CI, Docker, deps) -> `PLT`
