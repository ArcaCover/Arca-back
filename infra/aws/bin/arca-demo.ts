#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ArcaDemoStack } from '../lib/arca-demo-stack.js';

const app = new cdk.App();
const demoHostname = app.node.tryGetContext('demoHostname') as string | undefined;
if (!demoHostname || !/^[a-z0-9.-]+$/i.test(demoHostname)) {
  throw new Error('Provide a valid -c demoHostname=api.example.com');
}

const hostedZoneId = app.node.tryGetContext('hostedZoneId') as string | undefined;
const hostedZoneName = app.node.tryGetContext('hostedZoneName') as string | undefined;
if ((hostedZoneId && !hostedZoneName) || (!hostedZoneId && hostedZoneName)) {
  throw new Error('hostedZoneId and hostedZoneName must be supplied together');
}

new ArcaDemoStack(app, 'ArcaDemoStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  demoHostname,
  hostedZoneId,
  hostedZoneName,
  terminationProtection: true,
  description: 'ARCA Layer 1 demo on one EC2 host; no load balancer',
});
