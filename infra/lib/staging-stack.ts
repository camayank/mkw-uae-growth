import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import * as appscaling from "aws-cdk-lib/aws-applicationautoscaling";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import { DB_PASSWORD_EXCLUDE, platformImage, required, withDatabaseUrl } from "./shared";

export interface StagingProps extends StackProps {
  /** Public host name of the workspace, for example app.tasees.ae or tasees.mkwadvisors.com. */
  domainName?: string;
  /** ACM certificate for that name, issued in me-central-1. */
  certificateArn?: string;
  /** Where alarms go (a job that did not run, a failing service). Optional. */
  alarmEmail?: string;
}

/**
 * Staging with MKW Advisors' real data, in AWS me-central-1 (UAE):
 * - RDS PostgreSQL 16 in isolated subnets, encrypted, 30 days of automated backups, deletion protection;
 * - a private, encrypted, versioned S3 bucket for evidence files and the go-live import files, and one for backups;
 * - the Dockerfile's image on ECS Fargate in private subnets behind an HTTPS load balancer (HTTP redirects);
 * - secrets in AWS Secrets Manager, read by the task at start and never written to the template or the logs;
 * - TRUST_PROXY set to the VPC's range (the load balancer's addresses), DEV_LOGIN unset, NODE_ENV=production;
 * - the 15-minute jobs as a scheduled Fargate task (IN_PROCESS_JOBS=0), with an alarm when a run is missing.
 */
export class StagingStack extends Stack {
  constructor(scope: Construct, id: string, props: StagingProps) {
    super(scope, id, props);
    const domainName = required(props.domainName, "domainName");
    const certificateArn = required(props.certificateArn, "certificateArn");

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "app", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: "db", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // Database ----------------------------------------------------------------------------------------------------
    const dbSecret = new rds.DatabaseSecret(this, "DbSecret", { username: "tasees", excludeCharacters: DB_PASSWORD_EXCLUDE });
    const db = new rds.DatabaseInstance(this, "Db", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      credentials: rds.Credentials.fromSecret(dbSecret),
      databaseName: "tasees",
      storageEncrypted: true,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      backupRetention: Duration.days(30),
      deletionProtection: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      publiclyAccessible: false,
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: logs.RetentionDays.THREE_MONTHS,
    });

