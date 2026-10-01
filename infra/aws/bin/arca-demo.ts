#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ArcaDemoStack } from '../lib/arca-demo-stack.js';

const app = new cdk.App();
const demoHostname = app.node.tryGetContext('demoHostname') as string | undefined;
if (!demoHostname || !/^[a-z0-9.-]+$/i.test(demoHostname)) {
  throw new Error('Provide a valid -c demoHostname=api.example.com');
}

// Not committed: the repository is public. Every deploy must pass them, or the subscriptions
// would be removed, so a missing value stops synthesis instead.
const alertEmails = String(app.node.tryGetContext('alertEmails') ?? '').split(',').map(value => value.trim()).filter(Boolean);
if (!alertEmails.length || alertEmails.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
  throw new Error('Provide -c alertEmails=first@example.com,second@example.com');
}
const githubRepository = (app.node.tryGetContext('githubRepository') as string | undefined) ?? 'ArcaCover/Arca-back';
// GitHub signs this repository's OIDC tokens with immutable subjects, which carry these ids.
// Look them up with: gh api repos/OWNER/NAME --jq '[.owner.id, .id]'
const githubOwnerId = Number(app.node.tryGetContext('githubOwnerId') ?? 317962260);
const githubRepositoryId = Number(app.node.tryGetContext('githubRepositoryId') ?? 1341243286);

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
  githubRepository,
  githubRepositoryIds: { owner: githubOwnerId, repository: githubRepositoryId },
  alertEmails,
  hostedZoneId,
  hostedZoneName,
  terminationProtection: true,
  description: 'ARCA Layer 1 API on one EC2 host, deployed from GitHub; no load balancer',
});
