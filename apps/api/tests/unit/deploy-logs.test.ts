import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The API's logs in CloudWatch (DN-13 §9.5, T26): Docker's awslogs driver, in a compose override that deploy/activate.sh installs on
// the host only once the log group of infra/aws exists (cdk deploy). Until then, and on any machine but the host, the logs stay
// in json-file as before, so a deploy never depends on the stack having been deployed first. No Docker runs here: the tests read
// the files, like the Caddyfile's.
const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
const OVERRIDE = read('deploy/compose.cloudwatch.yaml');
const ACTIVATE = read('deploy/activate.sh');
const COMPOSE = read('compose.yaml');
const STACK = read('infra/aws/lib/arca-demo-stack.ts');
const code = (text: string) => text.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n');

describe('API logs to CloudWatch (DN-13 §9.5, T26)', () => {
  it('sends only the API container to the stack\'s log group, replacing its logging, without blocking it', () => {
    const override = code(OVERRIDE);
    expect(override).toMatch(/^services:\n {2}api:\n {4}logging: !override\n {6}driver: awslogs\n {6}options:\n/);
    expect(override).not.toMatch(/^ {2}proxy:/m);
    expect(override).toMatch(/^ {8}awslogs-group: \/arca\/api$/m);
    expect(STACK).toContain("API_LOG_GROUP_NAME = '/arca/api'");
    expect(override).toMatch(/^ {8}awslogs-region: \$\{ARCA_AWS_REGION:\?[^}]+\}$/m);
    expect(override).toMatch(/^ {8}awslogs-create-group: "false"$/m);
    // A slow CloudWatch drops lines from a bounded buffer rather than stall the API's stdout.
    expect(override).toMatch(/^ {8}mode: non-blocking$/m);
    expect(override).toMatch(/^ {8}max-buffer-size: \d+m$/m);
    // json-file's options would be refused by awslogs: the override replaces the block, it does not merge into it.
    expect(override).not.toMatch(/max-size|max-file/);
  });

  it('keeps compose.yaml on json-file, so nothing changes off the host or before the stack', () => {
    expect(COMPOSE).not.toContain('awslogs');
    expect(COMPOSE.match(/driver: json-file/g)).toHaveLength(2);
  });

  it('names the override only when the host can reach the log group, and drops a stale one otherwise', () => {
    const script = code(ACTIVATE);
    const probe = script.indexOf('aws logs describe-log-streams --region "$region" --log-group-name /arca/api');
    expect(probe).toBeGreaterThan(0);
    expect(script.slice(0, probe)).toMatch(/^files=\(-f compose\.yaml\)$/m);
    const branch = script.slice(probe, script.indexOf('\nfi', probe));
    expect(branch).toMatch(/then\n {2}install -m 0644 "\$payload\/compose\.cloudwatch\.yaml" "\$root\/compose\.cloudwatch\.yaml"\n {2}files\+=\(-f compose\.cloudwatch\.yaml\)/);
    expect(branch).toMatch(/else\n {2}rm -f "\$root\/compose\.cloudwatch\.yaml"/);
    // Never under the name compose merges by default (compose.override.yaml): a rollback to an image from before this change runs
    // plain `docker compose`, which must not pick it up.
    expect(script).not.toContain('compose.override.yaml');
    // Every compose call reads the same files, after the probe.
    const calls = script.split('\n').filter(line => /^docker compose /.test(line));
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call).toMatch(/^docker compose "\$\{files\[@\]\}" --env-file \.env\.demo /);
    expect(probe).toBeLessThan(script.indexOf('docker compose "${files[@]}" --env-file .env.demo config'));
    // The region the override interpolates travels in the rendered environment, before it replaces .env.demo.
    expect(script).toMatch(/printf 'ARCA_AWS_REGION=%s\\n' "\$region" >> "\$rendered"/);
    // Production's own move: the pilot branch of activate.sh, above it, moves its own file.
    expect(script.indexOf('ARCA_AWS_REGION')).toBeLessThan(script.indexOf('mv -f "$rendered" "$root/.env.demo"'));
  });

  it('ships the override inside the image, with the rest of the deploy payload', () => {
    expect(read('Dockerfile')).toMatch(/^COPY compose\.yaml deploy\/Caddyfile deploy\/production\.env deploy\/activate\.sh deploy\/render-env\.py deploy\/compose\.cloudwatch\.yaml \.\/deploy-payload\/$/m);
  });
});
