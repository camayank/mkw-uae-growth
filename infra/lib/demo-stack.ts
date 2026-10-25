import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { platformImage, required } from "./shared";

export interface DemoProps extends StackProps {
  domainName?: string;
  certificateArn?: string;
  /** The only address range allowed to reach the demo (for example the office IP as a /32). */
  allowedCidr?: string;
}

/**
 * A separate demo deployment for the browser smoke test (scripts/smoke.mjs), never holding real data: the same image
 * with the synthetic demo seed, embedded Postgres inside the task (wiped on every restart), development sign-in on
 * so the smoke test can use the demo accounts, and the load balancer reachable only from `allowedCidr`. It shares
 * nothing with staging: its own VPC, no database, no bucket, no secrets.
 */
export class DemoStack extends Stack {
  constructor(scope: Construct, id: string, props: DemoProps) {
    super(scope, id, props);
    const domainName = required(props.domainName, "demoDomainName");
    const certificateArn = required(props.certificateArn, "certificateArn");
    const allowedCidr = required(props.allowedCidr, "demoAllowedCidr");

    const vpc = new ec2.Vpc(this, "Vpc", { maxAzs: 2, natGateways: 0, subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }] });
    const cluster = new ecs.Cluster(this, "Cluster", { vpc });
    const demoLogs = new logs.LogGroup(this, "DemoLogs", { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY });
    const demo = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "Demo", {
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 1,
      assignPublicIp: true,
      taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      publicLoadBalancer: true,
      openListener: false,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificate: acm.Certificate.fromCertificateArn(this, "Certificate", certificateArn),
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      redirectHTTP: true,
      healthCheckGracePeriod: Duration.minutes(3),
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0, // one throw-away task; a redeploy may stop it before starting the next
      taskImageOptions: {
        image: platformImage(),
        containerPort: 8787,
        environment: {
          NODE_ENV: "demo",
          HOST: "0.0.0.0",
          PORT: "8787",
          TRUST_PROXY: "1",
          DEV_LOGIN: "1",
          PAYMENT_WEBHOOK_SECRET: "demo-only-not-a-secret",
          APP_URL: `https://${domainName}`,
        },
        // The synthetic demo (seed.ts with NODE_ENV other than production), then the server.
        command: ["sh", "-c", "node --conditions=production dist/scripts/seed.js && exec node --conditions=production dist/main.js"],
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: "demo", logGroup: demoLogs }),
      },
    });
    demo.targetGroup.configureHealthCheck({ path: "/api/health", healthyHttpCodes: "200" });
    for (const port of [80, 443]) demo.loadBalancer.connections.allowFrom(ec2.Peer.ipv4(allowedCidr), ec2.Port.tcp(port), "Demo reachable from the allowed range only");

    new CfnOutput(this, "Url", { value: `https://${domainName}` });
    new CfnOutput(this, "LoadBalancerDns", { value: demo.loadBalancer.loadBalancerDnsName });
  }
}
