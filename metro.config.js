const fs = require('fs');
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

const backendRoot = path.resolve(projectRoot, 'backend');
function realBackendRoot() {
  try {
    return fs.realpathSync(backendRoot);
  } catch {
    return backendRoot;
  }
}
const backendRootReal = realBackendRoot();

function isPathInsideDir(filePath, dir) {
  if (!filePath || !dir) return false;
  let rel;
  try {
    rel = path.relative(dir, filePath);
  } catch {
    return false;
  }
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

const backendRootPosix = backendRootReal.replace(/\\/g, '/');
const backendRootEscaped = backendRootPosix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
config.resolver.blockList = [
  ...(config.resolver.blockList ?? []),
  new RegExp(`^${backendRootEscaped}(/|$).*`),
  /[/\\]backend[/\\]node_modules[/\\]/,
];

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const result = context.resolveRequest(context, moduleName, platform);
  if (result?.type === 'sourceFile' && result.filePath) {
    let realFile;
    try {
      realFile = fs.realpathSync(result.filePath);
    } catch {
      realFile = result.filePath;
    }
    if (isPathInsideDir(realFile, backendRootReal)) {
      throw new Error(
        '[Metro] «backend»-mappen er Node/Express-API-et og kan ikke bundles i Expo-appen. ' +
          'Start den med: cd backend && npm run dev. ' +
          `Avviste modul «${moduleName}» (${realFile}). ` +
          'Sjekk at ingen fil i appen importerer noe fra ./backend.',
      );
    }
  }
  return result;
};

module.exports = config;
