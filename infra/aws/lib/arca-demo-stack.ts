import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface ArcaDemoStackProps extends cdk.StackProps {
  readonly demoHostname: string;
  /** owner/name of the only GitHub repository allowed to deploy, from its main branch. */
  readonly githubRepository: string;
  /**
   * Numeric owner and repository ids. Repositories on GitHub's immutable OIDC subjects sign
   * `repo:Owner@ownerId/Name@repoId:...` instead of `repo:Owner/Name:...`; both are accepted.
   */
  readonly githubRepositoryIds?: { readonly owner: number; readonly repository: number };
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
/** Pilot's secrets (DN-14 §5): its own database, its access token and its keys, apart from production's. */
export const PILOT_SECRETS_PATH = '/arca/pilot';
export const GITHUB_DEPLOY_ROLE_NAME = 'arca-github-deploy';
// The API container's logs (Docker's awslogs driver, deploy/compose.cloudwatch.yaml). deploy/activate.sh names it too.
// The host's Amazon Linux 2023 image, pinned. "The latest image" resolves at every deploy, and a newer one replaces the
// instance: the API goes down, the host's disk is deleted and the image has to be deployed again. Moving to a newer image
// is a deliberate change of this id, which replaces the host on the next cdk deploy.
export const HOST_AMI_ID = 'ami-065101b35d4f06f41';

export const API_LOG_GROUP_NAME = '/arca/api';
export const BILLING_METRIC_NAMESPACE = 'ARCA/Billing';

/**
 * The alarms on the API's billing lines (DN-13 §9.5, T26). Each one counts the log lines that hold every term of one of its patterns
 * (a CloudWatch filter pattern of quoted terms); the lines themselves are written by apps/api/src/webapp (billing-events.ts,
 * reconcile-schedule.ts, service.ts) and compose.ts. One such line in five minutes raises the alarm.
 */
export const BILLING_ALARMS: ReadonlyArray<{ id: string; metricName: string; description: string; patterns: ReadonlyArray<readonly string[]> }> = [
  { id: 'ReconcileFailed', metricName: 'ReconcileFailures', patterns: [['[billing] reconcile failed']],
    description: 'The daily Stripe reconciliation failed, or could not read a subscription: the API log says which' },
  { id: 'ReconcileMismatch', metricName: 'ReconcileMismatches', patterns: [['[billing] reconcile mismatch']],
    description: 'The daily reconciliation found a subscription the back had wrong (a lost webhook) and corrected it: check why' },
  { id: 'WebhookFailed', metricName: 'WebhookFailures',
    patterns: [['[billing] event', 'failed ('], ['[billing] event', 'refused: livemode=']],
    description: 'A Stripe webhook failed to process (Stripe retries it) or came from the other Stripe mode (a misconfigured endpoint)' },
  { id: 'DuplicateSubscription', metricName: 'DuplicateSubscriptions', patterns: [['[billing] duplicate_subscription']],
    description: 'An organization pays two live subscriptions: cancel and refund one in the Stripe dashboard' },
  { id: 'Dispute', metricName: 'Disputes', patterns: [['[billing] dispute']],
    description: 'A customer disputed a charge: answer it in the Stripe dashboard before its deadline' },
  { id: 'UnknownOrg', metricName: 'UnknownOrgEvents',
    patterns: [['[billing] event', 'unknown_org'], ['[billing] reconcile: subscription', 'names no organization']],
    description: 'A Stripe event or subscription names no organization of the back (a dispute always does, for now)' },
  { id: 'CancelFailed', metricName: 'CancelFailures', patterns: [['[billing] failed to cancel subscription']],
    description: 'An approved deletion could not cancel its Stripe subscription: cancel it in the Stripe dashboard' },
  { id: 'WebappStartRefused', metricName: 'WebappStartRefusals', patterns: [['The real webapp cannot start']],
    description: 'The API refused to start the real webapp (for example the Stripe catalog of its key is not ready) and keeps restarting' },
];

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
    // The API's logs, shipped by Docker's awslogs driver once deploy/activate.sh finds this group (DN-13 §9.5). Three months, then gone.
    const apiLogs = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: API_LOG_GROUP_NAME,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    apiLogs.grantWrite(role);
    // activate.sh looks the group up before pointing the driver at it.
    role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:DescribeLogStreams'], resources: [apiLogs.logGroupArn] }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParametersByPath'],
      resources: [SECRETS_PATH, PILOT_SECRETS_PATH].flatMap(path => [
        this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: path.slice(1) }),
        this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `${path.slice(1)}/*` })]),
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
      machineImage: ec2.MachineImage.genericLinux({ 'us-east-1': HOST_AMI_ID }),
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
    const [owner, name] = props.githubRepository.split('/');
    // main deploys production; pilot deploys the pilot project (deploy/pilot), which activate.sh keeps apart from production.
    const branches = ['main', 'pilot'];
    const subjects = branches.map(branch => `repo:${props.githubRepository}:ref:refs/heads/${branch}`);
    if (props.githubRepositoryIds) {
      for (const branch of branches) {
        subjects.push(`repo:${owner}@${props.githubRepositoryIds.owner}/${name}@${props.githubRepositoryIds.repository}:ref:refs/heads/${branch}`);
      }
    }
    const deployRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: GITHUB_DEPLOY_ROLE_NAME,
      description: `Push images and activate them on the ARCA host, from ${props.githubRepository} main and pilot only`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(github.oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': subjects.length === 1 ? subjects[0]! : subjects,
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

    // The payment lines of the API's logs (DN-13 §9.5, T26), into a topic of their own. It is created with no subscription on
    // purpose: the founder subscribes an email to it (aws sns subscribe, or the console) and confirms it. Stripe billing of
    // customers only; AWS spend, budgets and cost settings stay outside this stack.
    const billingAlerts = new sns.Topic(this, 'BillingAlertTopic', { displayName: 'ARCA billing alerts (API logs)' });
    for (const alarm of BILLING_ALARMS) {
      alarm.patterns.forEach((terms, index) => new logs.MetricFilter(this, `${alarm.id}Filter${index || ''}`, {
        logGroup: apiLogs, metricNamespace: BILLING_METRIC_NAMESPACE, metricName: alarm.metricName,
        filterPattern: logs.FilterPattern.allTerms(...terms), metricValue: '1',
      }));
      new cloudwatch.Alarm(this, `${alarm.id}Alarm`, {
        alarmDescription: alarm.description,
        metric: new cloudwatch.Metric({ namespace: BILLING_METRIC_NAMESPACE, metricName: alarm.metricName, statistic: 'Sum',
          period: cdk.Duration.minutes(5) }),
        threshold: 1, evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        // No line, no alarm: a quiet log is a healthy one.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new cloudwatchActions.SnsAction(billingAlerts));
    }

    new cdk.CfnOutput(this, 'EcrRepositoryUri', { value: repository.repositoryUri });
    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new cdk.CfnOutput(this, 'ElasticIpAddress', { value: elasticIp.ref });
    new cdk.CfnOutput(this, 'DemoUrl', { value: `https://${props.demoHostname}` });
    new cdk.CfnOutput(this, 'GithubDeployRoleArn', { value: deployRole.roleArn });
    new cdk.CfnOutput(this, 'SecretsPath', { value: SECRETS_PATH });
    new cdk.CfnOutput(this, 'ApiLogGroupName', { value: apiLogs.logGroupName });
    new cdk.CfnOutput(this, 'BillingAlertTopicArn', { value: billingAlerts.topicArn });
  }
}
