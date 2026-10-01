import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ArcaDemoStack } from './arca-demo-stack.js';

const template = () => Template.fromStack(new ArcaDemoStack(new cdk.App(), 'TestStack', {
  env: { account: '111111111111', region: 'us-east-1' },
  demoHostname: 'api.example.com',
  githubRepository: 'ArcaCover/Arca-back',
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

  it('lets only the main branch of one repository assume the GitHub deploy role', () => {
    const output = template();
    output.resourceCountIs('AWS::IAM::OIDCProvider', 1);
    output.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'arca-github-deploy',
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: { Statement: [Match.objectLike({
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: { StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': 'repo:ArcaCover/Arca-back:ref:refs/heads/main',
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

  it('reads runtime secrets from /arca/prod only', () => {
    const policies = JSON.stringify(template().findResources('AWS::IAM::Policy'));
    expect(policies).toContain('ssm:GetParametersByPath');
    expect(policies).toContain('parameter/arca/prod');
  });
});
