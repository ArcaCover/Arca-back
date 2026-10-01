import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface ArcaDemoStackProps extends cdk.StackProps {
  readonly demoHostname: string;
  /** owner/name of the only GitHub repository allowed to deploy, from its main branch. */
  readonly githubRepository: string;
  /** Addresses that receive host health alerts. Each one confirms its subscription by email. */
  readonly alertEmails: string[];
  readonly hostedZoneId?: string;
  readonly hostedZoneName?: string;
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, '../../..');
const encoded = (relativePath: string) => Buffer.from(readFileSync(path.join(repositoryRoot, relativePath), 'utf8')).toString('base64');
// Runtime secrets live here, one SecureString per environment variable.
export const SECRETS_PATH = '/arca/prod';
export const GITHUB_DEPLOY_ROLE_NAME = 'arca-github-deploy';

export class ArcaDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ArcaDemoStackProps) {
    super(scope, id, props);

    const repository = new ecr.Repository(this, 'Repository', {
      repositoryName: 'arca-demo',
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.AES_256,
      emptyOnDelete: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 20, description: 'Retain the latest 20 images for rollback' }],
    });

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.42.0.0/24'),
      // Named explicitly so synthesis never needs an availability-zone lookup in the account.
      availabilityZones: [`${this.region}a`],
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 27 }],
    });

    const securityGroup = new ec2.SecurityGroup(this, 'HostSecurityGroup', {
      vpc,
      description: 'Public HTTPS only; administration uses SSM',
      allowAllOutbound: true,
    });
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Caddy HTTP certificate challenge');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Caddy HTTPS');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(443), 'Caddy HTTP/3');

    const role = new iam.Role(this, 'HostRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'ARCA host: SSM administration, pull-only ECR access, read-only runtime secrets',
    });
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    repository.grantPull(role);
    // SecureStrings use the AWS managed aws/ssm key, whose key policy already lets SSM decrypt
    // for principals of this account, so no KMS statement is needed.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParametersByPath'],
      resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: SECRETS_PATH.slice(1) }),
        this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `${SECRETS_PATH.slice(1)}/*` })],
    }));

    // The host only gets the small bootstrap that pulls an image. Everything else it runs travels
    // inside the image being deployed (deploy/activate.sh), so it is versioned with the code.
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'dnf install -y docker',
      'systemctl enable --now docker',
      'systemctl enable --now amazon-ssm-agent',
      'mkdir -p /usr/local/lib/docker/cli-plugins /opt/arca/deploy',
      'curl -fsSL https://github.com/docker/compose/releases/download/v5.5.1/docker-compose-linux-x86_64 -o /usr/local/lib/docker/cli-plugins/docker-compose',
      "echo 'db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576  /usr/local/lib/docker/cli-plugins/docker-compose' | sha256sum -c -",
      'chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose',
      `echo '${encoded('deploy/deploy-image.sh')}' | base64 -d > /opt/arca/deploy/deploy-image.sh`,
      'chmod 0755 /opt/arca/deploy/deploy-image.sh',
      'chown -R root:root /opt/arca',
    );

    const instance = new ec2.Instance(this, 'Host', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.X86_64 }),
      securityGroup,
      role,
      userData,
      requireImdsv2: true,
      associatePublicIpAddress: true,
      blockDevices: [{ deviceName: '/dev/xvda', volume: ec2.BlockDeviceVolume.ebs(20, {
        encrypted: true,
        volumeType: ec2.EbsDeviceVolumeType.GP3,
        deleteOnTermination: true,
      }) }],
    });

    const elasticIp = new ec2.CfnEIP(this, 'ElasticIp', { domain: 'vpc' });
    new ec2.CfnEIPAssociation(this, 'ElasticIpAssociation', {
      allocationId: elasticIp.attrAllocationId,
      instanceId: instance.instanceId,
    });

    if (props.hostedZoneId && props.hostedZoneName) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.hostedZoneName,
      });
      new route53.ARecord(this, 'DemoDnsRecord', {
        zone,
        recordName: props.demoHostname,
        target: route53.RecordTarget.fromIpAddresses(elasticIp.ref),
        ttl: cdk.Duration.minutes(5),
      });
    }

    // GitHub Actions deploys without stored AWS keys: it exchanges its OIDC token for this role,
    // and only a workflow running on the main branch of one repository can do that.
    const github = new iam.OidcProviderNative(this, 'GithubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });
    const deployRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: GITHUB_DEPLOY_ROLE_NAME,
      description: `Push images and activate them on the ARCA host, from ${props.githubRepository} main only`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(github.oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${props.githubRepository}:ref:refs/heads/main`,
        },
      }),
    });
    repository.grantPullPush(deployRole);
    deployRole.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:DescribeImages'], resources: [repository.repositoryArn] }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand'],
      resources: [
        this.formatArn({ service: 'ec2', resource: 'instance', resourceName: instance.instanceId }),
        this.formatArn({ service: 'ssm', account: '', resource: 'document', resourceName: 'AWS-RunShellScript' }),
      ],
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:GetCommandInvocation'], resources: ['*'] }));
    deployRole.addToPolicy(new iam.PolicyStatement({ actions: ['cloudformation:DescribeStacks'], resources: [this.stackId] }));

    // Host health, not spend: billing and budgets stay outside this stack on purpose.
    const alerts = new sns.Topic(this, 'AlertTopic', { displayName: 'ARCA API host alerts' });
    for (const email of props.alertEmails) alerts.addSubscription(new subscriptions.EmailSubscription(email));
    const statusCheck = (metricName: string) => new cloudwatch.Metric({
      namespace: 'AWS/EC2', metricName, dimensionsMap: { InstanceId: instance.instanceId },
      statistic: 'Maximum', period: cdk.Duration.minutes(1),
    });
    const systemCheck = new cloudwatch.Alarm(this, 'SystemStatusCheckAlarm', {
      alarmDescription: 'AWS hardware or network failed under the ARCA host; the instance is recovered onto healthy hardware',
      metric: statusCheck('StatusCheckFailed_System'), threshold: 1, evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.MISSING,
    });
    systemCheck.addAlarmAction(new cloudwatchActions.Ec2Action(cloudwatchActions.Ec2InstanceAction.RECOVER));
    const instanceCheck = new cloudwatch.Alarm(this, 'InstanceStatusCheckAlarm', {
      alarmDescription: 'The ARCA host operating system stopped responding; the instance is rebooted',
      metric: statusCheck('StatusCheckFailed_Instance'), threshold: 1, evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.MISSING,
    });
    instanceCheck.addAlarmAction(new cloudwatchActions.Ec2Action(cloudwatchActions.Ec2InstanceAction.REBOOT));
    for (const alarm of [systemCheck, instanceCheck]) {
      alarm.addAlarmAction(new cloudwatchActions.SnsAction(alerts));
      alarm.addOkAction(new cloudwatchActions.SnsAction(alerts));
    }

    new cdk.CfnOutput(this, 'EcrRepositoryUri', { value: repository.repositoryUri });
    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new cdk.CfnOutput(this, 'ElasticIpAddress', { value: elasticIp.ref });
    new cdk.CfnOutput(this, 'DemoUrl', { value: `https://${props.demoHostname}` });
    new cdk.CfnOutput(this, 'GithubDeployRoleArn', { value: deployRole.roleArn });
    new cdk.CfnOutput(this, 'SecretsPath', { value: SECRETS_PATH });
  }
}
