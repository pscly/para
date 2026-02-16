/* eslint-disable no-console */

const fs = require('node:fs');
const path = require('node:path');

const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

function resolvePackagedElectronPath({ appOutDir, electronPlatformName, productFilename }) {
  if (electronPlatformName === 'win32') {
    return path.join(appOutDir, `${productFilename}.exe`);
  }

  if (electronPlatformName === 'darwin') {
    return path.join(
      appOutDir,
      `${productFilename}.app`,
      'Contents',
      'MacOS',
      productFilename
    );
  }

  // linux
  return path.join(appOutDir, productFilename);
}

module.exports = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const electronPlatformName = context.electronPlatformName;

  // electron-builder 侧的标准“产品文件名”（跨平台、无扩展名）
  const productFilename =
    context.packager?.appInfo?.productFilename ||
    context.packager?.appInfo?.productName ||
    'electron-app';

  const executablePath = resolvePackagedElectronPath({
    appOutDir,
    electronPlatformName,
    productFilename
  });

  if (!fs.existsSync(executablePath)) {
    throw new Error(
      `[afterPack-fuses] Packaged executable not found: ${executablePath} (appOutDir=${appOutDir}, platform=${electronPlatformName}, productFilename=${productFilename})`
    );
  }

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
