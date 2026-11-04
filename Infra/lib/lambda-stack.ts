import { ArnFormat, CfnOutput, Duration, Size, Stack, StackProps, Tags } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import * as path from "node:path";
import { DEFAULT_MODEL_ID, PROJECT_TAG_KEY, PROJECT_TAG_VALUE, resolveUiOrigins } from "./data-stack";

// Lambda hard limit is 15 minutes. LEASE_MS must exceed it so a live invocation is never taken over.
const FUNCTION_TIMEOUT = Duration.minutes(15);
const LEASE_MS = 960000;
// API Gateway HTTP APIs cut an integration at 30 seconds (the maximum; it cannot be raised).
const API_INTEGRATION_TIMEOUT_MS = 30000;

// Public contract routes (Backend/src/contract/routes.ts, `proxiable`), one explicit entry per
// method + path. Never add /events, /invocations or /ping, and never a catch-all: the API has no
// authentication and /events is the unauthenticated Lambda pass-through. test/lambda-stack.test.ts
// compares this list with the contract.
export const API_ROUTES: readonly string[] = [
  "POST /runs",
  "GET /runs",
  "GET /runs/{id}",
  "GET /runs/{id}/versions",
  "POST /runs/{id}/versions",
  "GET /runs/{id}/versions/{n}",
  "GET /runs/{id}/versions/{n}/comments",
  "POST /runs/{id}/versions/{n}/comments",
  // Sign-off (DEC-019). Role and user come from the body until Cognito (DEC-015) adds an authorizer.
  "GET /runs/{id}/versions/{n}/findings",
  "GET /runs/{id}/versions/{n}/status",
  "POST /runs/{id}/versions/{n}/signatures/{role}",
  // The clinician's rejection with a comment (AR-06, RR-02; DEC-020). Same DynamoDB actions as a signature.
  "POST /runs/{id}/versions/{n}/reject",
  // Revision loop (DEC-025): comments -> AI instruction -> confirmed -> new version. Revisions are S3
  // artifacts under runs/<id>/revisions/, covered by the existing object policy. Same auth seam as sign-off.
  "POST /runs/{id}/versions/{n}/revisions",
  "GET /runs/{id}/versions/{n}/revisions",
  "GET /runs/{id}/revisions/{rid}",
  "POST /runs/{id}/revisions/{rid}/confirm",
  "POST /runs/{id}/resume",
];

export interface OrchestratorLambdaStackProps extends StackProps {
  runsTable: dynamodb.ITable;
  stepsTable: dynamodb.ITable;
  versionsTable: dynamodb.ITable;
  commentsTable: dynamodb.ITable;
  auditTable: dynamodb.ITable;
  artifactBucket: s3.IBucket;
  uploadQueue: sqs.IQueue;
  appPolicy: iam.IManagedPolicy;
  // Direct Bedrock invoke. Required (and attached) only when modelBackend=bedrock.
  bedrockPolicy?: iam.IManagedPolicy;
  // Required when context modelBackend=agentcore (bin/app.ts passes the AgentCore stack's runtime ARN).
  agentCoreRuntimeArn?: string;
}

export class OrchestratorLambdaStack extends Stack {
  public readonly function: lambda.DockerImageFunction;
  public readonly httpApi: apigwv2.CfnApi;

