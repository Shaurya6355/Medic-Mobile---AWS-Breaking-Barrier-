import { Duration } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

// Must match NAMESPACE in Backend/src/observability/logger.ts. The backend writes CloudWatch Embedded Metric
// Format lines to stdout; the Lambda log group turns them into these metrics, no extra permission needed.
export const METRIC_NAMESPACE = "NoCodeChtConfig";
// The pipeline steps (Backend/src/index.ts). StepFailed/StepDurationMs carry a Step dimension.
const STEPS = ["ingest", "extract", "fill_logic", "checks"] as const;
const PERIOD = Duration.minutes(5);

export interface MonitoringProps {
  fn: lambda.IFunction;
  uploadDlq?: sqs.IQueue;
}

const m = (name: string, statistic: string, dims?: Record<string, string>, label?: string): cloudwatch.Metric =>
  new cloudwatch.Metric({ namespace: METRIC_NAMESPACE, metricName: name, statistic, period: PERIOD, ...(dims ? { dimensionsMap: dims } : {}), ...(label ? { label } : {}) });

/** A dashboard and alarms over the Lambda metrics and the backend's own metrics. Alarms have no action yet
 *  (no notification topic is deployed): add `alarm.addAlarmAction(...)` once one exists. */
export function addMonitoring(scope: Construct, props: MonitoringProps): { dashboard: cloudwatch.Dashboard; alarms: cloudwatch.Alarm[] } {
  const alarms: cloudwatch.Alarm[] = [];
  const alarm = (id: string, metric: cloudwatch.IMetric, description: string, threshold = 0): cloudwatch.Alarm => {
    const a = new cloudwatch.Alarm(scope, id, {
      metric,
      threshold,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: description,
    });
    alarms.push(a);
    return a;
  };

  alarm("LambdaErrorsAlarm", props.fn.metricErrors({ period: PERIOD }), "The orchestrator Lambda returned an error.");
  alarm("LambdaThrottlesAlarm", props.fn.metricThrottles({ period: PERIOD }), "The orchestrator Lambda was throttled.");
  alarm("StepFailedAlarm", m("StepFailed", "Sum"), "A pipeline step failed (see the step.failed log lines for the run and step).");
  alarm("ModelErrorAlarm", m("ModelError", "Sum"), "A Bedrock model call failed.");
  alarm("Http5xxAlarm", m("Http5xx", "Sum"), "The API answered with a 5xx status.");
  alarm("StoreErrorAlarm", m("StoreError", "Sum"), "A DynamoDB store operation failed (not a normal conflict).");
  if (props.uploadDlq) {
    alarm("UploadDlqAlarm", props.uploadDlq.metricApproximateNumberOfMessagesVisible({ period: PERIOD }), "An upload message reached the dead-letter queue: a run could not be started.");
  }

  const dashboard = new cloudwatch.Dashboard(scope, "OrchestratorDashboard", { dashboardName: `${(props.fn as lambda.Function).functionName ?? "orchestrator"}-overview` });
  dashboard.addWidgets(
    new cloudwatch.GraphWidget({ title: "Lambda invocations / errors / throttles", width: 12, left: [props.fn.metricInvocations({ period: PERIOD }), props.fn.metricErrors({ period: PERIOD }), props.fn.metricThrottles({ period: PERIOD })] }),
    new cloudwatch.GraphWidget({ title: "Lambda duration (avg, max)", width: 12, left: [props.fn.metricDuration({ period: PERIOD, statistic: "Average" }), props.fn.metricDuration({ period: PERIOD, statistic: "Maximum" })] }),
  );
  dashboard.addWidgets(
    new cloudwatch.GraphWidget({ title: "Steps succeeded", width: 8, stacked: true, left: STEPS.map((s) => m("StepSucceeded", "Sum", { Step: s }, s)) }),
    new cloudwatch.GraphWidget({ title: "Steps failed", width: 8, stacked: true, left: STEPS.map((s) => m("StepFailed", "Sum", { Step: s }, s)) }),
    new cloudwatch.GraphWidget({ title: "Step duration (avg ms)", width: 8, left: STEPS.map((s) => m("StepDurationMs", "Average", { Step: s }, s)) }),
  );
  dashboard.addWidgets(
    new cloudwatch.GraphWidget({ title: "Model tokens", width: 8, left: [m("ModelInputTokens", "Sum", undefined, "input"), m("ModelOutputTokens", "Sum", undefined, "output")] }),
    new cloudwatch.GraphWidget({ title: "Model latency (avg ms) and errors", width: 8, left: [m("ModelLatencyMs", "Average")], right: [m("ModelError", "Sum", undefined, "failed calls"), m("ModelOutputInvalid", "Sum", undefined, "answer in the wrong shape")] }),
    new cloudwatch.GraphWidget({ title: "Step cost (USD)", width: 8, left: STEPS.map((s) => m("StepCostUsd", "Sum", { Step: s }, s)) }),
  );
  dashboard.addWidgets(
    new cloudwatch.GraphWidget({ title: "API latency (avg ms)", width: 8, left: [m("HttpLatencyMs", "Average")] }),
    new cloudwatch.GraphWidget({ title: "API 4xx / 5xx", width: 8, left: [m("Http4xx", "Sum"), m("Http5xx", "Sum")] }),
    new cloudwatch.GraphWidget({ title: "Versions and signatures", width: 8, left: [m("VersionSaved", "Sum"), m("Signature", "Sum"), m("VersionRejected", "Sum")] }),
  );
  dashboard.addWidgets(
    new cloudwatch.LogQueryWidget({
      title: "Recent failures (Logs Insights)",
      width: 24,
      logGroupNames: [(props.fn as lambda.Function).logGroup?.logGroupName ?? ""],
      queryLines: ["fields @timestamp, msg, runId, step, error, route, status", "filter level = 'error'", "sort @timestamp desc", "limit 50"],
    }),
  );
  return { dashboard, alarms };
}
