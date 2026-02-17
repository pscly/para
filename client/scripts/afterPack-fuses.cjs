/* eslint-disable no-console */

const fs = require('node:fs');
const path = require('node:path');

const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

const EXCLUDED_HELPER_BINARIES = new Set([
  'chrome-sandbox',
  'chrome_crashpad_handler',
  'chrome-sandbox.exe',
  'chrome_crashpad_handler.exe'
]);

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

function resolvePackagedElectronPath({ appOutDir, electronPlatformName, executableBaseName }) {
  if (electronPlatformName === 'win32') {
    return path.join(appOutDir, `${executableBaseName}.exe`);
  }

  if (electronPlatformName === 'darwin') {
    return path.join(
      appOutDir,
      `${executableBaseName}.app`,
      'Contents',
      'MacOS',
      executableBaseName
    );
  }

  // linux
  return path.join(appOutDir, executableBaseName);
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

function isProbablyMainExecutableCandidate({ name, fullPath, electronPlatformName }) {
  if (!name || isExcludedBinaryName(name)) return false;

  if (electronPlatformName === 'win32') {
    if (!name.toLowerCase().endsWith('.exe')) return false;
    // Windows 下无法依赖可执行位，存在即视为候选。
    try {
      return fs.statSync(fullPath).isFile();
    } catch {
      return false;
    }
  }

  if (electronPlatformName === 'darwin') {
    // 在 .app/Contents/MacOS 下，主 binary 通常无扩展名且有可执行位。
    return isPosixExecutableFile(fullPath);
  }

  // linux：过滤掉带扩展名的资源/库文件，避免误选 .so/.pak/.dat 等。
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

function locateMainExecutablePath({ appOutDir, electronPlatformName, candidateBaseNames }) {
  const dedupedBaseNames = uniqTruthy(candidateBaseNames);
  const tried = [];

  for (const baseName of dedupedBaseNames) {
    const p = resolvePackagedElectronPath({
      appOutDir,
      electronPlatformName,
      executableBaseName: baseName
    });
    tried.push(p);
    const name = path.basename(p);
    if (!fs.existsSync(p)) continue;
    if (!isProbablyMainExecutableCandidate({ name, fullPath: p, electronPlatformName })) continue;
    return { executablePath: p, triedPaths: tried, candidateBaseNames: dedupedBaseNames };
  }

  // 扫描兜底：仅在所有候选都不存在/不合格时启用。
  if (electronPlatformName === 'darwin') {
    // 先定位 .app 再在 Contents/MacOS 里挑选最大的可执行文件。
    const listing = safeReaddirBasenames(appOutDir);
    const appDirs = listing.filter((n) => n.endsWith('.app'));
    const appDir =
      appDirs.find((n) => dedupedBaseNames.some((bn) => n === `${bn}.app`)) ||
      (appDirs.length === 1 ? appDirs[0] : null);

    if (appDir) {
      const macosDir = path.join(appOutDir, appDir, 'Contents', 'MacOS');
      const macosListing = safeReaddirBasenames(macosDir);
      const macosCandidates = macosListing
        .filter((n) => !isExcludedBinaryName(n))
        .map((n) => ({ name: n, fullPath: path.join(macosDir, n) }))
        .filter((c) => isProbablyMainExecutableCandidate({
          name: c.name,
          fullPath: c.fullPath,
          electronPlatformName
        }));

      const best = pickLargestBySize(macosCandidates);
      if (best) {
        return { executablePath: best.fullPath, triedPaths: tried, candidateBaseNames: dedupedBaseNames };
      }
    }
  } else {
    const listing = safeReaddirBasenames(appOutDir);
    const fileCandidates = listing
      .filter((n) => !isExcludedBinaryName(n))
      .map((n) => ({ name: n, fullPath: path.join(appOutDir, n) }))
      .filter((c) => isProbablyMainExecutableCandidate({
        name: c.name,
        fullPath: c.fullPath,
        electronPlatformName
      }));

    const best = pickLargestBySize(fileCandidates);
    if (best) {
      return { executablePath: best.fullPath, triedPaths: tried, candidateBaseNames: dedupedBaseNames };
    }
  }

  const listing = safeReaddirBasenames(appOutDir);
  const candidateList = dedupedBaseNames.length > 0 ? JSON.stringify(dedupedBaseNames) : '[]';
  const listingList = listing.length > 0 ? JSON.stringify(listing) : '[]';
  const triedList = tried.length > 0 ? JSON.stringify(tried.map((p) => path.basename(p))) : '[]';
  throw new Error(
    `[afterPack-fuses] Packaged executable not found. ` +
      `appOutDir=${appOutDir} platform=${electronPlatformName} ` +
      `candidates=${candidateList} triedBasenames=${triedList} listing=${listingList}`
  );
}

module.exports = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const electronPlatformName = context.electronPlatformName;

  // 注意：electron-builder 的 productName/productFilename 不一定等于 Linux dir 的主可执行文件名。
  // 这里按“多候选 + 扫描兜底”定位，避免硬阻断 CI/release。
  // eslint-disable-next-line global-require
  const pkg = require('../package.json');

  const platformKey =
    electronPlatformName === 'win32' ? 'win' : electronPlatformName === 'darwin' ? 'mac' : 'linux';
  const build = (pkg && pkg.build) || {};
  const buildPlatform = (build && build[platformKey]) || {};

  const candidateBaseNames = uniqTruthy([
    // 1) electron-builder runtime 信息（如果存在，优先级最高）
    context.packager?.appInfo?.executableName,
    context.packager?.config?.[platformKey]?.executableName,
    context.packager?.config?.executableName,
    // 2) package.json build.executableName / build.<platform>.executableName
    buildPlatform.executableName,
    build.executableName,
    // 3) package.json name（当前项目 Linux dir 实际就是这个）
    pkg.name,
    // 4) 最后才考虑 productFilename/productName（可能含空格且与 exe 不一致）
    context.packager?.appInfo?.productFilename,
    context.packager?.appInfo?.productName
  ]);

  const { executablePath } = locateMainExecutablePath({
    appOutDir,
    electronPlatformName,
    candidateBaseNames
  });

  console.log(`[afterPack-fuses] Flipping fuses: ${executablePath}`);

  // 反调试/反编译基线：禁调试入口 + 强制仅从 asar 加载 + 启用 asar 完整性校验
  // 注意：这些 fuse 必须在打包阶段 flip（运行时无效/不允许）。
  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true
  });

  console.log('[afterPack-fuses] Fuses flipped');
};
