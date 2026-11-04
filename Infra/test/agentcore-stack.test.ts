import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { OrchestratorAgentCoreStack } from "../lib/agentcore-stack";
import { OrchestratorDataStack } from "../lib/data-stack";
import { OrchestratorLambdaStack } from "../lib/lambda-stack";

const env = { region: "us-west-2", account: "111111111111" };

function buildAgentCore(context: Record<string, unknown> = {}) {
  const app = new App({ context });
  const stack = new OrchestratorAgentCoreStack(app, "A", { env });
  return { stack, t: Template.fromStack(stack) };
}
function buildLambda(context: Record<string, unknown> = {}): Template {
  const app = new App({ context });
  const data = new OrchestratorDataStack(app, "D", { env });
  const ac = context.modelBackend === "agentcore" ? new OrchestratorAgentCoreStack(app, "A", { env }) : undefined;
  const stack = new OrchestratorLambdaStack(app, "L", {
    env,
    runsTable: data.runsTable,
    stepsTable: data.stepsTable,
    versionsTable: data.versionsTable,
    commentsTable: data.commentsTable,
    auditTable: data.auditTable,
    artifactBucket: data.artifactBucket,
    uploadQueue: data.uploadQueue,
    appPolicy: data.appPolicy,
    bedrockPolicy: data.bedrockPolicy,
    agentCoreRuntimeArn: ac?.runtimeArn,
  });
  return Template.fromStack(stack);
}

const { stack, t } = buildAgentCore();
const stack0 = stack;
void stack0;
const rt = () => Object.values(t.findResources("AWS::BedrockAgentCore::Runtime"))[0] as any;

describe("runtime", () => {
  it("has the expected properties", () => {
    t.resourceCountIs("AWS::BedrockAgentCore::Runtime", 1);
    const p = rt().Properties;
    expect(p.AgentRuntimeName).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
    expect(p.NetworkConfiguration).toEqual({ NetworkMode: "PUBLIC" });
    expect(p.ProtocolConfiguration).toBe("HTTP");
    expect(p.EnvironmentVariables.AWS_REGION).toBeDefined();
    expect(p.RoleArn).toBeDefined();
    expect(JSON.stringify(p.AgentRuntimeArtifact.ContainerConfiguration.ContainerUri)).toContain("dkr.ecr");
  });
  it("sets MODEL_ID from context", () => {
    const { t: t2 } = buildAgentCore({ modelId: "us.test.model-v1:0" });
    const p = (Object.values(t2.findResources("AWS::BedrockAgentCore::Runtime"))[0] as any).Properties;
    expect(p.EnvironmentVariables.MODEL_ID).toBe("us.test.model-v1:0");
  });
  it("builds the image for arm64", () => {
    const app = stack.node.root as App;
    const assembly = app.synth();
    const files = readdirSync(assembly.directory).filter((f) => f.endsWith(".assets.json"));
    const text = files.map((f) => readFileSync(path.join(assembly.directory, f), "utf8")).join("");
    expect(text).toContain('"platform": "linux/arm64"');
  });
});

describe("runtime name", () => {
  const nameOf = (id: string): string => {
    const app = new App();
    const tt = Template.fromStack(new OrchestratorAgentCoreStack(app, id, { env }));
    return (Object.values(tt.findResources("AWS::BedrockAgentCore::Runtime"))[0] as any).Properties.AgentRuntimeName;
  };
  it("is unique per stack id, deterministic, and matches the AgentCore pattern", () => {
    const a = nameOf("StackA");
    const b = nameOf("StackB");
    expect(a).not.toBe(b);
    expect(nameOf("StackA")).toBe(a);
    for (const n of [a, b]) expect(n).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
  });
  it("scopes the workload identity grant to the same name", () => {
    const name = (rt().Properties.AgentRuntimeName as string);
    expect(JSON.stringify(t.toJSON())).toContain(`workload-identity/${name}-*`);
  });
});

describe("execution role", () => {
  const role = () => Object.values(t.findResources("AWS::IAM::Role"))[0] as any;
  it("trusts bedrock-agentcore with source conditions", () => {
    const s = role().Properties.AssumeRolePolicyDocument.Statement[0];
    expect(s.Principal).toEqual({ Service: "bedrock-agentcore.amazonaws.com" });
    expect(s.Action).toBe("sts:AssumeRole");
    expect(s.Condition.StringEquals["aws:SourceAccount"]).toBeDefined();
    expect(JSON.stringify(s.Condition.ArnLike["aws:SourceArn"])).toContain("bedrock-agentcore");
  });
  it("only uses wildcard resources where the AgentCore docs require them", () => {
    const pol = Object.values(t.findResources("AWS::IAM::Policy"))[0] as any;
    const allowed = new Set([
      "ecr:GetAuthorizationToken",
      "xray:PutTraceSegments",
      "cloudwatch:PutMetricData",
      "logs:DescribeLogGroups",
    ]);
    for (const st of pol.Properties.PolicyDocument.Statement) {
      const res = ([] as any[]).concat(st.Resource);
      if (res.some((r) => r === "*")) {
        const acts = ([] as string[]).concat(st.Action);
        expect(acts.some((a) => allowed.has(a))).toBe(true);
      }
    }
    // Bedrock invoke is limited to the same two ARNs as the data stack app policy.
    const b = pol.Properties.PolicyDocument.Statement.find((s: any) => JSON.stringify(s.Action).includes("bedrock:InvokeModel"));
    expect(b.Resource).toHaveLength(2);
    expect(JSON.stringify(b.Resource)).toContain("inference-profile/us.anthropic.claude");
    expect(JSON.stringify(b.Resource)).toContain("foundation-model/anthropic.claude");
    // ECR pull is scoped to the asset repository, not repository/*.
    const e = pol.Properties.PolicyDocument.Statement.find((s: any) => JSON.stringify(s.Action).includes("ecr:BatchGetImage"));
    expect(JSON.stringify(e.Resource)).not.toContain("repository/*");
  });
});

