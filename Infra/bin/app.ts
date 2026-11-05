#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";
import { OrchestratorLambdaStack } from "../lib/lambda-stack";
import { OrchestratorAgentCoreStack } from "../lib/agentcore-stack";
import { OrchestratorDataStack, PROJECT_TAG_KEY, PROJECT_TAG_VALUE } from "../lib/data-stack";
import { OrchestratorWebStack } from "../lib/web-stack";

const app = new App();
// CDK_DEFAULT_REGION is deliberately ignored: the CDK CLI sets it from the active profile and falls
// back to us-east-1 when none is configured, which would silently put the stack outside the project
// region. Resolution order: `-c region=...`, AWS_REGION, then us-west-2.
const region =
  (app.node.tryGetContext("region") as string | undefined) ??
  process.env.AWS_REGION ??
  "us-west-2";
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region };
const data = new OrchestratorDataStack(app, "OrchestratorDataStack", { env });
const modelBackend = (app.node.tryGetContext("modelBackend") as string | undefined) ?? "bedrock";
// AgentCore is opt-in (not organiser-approved yet, DEC-008): the default deploy never creates it.
const agentCore = modelBackend === "agentcore" ? new OrchestratorAgentCoreStack(app, "OrchestratorAgentCoreStack", { env }) : undefined;
new OrchestratorLambdaStack(app, "OrchestratorLambdaStack", {
  env,
  runsTable: data.runsTable,
  stepsTable: data.stepsTable,
  versionsTable: data.versionsTable,
  commentsTable: data.commentsTable,
  auditTable: data.auditTable,
  artifactBucket: data.artifactBucket,
  uploadQueue: data.uploadQueue,
  uploadDlq: data.uploadDlq,
  appPolicy: data.appPolicy,
  bedrockPolicy: data.bedrockPolicy,
  agentCoreRuntimeArn: agentCore?.runtimeArn,
});
new OrchestratorWebStack(app, "OrchestratorWebStack", {
  env,
  // A plain string, not lambda.httpApi.attrApiEndpoint: a cross-stack reference locks the API (it cannot be
  // replaced while the web stack imports its URL). The frontend gets the URL from VITE_API_URL at build time.
  apiUrl: (app.node.tryGetContext("apiUrl") as string | undefined) ?? "See the APIURL output of OrchestratorLambdaStack",
});
Tags.of(app).add(PROJECT_TAG_KEY, PROJECT_TAG_VALUE);
