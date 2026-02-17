#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('node:fs');
const path = require('node:path');

const fuses = require('@electron/fuses');

const EXCLUDED_HELPER_BINARIES = new Set([
  'chrome-sandbox',
  'chrome_crashpad_handler',
  'chrome-sandbox.exe',
  'chrome_crashpad_handler.exe'
]);

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

function uniqTruthy(list) {
  const out = [];
  const seen = new Set();
  for (const v of list || []) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function safeReaddirBasenames(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isExcludedBinaryName(name) {
  return EXCLUDED_HELPER_BINARIES.has(name);
}

function isPosixExecutableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    const st = fs.statSync(filePath);
    return st.isFile();
  } catch {
    return false;
  }
}

function isProbablyMainExecutableCandidate({ name, fullPath, platform }) {
  if (!name || isExcludedBinaryName(name)) return false;

  if (platform === 'win32') {
    if (!name.toLowerCase().endsWith('.exe')) return false;
    try {
      return fs.statSync(fullPath).isFile();
    } catch {
      return false;
    }
  }

  if (platform === 'darwin') {
    return isPosixExecutableFile(fullPath);
  }

  // linux：避免误选 .so/.pak/.dat 等资源。
  if (name.includes('.')) return false;
  return isPosixExecutableFile(fullPath);
}

function pickLargestBySize(candidates) {
  let best = null;
  for (const c of candidates) {
    if (!c) continue;
    let size = 0;
    try {
      size = fs.statSync(c.fullPath).size;
    } catch {
      size = 0;
    }
    if (!best || size > best.size) best = { ...c, size };
  }
  return best;
}

function resolveCandidateExecutablePath({ appOutDir, platform, executableBaseName }) {
  if (platform === 'win32') {
    return path.join(appOutDir, `${executableBaseName}.exe`);
  }
  if (platform === 'darwin') {
    const appBundleDir = appOutDir.endsWith('.app')
      ? appOutDir
      : path.join(appOutDir, `${executableBaseName}.app`);
    return path.join(appBundleDir, 'Contents', 'MacOS', executableBaseName);
  }
  return path.join(appOutDir, executableBaseName);
}

function locateMainExecutablePath({ appOutDir, platform, candidateBaseNames }) {
  const dedupedBaseNames = uniqTruthy(candidateBaseNames);
  const tried = [];

  for (const baseName of dedupedBaseNames) {
    const p = resolveCandidateExecutablePath({ appOutDir, platform, executableBaseName: baseName });
    tried.push(p);
    const name = path.basename(p);
    if (!fs.existsSync(p)) continue;
    if (!isProbablyMainExecutableCandidate({ name, fullPath: p, platform })) continue;
    return { executablePath: p, candidateBaseNames: dedupedBaseNames, triedPaths: tried };
  }

  // 扫描兜底：仅在候选都失败时启用。
  let extraListing = null;
  if (platform === 'darwin') {
    const topListing = safeReaddirBasenames(appOutDir);
    const appDirs = topListing.filter((n) => n.endsWith('.app'));
    const appDirName =
      appDirs.find((n) => dedupedBaseNames.some((bn) => n === `${bn}.app`)) ||
      (appDirs.length === 1 ? appDirs[0] : null);

    const appBundleDir = appOutDir.endsWith('.app') ? appOutDir : appDirName ? path.join(appOutDir, appDirName) : null;
    if (appBundleDir) {
      const macosDir = path.join(appBundleDir, 'Contents', 'MacOS');
      const macosListing = safeReaddirBasenames(macosDir);
      extraListing = { macosDir, macosListing };

      const macosCandidates = macosListing
        .filter((n) => !isExcludedBinaryName(n))
        .map((n) => ({ name: n, fullPath: path.join(macosDir, n) }))
        .filter((c) => isProbablyMainExecutableCandidate({ name: c.name, fullPath: c.fullPath, platform }));

      const best = pickLargestBySize(macosCandidates);
      if (best) {
        return { executablePath: best.fullPath, candidateBaseNames: dedupedBaseNames, triedPaths: tried };
      }
    }
  } else {
    const listing = safeReaddirBasenames(appOutDir);
    const fileCandidates = listing
      .filter((n) => !isExcludedBinaryName(n))
      .map((n) => ({ name: n, fullPath: path.join(appOutDir, n) }))
      .filter((c) => isProbablyMainExecutableCandidate({ name: c.name, fullPath: c.fullPath, platform }));

    const best = pickLargestBySize(fileCandidates);
    if (best) {
      return { executablePath: best.fullPath, candidateBaseNames: dedupedBaseNames, triedPaths: tried };
    }
  }

  const listing = safeReaddirBasenames(appOutDir);
  const candidateList = dedupedBaseNames.length > 0 ? JSON.stringify(dedupedBaseNames) : '[]';
  const listingList = listing.length > 0 ? JSON.stringify(listing) : '[]';
  const triedList = tried.length > 0 ? JSON.stringify(tried.map((p) => path.basename(p))) : '[]';
  const extra = extraListing
    ? ` macosDir=${extraListing.macosDir} macosListing=${JSON.stringify(extraListing.macosListing || [])}`
    : '';

  throw new Error(
    `[verify-fuses] Packaged executable not found. ` +
      `appOutDir=${appOutDir} platform=${platform} candidates=${candidateList} ` +
      `triedBasenames=${triedList} listing=${listingList}${extra}`
  );
}

function inferExecutableBaseNames(platform) {
  // eslint-disable-next-line global-require
  const pkg = require('../package.json');
  const build = (pkg && pkg.build) || {};
  const platformKey = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux';
  const buildPlatform = (build && build[platformKey]) || {};

  return uniqTruthy([
    // 1) build.<platform>.executableName / build.executableName
    buildPlatform.executableName,
    build.executableName,
    // 2) package.json name（当前项目 Linux dir 产物为该值）
    pkg.name,
    // 3) 最后才考虑 productName（可能与可执行文件名不一致，尤其是 Linux dir）
    typeof build.productName === 'string' ? build.productName : null
  ]);
}

function inferDefaultAppOutDir(platform) {
  const clientRoot = path.resolve(__dirname, '..');

  if (platform === 'win32') return path.join(clientRoot, 'dist-electron', 'win-unpacked');
  if (platform === 'darwin') {
    const macDir = path.join(clientRoot, 'dist-electron', 'mac');
    if (fs.existsSync(macDir)) return macDir;
    return path.join(clientRoot, 'dist-electron', 'mac-unpacked');
  }
  return path.join(clientRoot, 'dist-electron', 'linux-unpacked');
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
  let platform = args.platform;
  let appOutDir = args.appOutDir;

  if (!platform) platform = process.platform;
  if (!appOutDir) appOutDir = inferDefaultAppOutDir(platform);

  // npm -C client 会把 cwd 切到 client/；但在其它调用方式下也应稳定工作。
  if (appOutDir && !path.isAbsolute(appOutDir)) {
    appOutDir = path.resolve(process.cwd(), appOutDir);
  }

  if (!executablePath) {
    const baseNames = inferExecutableBaseNames(platform);
    const located = locateMainExecutablePath({ appOutDir, platform, candidateBaseNames: baseNames });
    executablePath = located.executablePath;
  }

  if (!executablePath || !fs.existsSync(executablePath)) {
    throw new Error(`[verify-fuses] Executable not found: ${executablePath || '<empty>'}`);
  }

  const wire = await getCurrentFuses(executablePath);
  const ok = assertFuses(executablePath, wire);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