describe("outputs and tags", () => {
  it("outputs runtime arn and id", () => {
    t.hasOutput("RUNTIMEARN", {});
    t.hasOutput("RUNTIMEID", {});
  });
  it("tags the project", () => {
    const app = new App();
    const s = new OrchestratorAgentCoreStack(app, "A", { env });
    const rtProps = Object.values(Template.fromStack(s).findResources("AWS::BedrockAgentCore::Runtime"))[0] as any;
    expect(rtProps.Properties.Tags).toMatchObject({ project: "no-code-cht-config" });
  });
  it("exposes the runtime arn", () => {
    expect(stack.runtimeArn).toBeDefined();
  });
});

describe("lambda wiring", () => {
  const invokeStatements = (tt: Template) =>
    Object.values(tt.findResources("AWS::IAM::Policy"))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
      .filter((s: any) => JSON.stringify(s.Action).includes("bedrock-agentcore:InvokeAgentRuntime"));
  it("default has no agentcore env or grant", () => {
    const tt = buildLambda();
    const fn = Object.values(tt.findResources("AWS::Lambda::Function"))[0] as any;
    expect(fn.Properties.Environment.Variables.MODEL_BACKEND).toBeUndefined();
    expect(fn.Properties.Environment.Variables.AGENTCORE_RUNTIME_ARN).toBeUndefined();
    expect(invokeStatements(tt)).toHaveLength(0);
  });
  it("agentcore sets env and grants invoke on runtime and endpoints", () => {
    const tt = buildLambda({ modelBackend: "agentcore" });
    const fn = Object.values(tt.findResources("AWS::Lambda::Function"))[0] as any;
    expect(fn.Properties.Environment.Variables.MODEL_BACKEND).toBe("agentcore");
    expect(fn.Properties.Environment.Variables.AGENTCORE_RUNTIME_ARN).toBeDefined();
    const st = invokeStatements(tt);
    expect(st).toHaveLength(1);
    const res = JSON.stringify(st[0].Resource);
    expect(res).toContain("/runtime-endpoint/*");
    expect(st[0].Resource).toHaveLength(2);
  });
  it("agentcore mode does not grant bedrock invoke to the lambda role", () => {
    const tt = buildLambda({ modelBackend: "agentcore" });
    expect(JSON.stringify(tt.toJSON())).not.toContain("BedrockInvokePolicy");
    const bedrock = buildLambda();
    expect(JSON.stringify(bedrock.toJSON())).toContain("BedrockInvokePolicy");
  });
  it("rejects an unknown modelBackend", () => {
    expect(() => buildLambda({ modelBackend: "nope" })).toThrow(/modelBackend/);
  });
  it("rejects agentcore without a runtime arn", () => {
    const app = new App({ context: { modelBackend: "agentcore" } });
    const data = new OrchestratorDataStack(app, "D2", { env });
    expect(() => new OrchestratorLambdaStack(app, "L", { env, runsTable: data.runsTable, stepsTable: data.stepsTable, versionsTable: data.versionsTable, commentsTable: data.commentsTable, auditTable: data.auditTable, artifactBucket: data.artifactBucket, uploadQueue: data.uploadQueue, appPolicy: data.appPolicy, bedrockPolicy: data.bedrockPolicy })).toThrow(/agentCoreRuntimeArn/);
  });
});

describe("app", () => {
  it("synthesizes offline in both modes", async () => {
    const { execFileSync } = await import("node:child_process");
    const run = (args: string[]) =>
      execFileSync("npx", ["cdk", "synth", "-q", ...args], {
        cwd: __dirname + "/..",
        env: { ...process.env, CDK_DEFAULT_ACCOUNT: "111111111111", AWS_REGION: "us-west-2", CDK_OUTDIR: "/private/tmp/cdk-test-out-" + args.length },
        stdio: "pipe",
      });
    run([]);
    run(["-c", "modelBackend=agentcore"]);
  }, 300000);
});
void Match;
