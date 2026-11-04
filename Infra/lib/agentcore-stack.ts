import { ArnFormat, Aws, CfnOutput, Stack, StackProps, Tags } from "aws-cdk-lib";
import * as bedrockagentcore from "aws-cdk-lib/aws-bedrockagentcore";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import * as path from "node:path";
import { baseModelId, DEFAULT_MODEL_ID, PROJECT_TAG_KEY, PROJECT_TAG_VALUE } from "./data-stack";

// Pattern [a-zA-Z][a-zA-Z0-9_]{0,47}: no hyphens allowed. A fixed name would block CloudFormation
// replacement (the new runtime is created before the old one is deleted), so the name carries a short
// hash of the stack's construct path: stable per stack, different between stacks.
export const AGENT_RUNTIME_NAME_PREFIX = "orchestrator_agent_";

// Hosts ../AgentService on Amazon Bedrock AgentCore Runtime. Only created when the context flag
// modelBackend=agentcore (bin/app.ts). Unverified on real AWS; AgentCore is not organiser-approved yet.
export class OrchestratorAgentCoreStack extends Stack {
  public readonly runtime: bedrockagentcore.CfnRuntime;
  public readonly runtimeArn: string;
  public readonly runtimeId: string;
  public readonly imageAsset: DockerImageAsset;
  public readonly executionRole: iam.Role;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const ctxModel = this.node.tryGetContext("modelId") as unknown;
    const modelId = typeof ctxModel === "string" && ctxModel !== "" ? ctxModel : DEFAULT_MODEL_ID;

    // AgentCore Runtime requires ARM64. Building needs a Docker daemon at deploy time, not at synth.
    const agentRuntimeName = `${AGENT_RUNTIME_NAME_PREFIX}${this.node.addr.slice(0, 8)}`;

    this.imageAsset = new DockerImageAsset(this, "AgentImage", {
      directory: path.join(__dirname, "..", "..", "AgentService"),
      platform: Platform.LINUX_ARM64,
      exclude: ["node_modules", "dist", "tests"],
    });

    this.executionRole = new iam.Role(this, "ExecutionRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID },
          ArnLike: { "aws:SourceArn": this.formatArn({ service: "bedrock-agentcore", resource: "*", account: Aws.ACCOUNT_ID }) },
        },
      }),
    });
    const role = this.executionRole;
    const agcArn = (resource: string, resourceName?: string): string =>
      this.formatArn({ service: "bedrock-agentcore", resource, resourceName, account: Aws.ACCOUNT_ID });
    const logGroupPrefix = this.formatArn({
      service: "logs",
      resource: "log-group",
      resourceName: "/aws/bedrock-agentcore/runtimes/*",
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    this.imageAsset.repository.grantPull(role);
    // grantPull adds ecr:GetAuthorizationToken on "*" (required: it does not support resource scoping).

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "RuntimeLogGroups",
        actions: ["logs:DescribeLogStreams", "logs:CreateLogGroup"],
        resources: [logGroupPrefix],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "RuntimeLogStreams",
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [`${logGroupPrefix}:log-stream:*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DescribeLogGroups",
        actions: ["logs:DescribeLogGroups"],
        // Docs require log-group:* for DescribeLogGroups (the action is not resource-scopable by name prefix).
        resources: [this.formatArn({ service: "logs", resource: "log-group", resourceName: "*" })],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "XRayTracing",
        actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"],
        // X-Ray write actions do not support resource-level permissions; the AgentCore docs use "*".
        resources: ["*"],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "RuntimeMetrics",
        actions: ["cloudwatch:PutMetricData"],
        // PutMetricData has no resource scoping; restricted by namespace condition as in the docs.
        resources: ["*"],
        conditions: { StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WorkloadIdentityTokens",
        // GetWorkloadAccessTokenForUserId is omitted: it issues tokens for caller-supplied user ids
        // without IdP verification, and the agent has no user identity flow.
        actions: ["bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT"],
        resources: [
          agcArn("workload-identity-directory", "default"),
          agcArn("workload-identity-directory", `default/workload-identity/${agentRuntimeName}-*`),
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "BedrockInvoke",
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [
          this.formatArn({
            service: "bedrock",
            resource: "inference-profile",
            resourceName: modelId,
            account: Aws.ACCOUNT_ID,
          }),
          // Cross-region inference routes to the foundation model in any US region, hence the wildcard.
          `arn:${Aws.PARTITION}:bedrock:*::foundation-model/${baseModelId(modelId)}`,
        ],
      }),
    );

    this.runtime = new bedrockagentcore.CfnRuntime(this, "AgentRuntime", {
      agentRuntimeName,
      agentRuntimeArtifact: { containerConfiguration: { containerUri: this.imageAsset.imageUri } },
      roleArn: role.roleArn,
      networkConfiguration: { networkMode: "PUBLIC" },
      protocolConfiguration: "HTTP",
      environmentVariables: { AWS_REGION: this.region, MODEL_ID: modelId },
      tags: { [PROJECT_TAG_KEY]: PROJECT_TAG_VALUE },
    });
    // The policy must exist before AgentCore validates the role and pulls the image.
    this.runtime.node.addDependency(role);

    this.runtimeArn = this.runtime.attrAgentRuntimeArn;
    this.runtimeId = this.runtime.attrAgentRuntimeId;

    new CfnOutput(this, "RUNTIMEARN", { value: this.runtimeArn, description: "AGENTCORE_RUNTIME_ARN" });
    new CfnOutput(this, "RUNTIMEID", { value: this.runtimeId, description: "AgentCore runtime id" });

    Tags.of(this).add(PROJECT_TAG_KEY, PROJECT_TAG_VALUE);
  }
}
