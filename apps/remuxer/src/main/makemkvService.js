const { spawn } = require('child_process');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAKEMKV_PATHS = process.platform === 'win32'
  ? [
      'C:\\Program Files (x86)\\MakeMKV\\makemkvcon64.exe',
      'C:\\Program Files\\MakeMKV\\makemkvcon64.exe',
      'C:\\Program Files (x86)\\MakeMKV\\makemkvcon.exe',
    ]
  : process.platform === 'darwin'
  ? [
      '/Applications/MakeMKV.app/Contents/MacOS/makemkvcon',
      '/usr/local/bin/makemkvcon',
      '/opt/homebrew/bin/makemkvcon',
    ]
  : [
      '/usr/bin/makemkvcon',
      '/usr/local/bin/makemkvcon',
      path.join(os.homedir(), '.local/bin/makemkvcon'),
    ];

let _dataPath = null;
function setDataPath(p) { _dataPath = p; }

// ── Binary detection ──────────────────────────────────────────────────────────

function findMakemkvcon() {
  for (const p of MAKEMKV_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const cmd = process.platform === 'win32' ? 'where makemkvcon' : 'which makemkvcon';
    const result = execSync(cmd, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim().split('\n')[0].trim();
    if (result && fs.existsSync(result)) return result;
  } catch (_) {}
  return null;
}

// ── Status ────────────────────────────────────────────────────────────────────

async function getStatus() {
  const makemkvcon = findMakemkvcon();
  return {
    installed: !!makemkvcon,
    path: makemkvcon || null,
  };
}

// ── Disc / title scanning ─────────────────────────────────────────────────────

async function listDiscs(makemkvcon) {
  const discs = [];

  const targets = [];
  for (let i = 0; i < 4; i++) targets.push(`disc:${i}`);
  if (process.platform === 'darwin') {
    try {
      const drutil = execSync('drutil status 2>/dev/null || true', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
      if (drutil.includes('Disc Inserted') || drutil.includes('BD-ROM') || drutil.includes('DVD-ROM')) {
        targets.push('dev:/dev/disk2', 'dev:/dev/disk3', 'dev:/dev/disk4');
      }
    } catch (_) {}
  }

  for (const target of targets) {
    try {
      const info = await getDiscInfoByTarget(makemkvcon, target);
      if (info) {
        const isDup = discs.some(d => d.discTitle === info.discTitle && info.discTitle);
        if (!isDup) discs.push({ index: discs.length, target, ...info });
      }
    } catch (_) {}
  }

  return discs;
}

async function getDiscInfoByTarget(makemkvcon, target) {
  return new Promise((resolve, reject) => {
    const proc = spawn(makemkvcon, ['--robot', 'info', target]);
    let out = '';
    let err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => { err += d; out += d; });
    const timer = setTimeout(() => proc.kill(), 60000);
    proc.on('close', code => {
      clearTimeout(timer);
      const lines = out.split('\n');

      const hardFail = lines.some(l =>
        l.startsWith('MSG:5010') || l.startsWith('MSG:5073') ||
        (l.includes('Failed to open') && !l.includes('TCOUNT'))
      );
      if (hardFail && code !== 0) return resolve(null);

      const info = parseDiscInfo(lines);
      if (!info || info.titles.length === 0) return resolve(null);
      resolve(info);
    });
    proc.on('error', reject);
  });
}

function parseDiscInfo(lines) {
  let discTitle = '';
  const titles = {};

  for (const line of lines) {
    const ci = line.match(/^CINFO:(\d+),\d+,"(.*)"/);
    if (ci) {
      const attr = parseInt(ci[1]);
      if (attr === 2) discTitle = ci[2];
      continue;
    }

    const ti = line.match(/^TINFO:(\d+),(\d+),\d+,"(.*)"/);
    if (ti) {
      const id = parseInt(ti[1]);
      const attr = parseInt(ti[2]);
      const val = ti[3];
      if (!titles[id]) titles[id] = { id };
      switch (attr) {
        case 2:  titles[id].name = val; break;
        case 9:  titles[id].chapters = parseInt(val) || 0; break;
        case 11: titles[id].duration = val; break;
        case 27: titles[id].filename = val; break;
        case 28: titles[id].sizeBytes = parseInt(val) || 0; break;
      }
      continue;
    }

    const si = line.match(/^SINFO:(\d+),(\d+),(\d+),\d+,"(.*)"/);
    if (si) {
      const titleId = parseInt(si[1]);
      const attr = parseInt(si[3]);
      const val = si[4];
      if (!titles[titleId]) titles[titleId] = { id: titleId };
      if (!titles[titleId].streams) titles[titleId].streams = [];
      if (attr === 1) {
        const last = titles[titleId].streams;
        if (!last.length || last[last.length - 1]._closed) {
          last.push({ typeCode: val, _closed: false });
        } else {
          last[last.length - 1].typeCode = val;
        }
      }
      if (attr === 3) {
        const s = titles[titleId].streams;
        if (s && s.length) s[s.length - 1].langName = val;
      }
      if (attr === 4) {
        const s = titles[titleId].streams;
        if (s && s.length) { s[s.length - 1].langCode = val; s[s.length - 1]._closed = true; }
      }
    }
  }

  const titleList = Object.values(titles)
    .filter(t => t.duration || t.filename)
    .map(t => ({
      id: t.id,
      name: t.name || `Title ${t.id + 1}`,
      duration: t.duration || '',
      chapters: t.chapters || 0,
      filename: t.filename || `title_t${String(t.id).padStart(2, '0')}.mkv`,
      sizeMB: t.sizeBytes ? Math.round(t.sizeBytes / 1024 / 1024) : 0,
      streams: (t.streams || []).filter(s => s._closed)
    }))
    .sort((a, b) => a.id - b.id);

  return { discTitle, titles: titleList };
}

// ── Ripping ───────────────────────────────────────────────────────────────────

let activeRip = null;

const RIP_STALL_MS  = 5 * 60_000;  // kill if no progress for 5 minutes
const RIP_MAX_MS    = 3 * 60 * 60_000; // absolute cap of 3 hours

async function ripTitle({ makemkvcon, discIndex, discTarget, titleId, outputDir, onProgress, onLog }) {
  fs.mkdirSync(outputDir, { recursive: true });

  const target = discTarget || `disc:${discIndex}`;
  const args = ['--robot', '--progress=-same', 'mkv', target, String(titleId), outputDir];

  return new Promise((resolve, reject) => {
    onLog?.(`Starting rip: disc ${discIndex}, title ${titleId} → ${outputDir}`);
    const proc = spawn(makemkvcon, args);
    activeRip = proc;

    let stderr = '';
    let outputFile = null;

    const abort = (reason) => { proc.kill(); reject(new Error(reason)); };
    const maxTimer   = setTimeout(() => abort(`Rip exceeded maximum time limit (${RIP_MAX_MS / 3600000}h)`), RIP_MAX_MS);
    let   stallTimer = setTimeout(() => abort('Rip stalled — no progress for 5 minutes'), RIP_STALL_MS);
    const resetStall = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => abort('Rip stalled — no progress for 5 minutes'), RIP_STALL_MS); };

    proc.stdout.on('data', d => {
      for (const line of d.toString().split('\n')) {
        const l = line.trim();
        if (!l) continue;

        const pv = l.match(/^PRGV:(\d+),(\d+),(\d+)/);
        if (pv) {
          const pct = parseInt(pv[3]) > 0 ? parseInt(pv[1]) / parseInt(pv[3]) : 0;
          onProgress?.(Math.min(pct, 1));
          resetStall();
          continue;
        }

        if (l.startsWith('PRGT:') || l.startsWith('PRGC:')) continue;

        const msg = l.match(/^MSG:\d+,\d+,\d+,"(.+?)"/);
        if (msg) { onLog?.(msg[1]); continue; }

        const fi = l.match(/^TINFO:\d+,27,\d+,"(.+?)"/);
        if (fi) outputFile = path.join(outputDir, fi[1]);
      }
    });

    proc.stderr.on('data', d => { stderr += d; onLog?.(d.toString().trim()); });

    proc.on('close', code => {
      clearTimeout(maxTimer); clearTimeout(stallTimer);
      activeRip = null;
      if (code === 0 || code === 1) {
        if (!outputFile) {
          const files = fs.readdirSync(outputDir)
            .filter(f => f.endsWith('.mkv'))
            .map(f => ({ f, mt: fs.statSync(path.join(outputDir, f)).mtimeMs }))
            .sort((a, b) => b.mt - a.mt);
          if (files.length) outputFile = path.join(outputDir, files[0].f);
        }
        if (outputFile && fs.existsSync(outputFile)) resolve(outputFile);
        else reject(new Error('Rip completed but output file not found'));
      } else {
        reject(new Error(`makemkvcon exited ${code}. ${stderr.slice(0, 200)}`));
      }
    });

    proc.on('error', e => { clearTimeout(maxTimer); clearTimeout(stallTimer); activeRip = null; reject(e); });
  });
}

function cancelRip() {
  if (activeRip) { activeRip.kill('SIGTERM'); activeRip = null; return true; }
  return false;
}

// ── Public API ─────────────────────────────────────────────────────────────────

module.exports = {
  setDataPath,
  findMakemkvcon,
  getStatus,
  listDiscs,
  ripTitle,
  cancelRip,
};
