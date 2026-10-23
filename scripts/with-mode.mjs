// Runs a command with ARCA_MODE set (DN-09 4). Variables set here win over .env.local, which is never edited.
// Usage: node scripts/with-mode.mjs <production|live-debug|mock> <command…>
import { spawn } from 'node:child_process';

// The same list as apps/api/src/config/mode.ts; the API refuses anything else on start anyway.
const MODES = ['production', 'live-debug', 'mock'];
const [mode, ...command] = process.argv.slice(2);
if (!MODES.includes(mode) || command.length === 0) {
  console.error(`Usage: node scripts/with-mode.mjs <${MODES.join('|')}> <command…>`);
  process.exit(1);
}
// mock would override these anyway; setting them here keeps the API banner free of overrides.
const env = { ...process.env, ARCA_MODE: mode, ...(mode === 'mock' ? { SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory' } : {}) };
const child = spawn(command.join(' '), { env, shell: true, stdio: 'inherit' });
// Ctrl+C reaches the child from the terminal as well: wait for it to stop and report its exit code.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('error', error => { console.error(`[with-mode] ${error.message}`); process.exit(1); });
child.on('exit', code => process.exit(code ?? 1));
