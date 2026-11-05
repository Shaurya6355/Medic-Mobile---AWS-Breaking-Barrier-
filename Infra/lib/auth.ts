import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";

/** The app's roles (DEC-015), one Cognito group each. Backend/src/auth/identity.ts reads them from the ID token. */
export const ROLE_GROUPS = ["program_officer", "clinician", "it"] as const;

export interface Auth {
  userPool: cognito.UserPool;
  client: cognito.UserPoolClient;
  /** https://<prefix>.auth.<region>.amazoncognito.com, the hosted sign-in page. */
  domainUrl: string;
  /** The issuer API Gateway's JWT authorizer checks. */
  issuer: string;
}

/**
 * Sign-in for the review app (DEC-015): a Cognito user pool with one group per role, the managed sign-in page,
 * and a public app client using the authorization code flow with PKCE (no client secret in the browser).
 * Accounts are created by an administrator only (no self sign-up). Callback and sign-out URLs are the UI origins.
 */
export function addAuth(scope: Construct, uiOrigins: readonly string[]): Auth {
  const stack = Stack.of(scope);
  const userPool = new cognito.UserPool(scope, "UserPool", {
    selfSignUpEnabled: false,
    signInAliases: { email: true },
    standardAttributes: { email: { required: true, mutable: true } },
    passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
    accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    // Accounts are cheap to recreate; keeping the pool would block a clean teardown and redeploy.
    removalPolicy: RemovalPolicy.DESTROY,
  });
  ROLE_GROUPS.forEach((g) => new cognito.CfnUserPoolGroup(scope, `Group-${g}`, { userPoolId: userPool.userPoolId, groupName: g }));

  const urls = uiOrigins.map((o) => o + "/");
  const client = userPool.addClient("WebClient", {
    generateSecret: false,
    authFlows: { userSrp: true },
    oAuth: {
      flows: { authorizationCodeGrant: true },
      scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
      callbackUrls: urls,
      logoutUrls: urls,
    },
    supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    idTokenValidity: Duration.hours(8),
    accessTokenValidity: Duration.hours(8),
    preventUserExistenceErrors: true,
  });

  const ctxPrefix = scope.node.tryGetContext("authDomainPrefix") as unknown;
  const prefix = typeof ctxPrefix === "string" && ctxPrefix !== "" ? ctxPrefix : `cht-config-${stack.account}`;
  const domain = userPool.addDomain("Domain", { cognitoDomain: { domainPrefix: prefix } });
  const domainUrl = domain.baseUrl();
  const issuer = `https://cognito-idp.${stack.region}.${stack.urlSuffix}/${userPool.userPoolId}`;

  new CfnOutput(scope, "USERPOOLID", { value: userPool.userPoolId, description: "Cognito user pool (create users here; add them to a role group)" });
  new CfnOutput(scope, "USERPOOLCLIENTID", { value: client.userPoolClientId, description: "App client id: VITE_COGNITO_CLIENT_ID for the frontend build" });
  new CfnOutput(scope, "AUTHDOMAIN", { value: domainUrl, description: "Hosted sign-in domain: VITE_COGNITO_DOMAIN for the frontend build" });
  return { userPool, client, domainUrl, issuer };
}
