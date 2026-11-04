#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";
import { DemoStack } from "../lib/demo-stack";
import { REGION } from "../lib/shared";
import { StagingStack } from "../lib/staging-stack";

/**
 * Two stacks in AWS me-central-1 (UAE): staging with real data, and a separate demo for the browser smoke test.
 * Values come from context (-c name=value), never from this file:
 *   domainName, certificateArn, alarmEmail           staging
 *   demoDomainName, demoCertificateArn, demoAllowedCidr   demo (demoCertificateArn defaults to certificateArn)
 * See docs/DEPLOY.md, "Staging runbook".
 */
const app = new App();
const ctx = (k: string): string | undefined => app.node.tryGetContext(k);
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION };

new StagingStack(app, "TaseesStaging", { env, domainName: ctx("domainName"), certificateArn: ctx("certificateArn"), alarmEmail: ctx("alarmEmail") });
new DemoStack(app, "TaseesDemo", { env, domainName: ctx("demoDomainName"), certificateArn: ctx("demoCertificateArn") ?? ctx("certificateArn"), allowedCidr: ctx("demoAllowedCidr") });
Tags.of(app).add("project", "tasees");
Tags.of(app).add("owner", "mkw-advisors");
