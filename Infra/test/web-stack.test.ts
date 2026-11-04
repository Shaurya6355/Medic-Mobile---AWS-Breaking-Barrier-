import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { OrchestratorWebStack } from "../lib/web-stack";

function build(): Template {
  const app = new App();
  return Template.fromStack(new OrchestratorWebStack(app, "W", {
    env: { account: "111111111111", region: "us-west-2" },
    apiUrl: "https://api.example.test/",
  }));
}

describe("web stack", () => {
  const template = build();

  it("stores assets in a private bucket and grants CloudFront origin access", () => {
    template.resourceCountIs("AWS::S3::Bucket", 1);
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: "cloudfront.amazonaws.com" },
            Action: "s3:GetObject",
          }),
        ]),
      },
    });
  });

  it("redirects HTTP to HTTPS and supports SPA deep links", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }),
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: "/index.html" }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: "/index.html" }),
        ]),
      }),
    });
  });

  it("publishes the website URL and asset bucket outputs", () => {
    const outputs = template.toJSON().Outputs;
    expect(outputs.WEBURL).toBeDefined();
    expect(outputs.WEBASSETBUCKET).toBeDefined();
    expect(outputs.BACKENDAPIURL).toBeDefined();
  });
});
