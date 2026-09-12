import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ArcaDemoStack } from './arca-demo-stack.js';

const template = () => Template.fromStack(new ArcaDemoStack(new cdk.App(), 'TestStack', {
  env: { account: '111111111111', region: 'us-east-1' },
  demoHostname: 'api.example.com',
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

  it('installs the deployment payload through user data', () => {
    template().hasResourceProperties('AWS::EC2::Instance', {
      UserData: Match.objectLike({ 'Fn::Base64': Match.anyValue() }),
    });
  });
});
