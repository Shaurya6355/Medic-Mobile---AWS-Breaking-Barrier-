import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { OrchestratorDataStack } from "../lib/data-stack";
import { OrchestratorLambdaStack } from "../lib/lambda-stack";
import { METRIC_NAMESPACE } from "../lib/monitoring";

const app = new App();
const env = { region: "us-west-2", account: "111111111111" };
const data = new OrchestratorDataStack(app, "D", { env });
const stack = new OrchestratorLambdaStack(app, "L", {
  env,
  runsTable: data.runsTable, stepsTable: data.stepsTable, versionsTable: data.versionsTable, commentsTable: data.commentsTable, auditTable: data.auditTable,
  artifactBucket: data.artifactBucket, uploadQueue: data.uploadQueue, uploadDlq: data.uploadDlq, appPolicy: data.appPolicy, bedrockPolicy: data.bedrockPolicy,
});
const t = Template.fromStack(stack);

describe("monitoring", () => {
  it("creates one dashboard", () => {
    t.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
  });
  it("alarms on Lambda errors, throttles, failed steps, model errors, 5xx, store errors and the DLQ", () => {
    t.resourceCountIs("AWS::CloudWatch::Alarm", 7);
    for (const name of ["StepFailed", "ModelError", "Http5xx", "StoreError"]) {
      t.hasResourceProperties("AWS::CloudWatch::Alarm", { Namespace: METRIC_NAMESPACE, MetricName: name, Threshold: 0 });
    }
    t.hasResourceProperties("AWS::CloudWatch::Alarm", { Namespace: "AWS/Lambda", MetricName: "Errors" });
    t.hasResourceProperties("AWS::CloudWatch::Alarm", { Namespace: "AWS/SQS", MetricName: "ApproximateNumberOfMessagesVisible" });
  });
  it("a missing metric does not alarm", () => {
    t.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: "StepFailed", TreatMissingData: "notBreaching" });
  });
  it("uses the namespace the backend logger writes", () => {
    expect(METRIC_NAMESPACE).toBe("NoCodeChtConfig");
    expect(JSON.stringify(t.toJSON())).toContain("NoCodeChtConfig");
  });
});
