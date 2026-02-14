#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientRoot = path.resolve(__dirname, '..');

const isLinux = process.platform === 'linux';
const hasDisplay = Boolean(process.env.DISPLAY);
const shouldUseXvfb = isLinux && !hasDisplay;

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd, args, { cwd = clientRoot } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'inherit',
      env: process.env
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${cmd} exited with signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function main() {
  const buildCode = await run(npmCmd, ['run', 'build']);
  if (buildCode !== 0) process.exit(buildCode);

  const passthrough = process.argv.slice(2);
  const playwrightViaNpmExec = [
    npmCmd,
    'exec',
    '--',
    'playwright',
    'test',
    ...passthrough
  ];

  if (shouldUseXvfb) {
    try {
      const code = await run('xvfb-run', ['-a', ...playwrightViaNpmExec]);
      process.exit(code);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        console.error('[e2e] xvfb-run not found; falling back to direct Playwright run');
      } else {
        throw err;
      }
    }
  }

  const code = await run(npmCmd, ['exec', '--', 'playwright', 'test', ...passthrough]);
  process.exit(code);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
