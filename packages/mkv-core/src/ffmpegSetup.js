'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BIN = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

const SYSTEM_PATHS = process.platform === 'win32'
  ? ['C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']
  : process.platform === 'darwin'
  ? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']
  : ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'];

let _toolsDir = null;
function setToolsDir(dir) { _toolsDir = dir; }

function appBundledPath() {
  if (process.resourcesPath) {
    const p = path.join(process.resourcesPath, 'vendor', BIN);
    if (fs.existsSync(p)) return p;
  }
  const devPaths = [
    path.join(__dirname, '../../../apps/merger/vendor', BIN),
    path.join(__dirname, '../../../apps/remuxer/vendor', BIN),
  ];
  for (const p of devPaths) { if (fs.existsSync(p)) return p; }
  return null;
}

function userPath() {
  if (!_toolsDir) return null;
  const p = path.join(_toolsDir, BIN);
  return fs.existsSync(p) ? p : null;
}

function findFfmpeg() {
  const a = appBundledPath(); if (a) return a;
  const u = userPath(); if (u) return u;
  for (const p of SYSTEM_PATHS) if (fs.existsSync(p)) return p;
  try {
    const cmd = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
    const r = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n')[0].trim();
    if (r && fs.existsSync(r)) return r;
  } catch (_) {}
  return null;
}

function getStatus() {
  const found = findFfmpeg();
  return { installed: !!found, path: found || null };
}

module.exports = { setToolsDir, findFfmpeg, getStatus };
