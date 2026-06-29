'use strict';
/**
 * OCR service for converting PGS (Blu-ray) subtitle tracks to SRT.
 *
 * Architecture:
 *   1. mkvextract → .sup (PGS binary) file
 *   2. pgs-parser (npm) → subtitle frame objects with image buffers
 *   3. tesseract CLI → text per frame (parallel workers, one per CPU)
 *   4. SRT assembly
 *
 * Requires: MKVToolNix (mkvextract) + Tesseract CLI (brew install tesseract)
 * Optional: Python + pgsrip/pgsocr for non-Latin scripts with better accuracy
 */

const { spawn, execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Tool detection ─────────────────────────────────────────────────────────────

// Directories that GUI-launched apps miss because the OS does not load the
// shell profile: Homebrew, pip --user and the Tesseract installer all live
// outside the minimal PATH a desktop launcher hands to the process.
const EXTRA_BIN_DIRS = process.platform === 'win32'
  ? [
      'C:\\Program Files\\Tesseract-OCR',
      'C:\\Program Files (x86)\\Tesseract-OCR',
    ]
  : [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      path.join(os.homedir(), '.local', 'bin'),
    ];

// Extensions a bare command may carry on Windows (PATHEXT essentials).
const WIN_EXES = ['.exe', '.cmd', '.bat'];

async function which(cmd) {
  // 1) Honour PATH via the system resolver.
  const fromPath = await new Promise(resolve => {
    const tool = process.platform === 'win32' ? 'where' : 'which';
    execFile(tool, [cmd], { timeout: 3000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim().split('\n')[0] || null);
    });
  });
  if (fromPath) return fromPath;

  // 2) Fall back to common install dirs missing from a GUI app's PATH.
  const names = process.platform === 'win32'
    ? (path.extname(cmd) ? [cmd] : WIN_EXES.map(ext => cmd + ext))
    : [cmd];
  for (const dir of EXTRA_BIN_DIRS) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        await fs.promises.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch (_) { /* not here, keep looking */ }
    }
  }
  return null;
}

async function runCmd(bin, args, timeout = 5000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

/**
 * Detect what OCR tools are available.
 * Returns { tesseract, pgsrip, pgsocr, gpu }
 */
async function getStatus(customTesseractPath) {
  const result = {
    tesseract: { installed: false, version: null, path: null, langs: [] },
    pgsrip:    { installed: false, path: null },
    pgsocr:    { installed: false, path: null, gpu: false },
    gpu:       { type: null, name: null },
  };

  // Tesseract
  const tessPath = customTesseractPath || await which('tesseract');
  if (tessPath) {
    try {
      const ver = await runCmd(tessPath, ['--version']);
      result.tesseract.installed = true;
      result.tesseract.path = tessPath;
      result.tesseract.version = (ver.match(/tesseract\s+([^\n\s]+)/i) || [])[1] || '?';
      const langsOut = await runCmd(tessPath, ['--list-langs']);
      result.tesseract.langs = langsOut.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('List'));
    } catch (_) {}
  }

  // pgsrip (Python-based, CPU Tesseract wrapper)
  const pgsripPath = await which('pgsrip');
  if (pgsripPath) {
    result.pgsrip.installed = true;
    result.pgsrip.path = pgsripPath;
  }

  // pgsocr (Python-based, supports GPU models)
  const pgsocrPath = await which('pgsocr');
  if (pgsocrPath) {
    try {
      result.pgsocr.installed = true;
      result.pgsocr.path = pgsocrPath;
      // Check if GPU model available
      const py = await which('python3') || await which('python');
      if (py) {
        try {
          await runCmd(py, ['-c', 'import torch; assert torch.backends.mps.is_available() or torch.cuda.is_available()']);
          result.pgsocr.gpu = true;
        } catch (_) {}
      }
    } catch (_) {}
  }

  // GPU info (best-effort)
  if (process.platform === 'darwin') {
    result.gpu.type = 'Metal';
    result.gpu.name = 'Apple Silicon / AMD';
  } else {
    try {
      const nvOut = await runCmd('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']);
      if (nvOut) { result.gpu.type = 'CUDA'; result.gpu.name = nvOut.split('\n')[0].trim(); }
    } catch (_) {}
  }

  return result;
}

// ── mkvextract helper ──────────────────────────────────────────────────────────

