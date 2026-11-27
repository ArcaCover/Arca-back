import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { API_LOG_GROUP_NAME, ArcaDemoStack, BILLING_ALARMS, HOST_AMI_ID } from './arca-demo-stack.js';

const template = () => Template.fromStack(new ArcaDemoStack(new cdk.App(), 'TestStack', {
  env: { account: '111111111111', region: 'us-east-1' },
  demoHostname: 'api.example.com',
  githubRepository: 'ArcaCover/Arca-back',
  githubRepositoryIds: { owner: 317962260, repository: 1341243286 },
  alertEmails: ['ops@example.com', 'founder@example.com'],
}));

describe('AWS demo infrastructure', () => {
  it('uses one hardened EC2 host and no load balancer', () => {
    const output = template();
    output.resourceCountIs('AWS::EC2::Instance', 1);
    output.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
    output.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't3.medium',
      BlockDeviceMappings: Match.arrayWith([Match.objectLike({ Ebs: Match.objectLike({ Encrypted: true }) })]),
    });
    output.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } },
    });
  });

  it('pins the host image, so a newer Amazon Linux release never replaces the host on a deploy', () => {
    const output = template();
    output.hasResourceProperties('AWS::EC2::Instance', { ImageId: HOST_AMI_ID });
    expect(JSON.stringify(output.toJSON().Parameters ?? {})).not.toContain('ami-amazon-linux');
  });

  it('exposes only web ports and retains the scanned ECR repository', () => {
    const output = template();
    output.hasResourceProperties('AWS::ECR::Repository', {
      ImageScanningConfiguration: { ScanOnPush: true },
    });
    output.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ FromPort: 80, ToPort: 80, IpProtocol: 'tcp' }),
        Match.objectLike({ FromPort: 443, ToPort: 443, IpProtocol: 'tcp' }),
      ]),
    });
  });

  it('installs only the deploy bootstrap through user data, never an env file', () => {
    const userData = JSON.stringify(template().findResources('AWS::EC2::Instance'));
    expect(userData).toContain('deploy-image.sh');
    expect(userData).not.toContain('.env.demo');
  });

  it('lets only the main and pilot branches of one repository assume the GitHub deploy role', () => {
    const output = template();
    output.resourceCountIs('AWS::IAM::OIDCProvider', 1);
    output.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'arca-github-deploy',
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: { Statement: [Match.objectLike({
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: { StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          // Classic and immutable subject formats, pinned to main (production) and pilot of this one repository.
          'token.actions.githubusercontent.com:sub': [
            'repo:ArcaCover/Arca-back:ref:refs/heads/main',
            'repo:ArcaCover/Arca-back:ref:refs/heads/pilot',
            'repo:ArcaCover@317962260/Arca-back@1341243286:ref:refs/heads/main',
            'repo:ArcaCover@317962260/Arca-back@1341243286:ref:refs/heads/pilot',
          ],
        } },
      })] },
    });
  });

  it('never grants a wildcard action, and SendCommand only reaches the host', () => {
    const policies = Object.values(template().findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap(policy => policy.Properties.PolicyDocument.Statement as
      { Action: string | string[]; Resource: unknown }[]);
    for (const statement of statements) {
      for (const action of [statement.Action].flat()) expect(action).not.toMatch(/(^\*$|:\*$)/);
    }
    const sendCommand = statements.find(statement => [statement.Action].flat().includes('ssm:SendCommand'));
    expect(JSON.stringify(sendCommand?.Resource)).toContain('instance/');
    expect(JSON.stringify(sendCommand?.Resource)).not.toContain('instance/*');
  });

  it('alerts both addresses and recovers the host on failed status checks', () => {
    const output = template();
    output.resourceCountIs('AWS::SNS::Subscription', 2);
    output.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com' });
    const alarms = Object.values(output.findResources('AWS::CloudWatch::Alarm'));
    const byMetric = (name: string) => JSON.stringify(alarms.find(alarm => alarm.Properties.MetricName === name));
    expect(byMetric('StatusCheckFailed_System')).toContain('ec2:recover');
    expect(byMetric('StatusCheckFailed_Instance')).toContain('ec2:reboot');
  });

  it('ships the API logs to one CloudWatch log group, which the host can only write to and look up', () => {
    const output = template();
    output.resourceCountIs('AWS::Logs::LogGroup', 1);
    output.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: API_LOG_GROUP_NAME, RetentionInDays: 90 });
    expect(API_LOG_GROUP_NAME).toBe('/arca/api');
    const statements = Object.values(output.findResources('AWS::IAM::Policy')).flatMap(policy => policy.Properties.PolicyDocument.Statement as
      { Action: string | string[]; Resource: unknown }[]);
    const logActions = statements.filter(statement => [statement.Action].flat().some(action => action.startsWith('logs:')));
    expect(logActions.flatMap(statement => [statement.Action].flat()).sort())
      .toEqual(['logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents']);
    // On that log group alone, never on every group of the account.
    for (const statement of logActions) expect(JSON.stringify(statement.Resource)).toContain('ApiLogGroup');
  });

  describe('billing alarms on the API logs (DN-13 §9.5, T26)', () => {
    // The lines the API writes (apps/api/src/webapp: billing-events.ts, reconcile-schedule.ts, service.ts; compose.ts at start),
    // with the alarm each one must raise. A filter pattern of quoted terms matches a line holding every term.
    const LINES: Array<[string, string | null]> = [
      ['[billing] reconcile failed (BillingUnavailable); next run in 24 h', 'ReconcileFailed'],
      ['[billing] reconcile failed for subscription sub_1 (StripeAPIError)', 'ReconcileFailed'],
      ['[billing] reconcile mismatch org 3f0c subscription sub_1: Stripe says past_due', 'ReconcileMismatch'],
      ['[billing] event evt_1 invoice.paid failed (Error)', 'WebhookFailed'],
      ['[billing] event evt_1 invoice.paid refused: livemode=true does not match this process\'s test key', 'WebhookFailed'],
      ['[billing] duplicate_subscription org 3f0c: subscription sub_2 pays beside the live one; cancel and refund it', 'DuplicateSubscription'],
      ['[billing] dispute dp_1 of event evt_1: answer it in the Stripe dashboard', 'Dispute'],
      ['[billing] event evt_1 charge.refunded unknown_org', 'UnknownOrg'],
      ['[billing] reconcile: subscription sub_1 names no organization of this back', 'UnknownOrg'],
      ['[billing] failed to cancel subscription sub_1 of deleted organization 3f0c (BillingUnavailable); cancel it in the Stripe dashboard', 'CancelFailed'],
      ['Error: The real webapp cannot start: the Stripe catalog of this live key is not ready: monthly has no live price', 'WebappStartRefused'],
      // Lines that are no alarm.
      ['[billing] reconcile done checked=2 mismatched=0 applied=0 failed=0 duration_ms=812', null],
      ['[billing] event evt_1 invoice.paid applied', null],
      ['[billing] event evt_1 charge.dispute.created duplicate', null],
      ['[api] listening on 0.0.0.0 port 8080', null],
    ];
    const terms = (pattern: string) => [...pattern.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map(match => (match[1] ?? match[2])!.replace(/\\(.)/g, '$1'));

    it('turns each alarming line into exactly its metric, and the rest into none', () => {
      const output = template();
      const filters = Object.values(output.findResources('AWS::Logs::MetricFilter')).map(filter => ({
        pattern: filter.Properties.FilterPattern as string,
        metric: (filter.Properties.MetricTransformations as Array<{ MetricNamespace: string; MetricName: string; MetricValue: string }>)[0]!,
      }));
      for (const filter of filters) expect(filter.metric).toMatchObject({ MetricNamespace: 'ARCA/Billing', MetricValue: '1' });
      const metricOf = Object.fromEntries(BILLING_ALARMS.map(alarm => [alarm.id, alarm.metricName]));
      for (const [line, alarm] of LINES) {
        const hits = [...new Set(filters.filter(filter => terms(filter.pattern).every(term => line.includes(term))).map(filter => filter.metric.MetricName))];
        expect(hits, line).toEqual(alarm ? [metricOf[alarm]] : []);
      }
    });

    it('raises one alarm per metric into a topic of its own that has no subscription yet', () => {
      const output = template();
      const topics = output.findResources('AWS::SNS::Topic');
      const billingTopic = Object.entries(topics).find(([, topic]) => topic.Properties.DisplayName === 'ARCA billing alerts (API logs)')?.[0];
      expect(billingTopic).toBeDefined();
      // The two email subscriptions are the host alerts'; nobody is subscribed to the billing topic until the founder does it.
      const subscriptions = Object.values(output.findResources('AWS::SNS::Subscription'));
      expect(subscriptions).toHaveLength(2);
      for (const subscription of subscriptions) expect(JSON.stringify(subscription.Properties.TopicArn)).not.toContain(billingTopic);
      const alarms = Object.values(output.findResources('AWS::CloudWatch::Alarm')).filter(alarm => alarm.Properties.Namespace === 'ARCA/Billing');
      expect(alarms.map(alarm => alarm.Properties.MetricName).sort()).toEqual(BILLING_ALARMS.map(alarm => alarm.metricName).sort());
      for (const alarm of alarms) {
        expect(alarm.Properties).toMatchObject({ Statistic: 'Sum', Period: 300, Threshold: 1, EvaluationPeriods: 1,
          ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching', AlarmActions: [{ Ref: billingTopic }] });
      }
      output.hasOutput('BillingAlertTopicArn', { Value: { Ref: billingTopic } });
    });

    it('lets the scoped CDK execution policy manage that log group and its filters, and nothing else of CloudWatch Logs', () => {
      const policy = JSON.parse(readFileSync(new URL('../cdk-execution-policy.json', import.meta.url), 'utf8')) as { Statement: Array<{
        Sid: string; Effect: string; Action: string | string[]; Resource: string | string[] }> };
      const logStatements = policy.Statement.filter(statement => [statement.Action].flat().some(action => action.startsWith('logs:')));
      expect(logStatements.map(statement => statement.Sid).sort()).toEqual(['ApiLogGroup', 'FindLogGroups']);
      const group = logStatements.find(statement => statement.Sid === 'ApiLogGroup')!;
      expect(group).toMatchObject({ Effect: 'Allow', Action: 'logs:*' });
      expect([group.Resource].flat().sort()).toEqual([
        'arn:aws:logs:us-east-1:194633188202:log-group:/arca/api', 'arn:aws:logs:us-east-1:194633188202:log-group:/arca/api:*']);
      const find = logStatements.find(statement => statement.Sid === 'FindLogGroups')!;
      expect(find).toMatchObject({ Effect: 'Allow', Action: 'logs:DescribeLogGroups' });
      // Spend stays out of reach whatever the stack grows into.
      expect(policy.Statement.find(statement => statement.Sid === 'NeverBillingBudgetsOrAccount')).toMatchObject({ Effect: 'Deny',
        Action: expect.arrayContaining(['billing:*', 'budgets:*', 'ce:*']) });
    });

    it('creates nothing about AWS spend: no budget, no billing alarm', () => {
      const output = template();
      output.resourceCountIs('AWS::Budgets::Budget', 0);
      const alarms = Object.values(output.findResources('AWS::CloudWatch::Alarm'));
      expect(alarms.some(alarm => alarm.Properties.Namespace === 'AWS/Billing')).toBe(false);
    });
  });

  it('reads runtime secrets from /arca/prod only', () => {
    const policies = JSON.stringify(template().findResources('AWS::IAM::Policy'));
    expect(policies).toContain('ssm:GetParametersByPath');
    expect(policies).toContain('parameter/arca/prod');
  });
});
