const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const SYSTEM_PATHS = process.platform === 'win32'
  ? [
      'C:\\Program Files\\MKVToolNix\\mkvmerge.exe',
      'C:\\Program Files (x86)\\MKVToolNix\\mkvmerge.exe',
    ]
  : process.platform === 'darwin'
  ? [
      '/Applications/MKVToolNix.app/Contents/MacOS/mkvmerge',
      '/usr/local/bin/mkvmerge',
      '/opt/homebrew/bin/mkvmerge',
    ]
  : [
      '/usr/bin/mkvmerge',
      '/usr/local/bin/mkvmerge',
      path.join(os.homedir(), '.local/bin/mkvmerge'),
    ];

let _toolsDir = null;
function setToolsDir(dir) { _toolsDir = dir; }

const BIN = process.platform === 'win32' ? 'mkvmerge.exe' : 'mkvmerge';

// Binary shipped inside the app package (extraResources → resources/vendor/)
function appBundledPath() {
  if (!process.resourcesPath) return null;
  const p = path.join(process.resourcesPath, 'vendor', BIN);
  return fs.existsSync(p) ? p : null;
}

// Binary previously downloaded by the app into userData/tools/
function userDownloadedPath() {
  if (!_toolsDir) return null;
  const p = path.join(_toolsDir, BIN);
  return fs.existsSync(p) ? p : null;
}

// Returns the path to a working mkvmerge, or null if not found.
function findMkvmerge() {
  // 1. Shipped inside the app package
  const app = appBundledPath();
  if (app) return app;

  // 2. Previously downloaded by the app into userData
  const downloaded = userDownloadedPath();
  if (downloaded) return downloaded;

  // 3. Check known system paths
  for (const p of SYSTEM_PATHS) {
    if (fs.existsSync(p)) return p;
  }

  // 3. Try PATH
  try {
    const cmd = process.platform === 'win32' ? 'where mkvmerge' : 'which mkvmerge';
    const result = execSync(cmd, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim().split('\n')[0].trim();
    if (result && fs.existsSync(result)) return result;
  } catch (_) {}

  return null;
}

// Returns an object describing what the user needs to do to install mkvmerge.
function getInstallGuide() {
  const hasHomebrew = (() => {
    try { execSync('which brew', { stdio: 'pipe' }); return true; } catch (_) { return false; }
  })();

  if (process.platform === 'darwin') {
    return {
      method: hasHomebrew ? 'homebrew' : 'manual',
      brewCommand: 'brew install mkvtoolnix',
      downloadUrl: 'https://mkvtoolnix.download/downloads.html#macosx',
      instructions: hasHomebrew
        ? 'Run in Terminal: brew install mkvtoolnix'
        : 'Download and install MKVToolNix from the official website.',
    };
  }
  if (process.platform === 'win32') {
    return {
      method: 'manual',
      downloadUrl: 'https://mkvtoolnix.download/downloads.html#windows',
      instructions: 'Download and install MKVToolNix from the official website.',
    };
  }
  // Linux
  return {
    method: 'package',
    packageCommand: 'sudo apt install mkvtoolnix  # or: sudo dnf install mkvtoolnix',
    downloadUrl: 'https://mkvtoolnix.download/downloads.html',
    instructions: 'Install mkvtoolnix via your package manager.',
  };
}

function getStatus() {
  const found = findMkvmerge();
  return {
    installed: !!found,
    path: found || null,
    guide: found ? null : getInstallGuide(),
  };
}

module.exports = { setToolsDir, findMkvmerge, getStatus };
