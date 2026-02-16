#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('node:fs');
const path = require('node:path');

const fuses = require('@electron/fuses');

function usage() {
  console.log(`Usage:
  node scripts/verify-fuses.js --exe <path>
  node scripts/verify-fuses.js --platform <linux|win32|darwin> --appOutDir <dir>

Exit code:
  0  PASS
  1  FAIL
`);
}

function parseArgs(argv) {
  const out = { platform: null, appOutDir: null, exe: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--exe') out.exe = argv[++i];
    else if (a === '--platform') out.platform = argv[++i];
    else if (a === '--appOutDir') out.appOutDir = argv[++i];
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

function resolvePackagedElectronPath({ appOutDir, platform, productFilename }) {
  if (platform === 'win32') {
    return path.join(appOutDir, `${productFilename}.exe`);
  }
  if (platform === 'darwin') {
    return path.join(appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename);
  }
  return path.join(appOutDir, productFilename);
}

function inferProductFilename() {
  // eslint-disable-next-line global-require
  const pkg = require('../package.json');
  return pkg.name;
}

function getCurrentFuses(executablePath) {
  if (typeof fuses.getCurrentFuseWire === 'function') return fuses.getCurrentFuseWire(executablePath);
  throw new Error('Unsupported @electron/fuses API: expected getCurrentFuseWire() to exist');
}

function fuseOptionName(optionValue) {
  for (const [k, v] of Object.entries(fuses.FuseV1Options || {})) {
    if (typeof v === 'number' && v === optionValue) return k;
  }
  return String(optionValue);
}

function readFuseValueFromWire(wire, optionValue) {
  if (!wire || typeof wire !== 'object') return undefined;
  const raw = wire[String(optionValue)];
  if (raw === 49) return true;
  if (raw === 48) return false;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return undefined;
}

function assertFuses(executablePath, wire) {
  const expected = [
    [fuses.FuseV1Options.EnableNodeOptionsEnvironmentVariable, false],
    [fuses.FuseV1Options.EnableNodeCliInspectArguments, false],
    [fuses.FuseV1Options.RunAsNode, false],
    [fuses.FuseV1Options.OnlyLoadAppFromAsar, true],
    [fuses.FuseV1Options.EnableEmbeddedAsarIntegrityValidation, true]
  ];

  const failures = [];
  for (const [opt, want] of expected) {
    const got = readFuseValueFromWire(wire, opt);
    if (got !== want) {
      failures.push({ opt, want, got });
    }
  }

  if (failures.length > 0) {
    console.error('[verify-fuses] FAIL');
    console.error(`  executable: ${executablePath}`);
    for (const f of failures) {
      console.error(
        `  - ${fuseOptionName(f.opt)}: expected=${String(f.want)} actual=${String(f.got)}`
      );
    }
    return false;
  }

  console.log('[verify-fuses] PASS');
  console.log(`  executable: ${executablePath}`);
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  let executablePath = args.exe;
  if (!executablePath) {
    if (!args.platform || !args.appOutDir) {
      usage();
      process.exit(1);
    }
    const productFilename = inferProductFilename();
    executablePath = resolvePackagedElectronPath({
      appOutDir: args.appOutDir,
      platform: args.platform,
      productFilename
    });
  }

  if (!fs.existsSync(executablePath)) {
    throw new Error(`Executable not found: ${executablePath}`);
  }

  const wire = await getCurrentFuses(executablePath);
  const ok = assertFuses(executablePath, wire);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
