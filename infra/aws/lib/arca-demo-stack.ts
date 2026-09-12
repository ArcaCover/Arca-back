import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export interface ArcaDemoStackProps extends cdk.StackProps {
  readonly demoHostname: string;
  readonly hostedZoneId?: string;
  readonly hostedZoneName?: string;
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, '../../..');
const encoded = (relativePath: string) => Buffer.from(readFileSync(path.join(repositoryRoot, relativePath), 'utf8')).toString('base64');

export class ArcaDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ArcaDemoStackProps) {
    super(scope, id, props);

    const repository = new ecr.Repository(this, 'Repository', {
      repositoryName: 'arca-demo',
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.AES_256,
      emptyOnDelete: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 20, description: 'Retain the latest 20 demo images' }],
    });

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.42.0.0/24'),
      maxAzs: 1,
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
      description: 'ARCA demo host: SSM administration and pull-only ECR access',
    });
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    repository.grantPull(role);

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
      `echo '${encoded('compose.yaml')}' | base64 -d > /opt/arca/compose.yaml`,
      `echo '${encoded('deploy/Caddyfile')}' | base64 -d > /opt/arca/deploy/Caddyfile`,
      `echo '${encoded('deploy/deploy-image.sh')}' | base64 -d > /opt/arca/deploy/deploy-image.sh`,
      `echo '${encoded('.env.demo.example')}' | base64 -d > /opt/arca/.env.demo.example`,
      'touch /opt/arca/.env.demo',
      'chmod 0600 /opt/arca/.env.demo',
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

    new cdk.CfnOutput(this, 'EcrRepositoryUri', { value: repository.repositoryUri });
    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new cdk.CfnOutput(this, 'ElasticIpAddress', { value: elasticIp.ref });
    new cdk.CfnOutput(this, 'DemoUrl', { value: `https://${props.demoHostname}` });
  }
}