function findMkvextract(mkvmergePath) {
  if (mkvmergePath) {
    const dir = path.dirname(mkvmergePath);
    const ext = process.platform === 'win32' ? '.exe' : '';
    const candidate = path.join(dir, 'mkvextract' + ext);
    if (fs.existsSync(candidate)) return candidate;
  }
  // Fallback: try PATH
  return process.platform === 'win32' ? 'mkvextract.exe' : 'mkvextract';
}

async function extractTrackToFile(mkvmergePath, inputFile, trackId, outputFile) {
  const mkvextract = findMkvextract(mkvmergePath);
  return new Promise((resolve, reject) => {
    const proc = spawn(mkvextract, ['tracks', inputFile, `${trackId}:${outputFile}`]);
    let err = '';
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => {
      if (code !== 0 && code !== 1) reject(new Error(`mkvextract failed (${code}): ${err.slice(0, 200)}`));
      else if (!fs.existsSync(outputFile)) reject(new Error('mkvextract produced no output file'));
      else resolve(outputFile);
    });
    proc.on('error', reject);
  });
}

// ── Tesseract per-image OCR ────────────────────────────────────────────────────

async function tessOcrBuffer(tesseractPath, imageBuffer, lang, tmpDir) {
  const tmpPng = path.join(tmpDir, `tess_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  const tmpOut = tmpPng.replace(/\.png$/, '');
  try {
    fs.writeFileSync(tmpPng, imageBuffer);
    await runCmd(tesseractPath, [
      tmpPng, tmpOut,
      '-l', lang || 'eng',
      '--psm', '6',   // assume uniform block of text
      '--oem', '1',   // LSTM engine (best accuracy)
    ], 10000);
    const txtFile = tmpOut + '.txt';
    const text = fs.existsSync(txtFile) ? fs.readFileSync(txtFile, 'utf8').trim() : '';
    if (fs.existsSync(txtFile)) fs.unlinkSync(txtFile);
    return text;
  } finally {
    if (fs.existsSync(tmpPng)) fs.unlinkSync(tmpPng);
  }
}

// ── PGS parser + parallel OCR ─────────────────────────────────────────────────

function pgsAvailable() {
  try { require('pgs-parser'); return true; } catch (_) { return false; }
}

function formatSrtTimestamp(ms) {
  const h   = Math.floor(ms / 3600000);
  const m   = Math.floor((ms % 3600000) / 60000);
  const s   = Math.floor((ms % 60000) / 1000);
  const mil = ms % 1000;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(mil).padStart(3,'0')}`;
}

async function convertPgsToSrtNative(supFile, lang, tesseractPath, tmpDir, onProgress) {
  const { parsePgs, renderSubtitle } = require('pgs-parser');
  const raw = fs.readFileSync(supFile);
  const subs = parsePgs(raw); // [{ start, end, image }] — image is a Buffer (PNG)

  if (!subs || subs.length === 0) return '';

  const workerCount = Math.min(os.cpus().length, 4);
  const results = new Array(subs.length);
  let done = 0;
  let idx  = 0;

  await new Promise((resolve, reject) => {
    let active = 0;

    function next() {
      while (active < workerCount && idx < subs.length) {
        const i = idx++;
        active++;
        const sub = subs[i];
        const imgBuf = sub.image instanceof Buffer ? sub.image : renderSubtitle(sub);

        tessOcrBuffer(tesseractPath, imgBuf, lang, tmpDir)
          .then(text => {
            results[i] = { start: sub.start, end: sub.end, text };
            done++;
            onProgress?.(done / subs.length);
            active--;
            if (done === subs.length) resolve();
            else next();
          })
          .catch(err => { reject(err); });
      }
    }
    next();
  });

  // Build SRT
  let srt = '';
  let num = 1;
  for (const r of results) {
    if (!r.text) continue;
    srt += `${num}\n${formatSrtTimestamp(Math.round(r.start / 1e6))} --> ${formatSrtTimestamp(Math.round(r.end / 1e6))}\n${r.text}\n\n`;
    num++;
  }
  return srt;
}

// ── pgsrip subprocess fallback ─────────────────────────────────────────────────

async function convertPgsToSrtPgsrip(pgsripPath, supFile, lang, outputDir, onProgress) {
  return new Promise((resolve, reject) => {
    const args = ['--language', lang || 'eng', supFile];
    const proc = spawn(pgsripPath, args, { cwd: outputDir });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; onProgress?.(null); });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`pgsrip failed (${code}): ${stderr.slice(0, 200)}`));
      // pgsrip creates the .srt alongside the .sup file
      const srtPath = supFile.replace(/\.sup$/i, '.srt');
      if (fs.existsSync(srtPath)) resolve(fs.readFileSync(srtPath, 'utf8'));
      else reject(new Error('pgsrip produced no .srt file'));
    });
    proc.on('error', reject);
  });
}

