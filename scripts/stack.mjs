// Starts the back and the front together in the same mode, so neither can be left in another one (DN-09 4).
// Usage: npm run stack -- <production|live-debug|mock>
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// The same list as apps/api/src/config/mode.ts.
const MODES = ['production', 'live-debug', 'mock'];
const mode = process.argv[2];
if (!MODES.includes(mode)) {
  console.error(`Usage: npm run stack -- <${MODES.join('|')}>`);
  process.exit(1);
}
const back = fileURLToPath(new URL('..', import.meta.url));
const front = fileURLToPath(new URL('../../Arca-front', import.meta.url));
if (!existsSync(front)) {
  console.error(`[stack] Arca-front not found at ${front}`);
  process.exit(1);
}

// PORT belongs to the API. Next reads it as well, so the front does not inherit it and keeps its own port.
const { PORT, ...inherited } = process.env;
const children = [
  start('back', 'npm run dev', back, { ...process.env, ARCA_MODE: mode,
    ...(mode === 'mock' ? { SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory' } : {}) }),
  // webpack, because Turbopack hangs on this machine.
  start('front', 'npm run dev -- --webpack', front, { ...inherited, NEXT_PUBLIC_ARCA_MODE: mode,
    NEXT_PUBLIC_API_URL: `http://localhost:${PORT ?? 8080}` }),
];

let stopping = false;
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) continue;
    // A shell sits in between, so killing the child alone would leave npm, tsx or next running: end the whole tree.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  }
}

function start(name, command, cwd, env) {
  const child = spawn(command, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  for (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    createInterface({ input, crlfDelay: Infinity }).on('line', line => output.write(`[${name}] ${line}\n`));
  }
  child.on('error', error => {
    console.error(`[stack] ${name} could not start: ${error.message}`);
    stopAll(1);
  });
  // Half a stack is not the stack: when one side stops, the other goes too.
  child.on('exit', code => {
    if (stopping) return;
    console.error(`[stack] ${name} exited with code ${code}; stopping the rest`);
    stopAll(code ?? 1);
  });
  return child;
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