    // Files and backups -------------------------------------------------------------------------------------------
    const bucketDefaults: s3.BucketProps = {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
    };
    const files = new s3.Bucket(this, "Files", { ...bucketDefaults, lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(35) }] });
    const backups = new s3.Bucket(this, "Backups", { ...bucketDefaults, lifecycleRules: [{ expiration: Duration.days(35), noncurrentVersionExpiration: Duration.days(7) }] });

    // The app signs S3 requests itself (D13) with a key that may only put and get objects in the files bucket.
    const storageUser = new iam.User(this, "StorageUser");
    storageUser.addToPolicy(new iam.PolicyStatement({ actions: ["s3:PutObject", "s3:GetObject"], resources: [files.arnForObjects("*")] }));
    const storageKey = new iam.AccessKey(this, "StorageKey", { user: storageUser });
    const storageSecret = new secretsmanager.Secret(this, "StorageKeySecret", {
      description: "Tasees staging: access key for the evidence bucket (put and get only)",
      secretObjectValue: { accessKeyId: SecretValue.unsafePlainText(storageKey.accessKeyId), secretAccessKey: storageKey.secretAccessKey },
    });
    const webhookSecret = new secretsmanager.Secret(this, "WebhookSecret", {
      description: "Tasees staging: payment webhook signing secret",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    // Application -------------------------------------------------------------------------------------------------
    const environment: Record<string, string> = {
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      PORT: "8787",
      // X-Forwarded-For is believed only from the load balancer, whose addresses are in the VPC.
      TRUST_PROXY: vpc.vpcCidrBlock,
      APP_URL: `https://${domainName}`,
      IN_PROCESS_JOBS: "0",
      STORAGE: "s3",
      S3_BUCKET: files.bucketName,
      S3_REGION: this.region,
      EMAIL: "console",
      EMAIL_FROM_CLIENT: "tasees@mkwadvisors.com",
      EMAIL_FROM_PARTNER: "partners@mkwadvisors.com",
      DB_HOST: db.dbInstanceEndpointAddress,
      DB_PORT: db.dbInstanceEndpointPort,
      DB_NAME: "tasees",
      // The app's own alerts (O13) go to the same address as the CloudWatch alarms.
      ...(props.alarmEmail ? { ALERT_EMAIL: props.alarmEmail } : {}),
    };
    const secrets: Record<string, ecs.Secret> = {
      DB_USER: ecs.Secret.fromSecretsManager(dbSecret, "username"),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
      PAYMENT_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(webhookSecret),
      S3_ACCESS_KEY_ID: ecs.Secret.fromSecretsManager(storageSecret, "accessKeyId"),
      S3_SECRET_ACCESS_KEY: ecs.Secret.fromSecretsManager(storageSecret, "secretAccessKey"),
    };
    const image = platformImage();
    const cluster = new ecs.Cluster(this, "Cluster", { vpc, containerInsightsV2: ecs.ContainerInsights.ENABLED });
    const tasksSg = new ec2.SecurityGroup(this, "TasksSg", { vpc, description: "Tasees app, jobs and one-off tasks", allowAllOutbound: true });
    db.connections.allowDefaultPortFrom(tasksSg, "Tasees tasks to Postgres");
    const appLogs = new logs.LogGroup(this, "AppLogs", { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.RETAIN });

    const app = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "App", {
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 1,
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [tasksSg],
      publicLoadBalancer: true,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificate: acm.Certificate.fromCertificateArn(this, "Certificate", certificateArn),
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      redirectHTTP: true,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      taskImageOptions: {
        image,
        containerPort: 8787,
        environment,
        secrets,
        command: withDatabaseUrl("node --conditions=production dist/main.js"),
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: "app", logGroup: appLogs }),
      },
    });
    app.targetGroup.configureHealthCheck({ path: "/api/health", healthyHttpCodes: "200", interval: Duration.seconds(30) });

    // The 15-minute sweeps (reply deadlines, auto-approval, offer expiry, digest, licence and delay watch, reminders).
    const jobLogs = new logs.LogGroup(this, "JobLogs", { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.RETAIN });
    const jobs = new ecsPatterns.ScheduledFargateTask(this, "Jobs", {
      cluster,
      schedule: appscaling.Schedule.rate(Duration.minutes(15)),
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [tasksSg],
      scheduledFargateTaskImageOptions: {
        image,
        cpu: 256,
        memoryLimitMiB: 512,
        environment,
        secrets,
        command: withDatabaseUrl("node --conditions=production dist/scripts/run-jobs.js"),
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: "jobs", logGroup: jobLogs }),
      },
    });

    // Every run prints its result as JSON; no result line in an hour means the jobs stopped running.
    const runs = new logs.MetricFilter(this, "JobRuns", {
      logGroup: jobLogs,
      metricNamespace: "Tasees/Staging",
      metricName: "JobRuns",
      filterPattern: logs.FilterPattern.exists("$.allocationTimeouts"),
      metricValue: "1",
    });
    const missing = new cloudwatch.Alarm(this, "JobsNotRunning", {
      metric: runs.metric({ period: Duration.hours(1), statistic: "Sum" }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: "No scheduled job run recorded in the last hour",
    });
    const unhealthy = new cloudwatch.Alarm(this, "AppUnhealthy", {
      metric: app.targetGroup.metrics.unhealthyHostCount({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 2,
      alarmDescription: "The Tasees staging app has an unhealthy task",
    });
    if (props.alarmEmail) {
      const topic = new sns.Topic(this, "Alarms");
      topic.addSubscription(new subscriptions.EmailSubscription(props.alarmEmail));
      for (const a of [missing, unhealthy]) a.addAlarmAction(new cwActions.SnsAction(topic));
    }

    // What the runbook needs for one-off tasks (create the founder, run the importers) and the backup script.
    new CfnOutput(this, "Url", { value: `https://${domainName}` });
    new CfnOutput(this, "LoadBalancerDns", { value: app.loadBalancer.loadBalancerDnsName, description: "Point the domain's DNS (CNAME or alias) here" });
    new CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    new CfnOutput(this, "TaskDefinitionArn", { value: jobs.taskDefinition.taskDefinitionArn, description: "Use for one-off tasks (create-founder, import) with a command override" });
    new CfnOutput(this, "TaskSubnets", { value: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.join(",") });
    new CfnOutput(this, "TaskSecurityGroup", { value: tasksSg.securityGroupId });
    new CfnOutput(this, "FilesBucket", { value: files.bucketName, description: "Evidence files; upload the go-live files under import/ and delete them after the import" });
    new CfnOutput(this, "BackupsBucket", { value: backups.bucketName });
    new CfnOutput(this, "DatabaseSecretArn", { value: dbSecret.secretArn });
  }
}