// ── pgsocr subprocess (GPU-capable) ───────────────────────────────────────────

async function convertPgsToSrtPgsocr(pgsocrPath, supFile, lang, outputDir, useGpu, onProgress) {
  return new Promise((resolve, reject) => {
    const args = ['--language', lang || 'eng'];
    if (useGpu) args.push('--model', 'florence2');
    args.push(supFile);
    const proc = spawn(pgsocrPath, args, { cwd: outputDir });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; onProgress?.(null); });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`pgsocr failed (${code}): ${stderr.slice(0, 200)}`));
      const srtPath = supFile.replace(/\.sup$/i, '.srt');
      if (fs.existsSync(srtPath)) resolve(fs.readFileSync(srtPath, 'utf8'));
      else reject(new Error('pgsocr produced no .srt file'));
    });
    proc.on('error', reject);
  });
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Convert a PGS subtitle track from an MKV to SRT text.
 *
 * opts: { mkvmergePath, lang, useGpu, engine, customTesseractPath }
 * onProgress: (0-1) fraction complete, or null if indeterminate
 *
 * Returns the SRT string.
 */
async function convertPgsToSrt(inputMkv, trackId, opts, onProgress) {
  const {
    mkvmergePath, lang = 'eng', useGpu = false, engine = 'auto',
    customTesseractPath,
  } = opts || {};

  const status = await getStatus(customTesseractPath);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkv-ocr-'));

  try {
    // Extract PGS track to .sup file
    onProgress?.(0);
    const supFile = path.join(tmpDir, `track_${trackId}.sup`);
    await extractTrackToFile(mkvmergePath, inputMkv, trackId, supFile);
    onProgress?.(0.05);

    // Choose engine
    const wantEngine = engine === 'auto'
      ? (status.pgsocr.installed && status.pgsocr.gpu && useGpu ? 'pgsocr'
        : status.pgsrip.installed ? 'pgsrip'
        : pgsAvailable() && status.tesseract.installed ? 'native'
        : null)
      : engine;

    if (!wantEngine) {
      throw new Error(
        'No OCR engine available. Install Tesseract (brew install tesseract) or pgsrip (pip install pgsrip).'
      );
    }

    let srt = '';

    if (wantEngine === 'pgsocr') {
      srt = await convertPgsToSrtPgsocr(
        status.pgsocr.path, supFile, tessLang(lang),
        tmpDir, useGpu,
        frac => onProgress?.(0.05 + frac * 0.9)
      );
    } else if (wantEngine === 'pgsrip') {
      srt = await convertPgsToSrtPgsrip(
        status.pgsrip.path, supFile, tessLang(lang),
        tmpDir,
        frac => onProgress?.(0.05 + (frac ?? 0.5) * 0.9)
      );
    } else {
      // Native: pgs-parser + tesseract CLI
      srt = await convertPgsToSrtNative(
        supFile, tessLang(lang),
        status.tesseract.path,
        tmpDir,
        frac => onProgress?.(0.05 + frac * 0.9)
      );
    }

    onProgress?.(1);
    return srt;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// Convert ISO 639-3 lang code to Tesseract language code
function tessLang(iso3) {
  const MAP = {
    eng: 'eng', spa: 'spa', fra: 'fra', deu: 'deu', ita: 'ita',
    por: 'por', jpn: 'jpn', zho: 'chi_sim', chi: 'chi_sim',
    kor: 'kor', rus: 'rus', ara: 'ara', pol: 'pol', nld: 'nld',
    swe: 'swe', nor: 'nor', dan: 'dan', fin: 'fin', ces: 'ces',
    hun: 'hun', ell: 'ell', tur: 'tur', heb: 'heb', ukr: 'ukr',
    ron: 'ron', hrv: 'hrv', srp: 'srp', bul: 'bul', slk: 'slk',
    slv: 'slv', cat: 'cat',
  };
  return MAP[iso3] || iso3 || 'eng';
}

module.exports = { getStatus, convertPgsToSrt, pgsAvailable };