  constructor(scope: Construct, id: string, props: OrchestratorLambdaStackProps) {
    super(scope, id, props);

    const uiOrigins = resolveUiOrigins(this.node.tryGetContext("uiOrigins"));
    const ctxModel = this.node.tryGetContext("modelId") as unknown;
    const modelId = typeof ctxModel === "string" && ctxModel !== "" ? ctxModel : DEFAULT_MODEL_ID;
    const ctxBackend = this.node.tryGetContext("modelBackend") as unknown;
    const modelBackend = ctxBackend === undefined || ctxBackend === null || ctxBackend === "" ? "bedrock" : ctxBackend;
    if (modelBackend !== "bedrock" && modelBackend !== "agentcore") {
      throw new Error('context modelBackend must be "bedrock" or "agentcore"');
    }
    if (modelBackend === "agentcore" && !props.agentCoreRuntimeArn) {
      throw new Error("modelBackend=agentcore requires props.agentCoreRuntimeArn");
    }
    if (modelBackend === "bedrock" && !props.bedrockPolicy) {
      throw new Error("modelBackend=bedrock requires props.bedrockPolicy");
    }
    const ctxPrices = this.node.tryGetContext("prices") as unknown;
    const ctxBudget = this.node.tryGetContext("runBudgetUsd") as unknown;

    const logGroup = new logs.LogGroup(this, "FunctionLogs", { retention: logs.RetentionDays.TWO_WEEKS });

    const environment: Record<string, string> = {
      RUN_MODE: "lambda",
      TABLE_RUNS: props.runsTable.tableName,
      TABLE_STEPS: props.stepsTable.tableName,
      TABLE_VERSIONS: props.versionsTable.tableName,
      TABLE_COMMENTS: props.commentsTable.tableName,
      TABLE_AUDIT: props.auditTable.tableName,
      ARTIFACT_BUCKET: props.artifactBucket.bucketName,
      MODEL_ID: modelId,
      LEASE_MS: String(LEASE_MS),
      // The image filesystem is read-only except /tmp; ingest uses os.tmpdir() for page images.
      TMPDIR: "/tmp",
    };
    if (modelBackend === "agentcore") {
      environment.MODEL_BACKEND = "agentcore";
      environment.AGENTCORE_RUNTIME_ARN = props.agentCoreRuntimeArn!;
    }
    if (ctxPrices !== undefined && ctxPrices !== null && ctxPrices !== "") {
      environment.PRICES_JSON = typeof ctxPrices === "string" ? ctxPrices : JSON.stringify(ctxPrices);
    }

    // Optional cap on the recorded cost of one run (Backend RUN_BUDGET_USD).
    if (ctxBudget !== undefined && ctxBudget !== null && ctxBudget !== "") {
      const budget = Number(ctxBudget);
      if (!Number.isFinite(budget) || budget <= 0) throw new Error(`context runBudgetUsd must be a positive number, got ${String(ctxBudget)}`);
      environment.RUN_BUDGET_USD = String(budget);
    }

    // Physical name, so the function can be granted permission on its own ARN as a plain string.
    // Granting via this.function.functionArn would make role -> policy -> function -> role circular.
    const functionName = `${this.stackName}-orchestrator`;
    const ownArn = this.formatArn({
      service: "lambda",
      resource: "function",
      resourceName: functionName,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    // AWS_REGION is set by the Lambda runtime. UPLOAD_QUEUE_URL is not needed in lambda mode: the
    // event source mapping delivers the messages.
    this.function = new lambda.DockerImageFunction(this, "OrchestratorFunction", {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, "..", "..", "Backend"), {
        target: "lambda",
        platform: Platform.LINUX_ARM64,
      }),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 2048,
      ephemeralStorageSize: Size.mebibytes(2048),
      functionName,
      timeout: FUNCTION_TIMEOUT,
      logGroup,
      environment,
    });
    this.function.role!.addManagedPolicy(props.appPolicy);
    // With AgentCore the Lambda never calls Bedrock itself, so it gets no model invoke permission.
    if (modelBackend === "bedrock") this.function.role!.addManagedPolicy(props.bedrockPolicy!);

    // Revision loop (DEC-025): POST /runs/{id}/revisions/{rid}/confirm answers 202 at once because the
    // proposal call to Bedrock (step 2) can take longer than the 30 s API Gateway limit. In lambda mode
    // the function freezes after responding, so the app invokes ITSELF asynchronously (InvocationType
    // Event, payload {"source":"revision",...}); the Web Adapter forwards it to POST /events and the UI
    // polls GET /runs/{id}/revisions/{rid}. Step 1 (instruction from comments) stays synchronous: its
    // prompt is small and fits well inside 30 s. One action, one function, no wildcard.
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "InvokeSelfAsync",
        actions: ["lambda:InvokeFunction"],
        resources: [ownArn],
      }),
    );
    // Async invoke retries: the worker is idempotent, but each retry may repeat a paid Bedrock call, so
    // no automatic retry. A failed worker leaves the revision unfinished; applying older than 10 minutes
    // is reported failed and the UI can start again. (Also applies to the 5 minute schedule, which just
    // fires again.) Event age is left at the default.
    new lambda.EventInvokeConfig(this, "AsyncInvokeConfig", {
      function: this.function,
      retryAttempts: 0,
    });

    if (modelBackend === "agentcore") {
      // IAM resource types for InvokeAgentRuntime: the runtime and its endpoints (DEFAULT or named).
      this.function.addToRolePolicy(
        new iam.PolicyStatement({
          sid: "InvokeAgentRuntime",
          actions: ["bedrock-agentcore:InvokeAgentRuntime"],
          resources: [props.agentCoreRuntimeArn!, `${props.agentCoreRuntimeArn!}/runtime-endpoint/*`],
        }),
      );
    }

    // The queue visibility timeout (5400 s, data stack) is 6x the function timeout, as AWS recommends.
    // Recovery of a cut-off run does not wait for it: the 5 minute schedule below resumes it. A duplicate
    // delivery is harmless: the engine ignores a start for a run no longer `created` and the DynamoDB
    // lease prevents two invocations advancing one run.
    this.function.addEventSource(
      new SqsEventSource(props.uploadQueue as sqs.Queue, {
        batchSize: 1,
        reportBatchItemFailures: true,
        maxConcurrency: 5,
      }),
    );

    // Recovery sweep: lambda mode has no in-process resume loop. Input satisfies LambdaScheduledEvent.
    new events.Rule(this, "ResumeSweep", {
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [
        new targets.LambdaFunction(this.function, {
          event: events.RuleTargetInput.fromObject({ source: "aws.events", "detail-type": "Scheduled Event" }),
        }),
      ],
    });

    // HTTP API with explicit routes only. NO AUTHENTICATION YET.
    this.httpApi = new apigwv2.CfnApi(this, "HttpApi", {
      name: `${this.stackName}-http-api`,
      protocolType: "HTTP",
      corsConfiguration: {
        allowOrigins: uiOrigins,
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["content-type"],
        maxAge: 3000,
      },
    });
    const integration = new apigwv2.CfnIntegration(this, "LambdaIntegration", {
      apiId: this.httpApi.ref,
      integrationType: "AWS_PROXY",
      integrationUri: this.function.functionArn,
      payloadFormatVersion: "2.0",
      // Maximum for HTTP APIs; do not lower. Long work (revision step 2) runs in the background.
      timeoutInMillis: API_INTEGRATION_TIMEOUT_MS,
    });
    API_ROUTES.forEach((routeKey, i) => {
      new apigwv2.CfnRoute(this, `Route${i}`, {
        apiId: this.httpApi.ref,
        routeKey,
        target: `integrations/${integration.ref}`,
      });
    });
    const stage = new apigwv2.CfnStage(this, "DefaultStage", {
      apiId: this.httpApi.ref,
      stageName: "$default",
      autoDeploy: true,
      defaultRouteSettings: { throttlingBurstLimit: 50, throttlingRateLimit: 25 },
    });
    new lambda.CfnPermission(this, "ApiInvoke", {
      action: "lambda:InvokeFunction",
      functionName: this.function.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: this.formatArn({
        service: "execute-api",
        resource: this.httpApi.ref,
        resourceName: "*",
      }),
    });

    new CfnOutput(this, "APIURL", { value: `https://${this.httpApi.ref}.execute-api.${this.region}.${this.urlSuffix}/`, description: "HTTP API base URL (no authentication)" });
    new CfnOutput(this, "FUNCTIONNAME", { value: this.function.functionName, description: "Lambda function name" });
    void stage;

    Tags.of(this).add(PROJECT_TAG_KEY, PROJECT_TAG_VALUE);
  }
}
