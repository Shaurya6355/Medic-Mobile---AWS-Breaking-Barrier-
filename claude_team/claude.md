# claude.md - Master Instructions

This is the master file. Every team member's Claude reads this file first, on every laptop, so all local systems behave the same way. It links to the other files in this folder. Read them in the order given under "Session start".

Project: No-Code CHT Configuration (Medic, AWS Breaking Barriers 2026, November 3 to 5).
Source of truth for scope and tech: the Technical Environment Document and the Vision Document (see "Reference documents").

## Hard rules

1. Never use emoji. This applies to every file, commit message, code comment, log line and chat reply.
2. Never work out of scope. Scope is defined in the "Scope" section below. If a request falls outside it, stop and ask the human first, and record the answer in decisions.md.
3. Never put secrets, credentials, or personal data in any file in this repository. Synthetic or public data only.
4. Never overwrite another person's entries in the shared files. Append only, except where a status field is updated.
5. Git access is pull only. Claude may run `git pull` and read-only git commands (status, log, diff). Claude must never run `git push` (including force push or pushing tags and branches), and must never push env files, code, or any other content. Pushing is done by a human. Claude does not commit unless the human asks.
6. Never commit env files or credentials (`.env`, key files, AWS config). Keep them out of the repository.

## Session start (every session, every laptop)

1. Run `git pull` before doing anything.
2. Read [integration.md](integration.md) to learn the current state of every system and what others changed. This is the most important shared file.
3. Read [decisions.md](decisions.md) so you do not reopen a settled decision or contradict an assumption.
4. Read [errors.md](errors.md) to see pending errors and avoid repeating fixed ones.
5. Read [artifacts.md](artifacts.md) to see which mock ups and artifacts exist and where.

@integration.md
@decisions.md

## Session end (every session, every laptop)

1. Append your work to integration.md (what you built, which system, what others must do).
2. Record any new decision or assumption in decisions.md.
3. Record any error found or fixed in errors.md, marking who fixed it (human or agent).
4. Record any new mock up or artifact in artifacts.md.
5. Do not push. Tell the human which files changed and let them review, commit and push.

## The shared files

| File | Purpose | Who updates it |
|------|---------|----------------|
| claude.md | Master rules and links. Keeps all laptops uniform. | Rarely; agree with the team before changing |
| integration.md | Current state of each system and a log of each person's work. Used by every Claude across the team. | Everyone, after each unit of work |
| decisions.md | Features, the assumption behind each, why, and the other options considered. | Whoever makes or discovers a decision |
| errors.md | Pending and fixed errors, with whether a human or an agent fixed each. | Whoever finds or fixes an error |
| artifacts.md | Description of every mock up or artifact built on a local system. | Whoever creates the artifact |

## Scope

In scope (from the Technical Environment Document):

- A pipeline that turns a guideline into CHT configuration that builds with cht-conf: logic drafting on Amazon Bedrock, deterministic validators, human approval steps, a deterministic compiler, a build-and-test step, and reports.
- Medic's tools: cht-conf, cht-conf-test-harness, test-data-generator, cht-ai-tools, and cht-ui-builder if the Reference path is chosen.
- AWS services listed in the document: EC2, ECR, Bedrock, Textract, S3, DynamoDB, Systems Manager, Secrets Manager, CloudWatch, and the optional ones named there.
- Languages: TypeScript, JavaScript on Node.js 22, XLSForm. Python 3.10 or later, Terraform (HCL) and Bash only under the conditions in the document.

Out of scope:

- Anything not named above. When unsure, ask.
- Model training or hosting, relational databases, AWS Fargate, Elastic Beanstalk, SageMaker, Kinesis, and MSK. (Lambda for application logic was out of scope but is now allowed; organisers confirmed, see DEC-010.)
- Model calls that bypass Amazon Bedrock.
- Real patient data or real CHT credentials.
- Anything generative running on a health worker's phone.

Open question: Reference path (build on cht-ui-builder) or Open path (own tools). Tracked as DEC-001 in decisions.md. Until it is decided, do not commit to either path.

## Design rules every change must respect

1. Models never write compiled configuration. Deterministic code compiles approved logic. Model-proposed edits are structured, schema-checked proposals that code applies.
2. Every change gets two human approvals: content before the release build, and deploy before upload. Clinical changes need a clinician.
3. AI drafts and hand edits take the same path and the same checks.
4. Approval binds to one exact, versioned snapshot of the logic, never to a conversation.
5. The approver's view comes from the same model the compiler uses.
6. Expected test outcomes come from the approved logic. A model never judges a test.
7. Ambiguity is flagged for a person, never resolved silently.
8. Synthetic data only: no personal data in prompts and no real CHT credentials.
9. Nothing generative runs on a health worker's phone.
10. Output is standard CHT configuration that builds with cht-conf, and every change is reversible.

## Technical standards

- Cloud: AWS, region us-west-2, Claude models through `us.` cross-region inference profiles. Budget is $500 per sandbox; use the smallest model that does each job.
- Compute: containers on EC2, defined in code. Never install tools on an instance by hand.
- Model access: Amazon Bedrock only. Claude Code on Bedrock uses `CLAUDE_CODE_USE_BEDROCK=1` and `AWS_REGION=us-west-2`.
- Infrastructure as code: Terraform or CDK in TypeScript, one configuration, no hard-coded ARNs or account IDs.
- Infrastructure code is part of every change: whenever work adds or alters an AWS resource, an environment variable, or an IAM permission the application needs, write or update the matching code in `Infra/` (CDK, TypeScript) in the same piece of work, keep its README and the Backend env table in step, and run its tests and `cdk synth`. Never leave the app depending on a resource that exists only in the console. Tracked as DEC-009.
- Validate every model output against a schema (Zod or Ajv) before it drives the next step.
- Edit existing XLSForm workbooks by cell (ExcelJS or openpyxl). Never regenerate a workbook wholesale.
- Monitor every pipeline process (extraction, drafting, validation, compile, build-and-test): record token usage (input and output), running cost, and latency per process and per run, tied to the run and snapshot ID. Store the records (CloudWatch and/or DynamoDB) and report cost per pathway run in the README. Tracked as DEC-003.
- Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- Tag every AWS resource with the project tag.

## Working conventions

- Be concise in files and replies. Plain text, no decoration.
- Give every entry in the shared files an ID, a date (YYYY-MM-DD), and an owner.
- One concern per commit when a human asks for a commit. Keep shared-file updates separate from code where practical.
- If a rule here conflicts with a request, follow this file and tell the human.

## Reference documents

- Technical Environment Document: No-Code CHT Configuration (currently at `~/Documents/Medic Mobile/technical-environment-document-no-code-cht-configuration.md`, outside this repository).
- Vision Document: No-Code CHT Configuration (companion to the above).
- Team decision needed: copy these into the repository so every laptop has them. Tracked as DEC-002 in decisions.md.
