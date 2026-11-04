import { CfnOutput, RemovalPolicy, Stack, StackProps, Tags } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { PROJECT_TAG_KEY, PROJECT_TAG_VALUE } from "./data-stack";

export interface OrchestratorWebStackProps extends StackProps {
  /** Base URL consumed by the frontend build/deployment pipeline. */
  apiUrl: string;
}

/** Static frontend delivery for the browser application. */
export class OrchestratorWebStack extends Stack {
  public readonly assetBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: OrchestratorWebStackProps) {
    super(scope, id, props);

    this.assetBucket = new s3.Bucket(this, "WebAssetBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.distribution = new cloudfront.Distribution(this, "WebDistribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.assetBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
    });

    new CfnOutput(this, "WEBURL", {
      value: `https://${this.distribution.domainName}`,
      description: "CloudFront URL for the frontend web app",
    });
    new CfnOutput(this, "WEBASSETBUCKET", {
      value: this.assetBucket.bucketName,
      description: "Private S3 bucket for compiled frontend assets",
    });
    new CfnOutput(this, "BACKENDAPIURL", {
      value: props.apiUrl,
      description: "Backend API URL for the frontend build configuration",
    });

    Tags.of(this).add(PROJECT_TAG_KEY, PROJECT_TAG_VALUE);
  }
}
