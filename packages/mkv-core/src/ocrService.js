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

async function extractTracksToFiles(mkvmergePath, inputFile, specs, onProgress) {
  const mkvextract = findMkvextract(mkvmergePath);
  const args = ['tracks', inputFile, ...specs.map(s => `${s.trackId}:${s.outputFile}`)];
  return new Promise((resolve, reject) => {
    const proc = spawn(mkvextract, args);
    let err = '';
    proc.stdout.on('data', d => {
      const m = /Progress:\s*(\d+)%/.exec(d.toString());
      if (m) onProgress?.(Number(m[1]) / 100);
    });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      // mkvextract exits 1 for non-fatal warnings while still producing output.
      if (code !== 0 && code !== 1) return reject(new Error(`mkvextract failed (${code}): ${err.slice(0, 200)}`));
      const missing = specs.filter(s => !fs.existsSync(s.outputFile));
      if (missing.length) return reject(new Error(`mkvextract produced no output for track(s) ${missing.map(s => s.trackId).join(', ')}`));
      resolve();
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

// pgsrip/pgsocr name the output after the .sup base and drop the language code
// we embedded, inserting the detected one instead ("track_8.eng.sup" →
// "track_8.en.srt"). Locate it by base name rather than guessing the suffix.
function findProducedSrt(supFile) {
  const dir = path.dirname(supFile);
  const base = path.basename(supFile).replace(/\.sup$/i, '').replace(/\.[^.]+$/, '');
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc}\\.[^.]*\\.srt$|^${esc}\\.srt$`, 'i');
  const match = fs.readdirSync(dir).find(f => re.test(f));
  return match ? path.join(dir, match) : null;
}

async function convertPgsToSrtPgsrip(pgsripPath, supFile, lang, outputDir, onProgress) {
  return new Promise((resolve, reject) => {
    // pgsrip filters input by language, derived from the file name. The .sup is
    // named "<base>.<lang>.sup" so the requested --language matches; otherwise
    // pgsrip treats it as "und", silently skips it, exits 0 and writes nothing.
    const args = ['--language', lang || 'und', supFile];
    const proc = spawn(pgsripPath, args, { cwd: outputDir });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; onProgress?.(null); });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`pgsrip failed (${code}): ${(stderr || stdout).slice(0, 200)}`));
      const srtPath = findProducedSrt(supFile);
      if (srtPath) return resolve(fs.readFileSync(srtPath, 'utf8'));
      const detail = (stdout || stderr).trim().split('\n').pop() || 'track skipped';
      reject(new Error(`pgsrip produced no .srt file — ${detail}`));
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
      if (code !== 0) return reject(new Error(`pgsocr failed (${code}): ${(stderr || stdout).slice(0, 200)}`));
      const srtPath = findProducedSrt(supFile);
      if (srtPath) return resolve(fs.readFileSync(srtPath, 'utf8'));
      reject(new Error('pgsocr produced no .srt file'));
    });
    proc.on('error', reject);
  });
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Run the chosen OCR engine on an already-extracted .sup file.
 *
 * pgsrip/pgsocr receive the ISO 639 code (they map it to Tesseract data
 * themselves); the native engine gets the Tesseract language code directly.
 */
async function ocrSupFile(supFile, lang, status, opts, tmpDir, onProgress) {
  const { useGpu = false, engine = 'auto' } = opts || {};

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

  if (wantEngine === 'pgsocr') {
    return convertPgsToSrtPgsocr(
      status.pgsocr.path, supFile, lang, tmpDir, useGpu,
      frac => onProgress?.(frac ?? 0.5)
    );
  }
  if (wantEngine === 'pgsrip') {
    return convertPgsToSrtPgsrip(
      status.pgsrip.path, supFile, lang, tmpDir,
      frac => onProgress?.(frac ?? 0.5)
    );
  }
  return convertPgsToSrtNative(
    supFile, tessLang(lang), status.tesseract.path, tmpDir,
    frac => onProgress?.(frac ?? 0.5)
  );
}

/**
 * Convert several PGS subtitle tracks from one file to SRT in a single pass.
 *
 * Every track is demuxed with one mkvextract invocation, so the (potentially
 * huge) source is read from disk only once instead of once per track.
 *
 * tracks: [{ id, lang }]   lang is an ISO 639 code (e.g. "eng", "spa")
 * opts:   { mkvmergePath, useGpu, engine, customTesseractPath }
 * onProgress: (0-1) overall fraction, or null if indeterminate
 *
 * Returns [{ trackId, srt }] / [{ trackId, error }] — one entry per track, so a
 * single failed track does not abort the others.
 */
async function convertPgsTracksToSrt(inputMkv, tracks, opts, onProgress) {
  const { mkvmergePath, customTesseractPath } = opts || {};
  const status = await getStatus(customTesseractPath);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkv-ocr-'));

  try {
    // The .sup is named "track_<id>.<lang>.sup" so pgsrip's language filter
    // accepts it (see convertPgsToSrtPgsrip).
    const specs = tracks.map(t => {
      const lang = t.lang || 'und';
      return { trackId: t.id, lang, outputFile: path.join(tmpDir, `track_${t.id}.${lang}.sup`) };
    });

    // Single demux pass — the bulk of the wait, so progress maps to the first half.
    onProgress?.(0);
    await extractTracksToFiles(mkvmergePath, inputMkv, specs, frac => onProgress?.(frac * 0.5));
    onProgress?.(0.5);

    const results = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const base = 0.5 + (i / specs.length) * 0.5;
      const span = (1 / specs.length) * 0.5;
      try {
        const srt = await ocrSupFile(
          spec.outputFile, spec.lang, status, opts, tmpDir,
          frac => onProgress?.(base + frac * span)
        );
        results.push({ trackId: spec.trackId, srt });
      } catch (err) {
        results.push({ trackId: spec.trackId, error: err });
      }
    }

    onProgress?.(1);
    return results;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * Convert a single PGS subtitle track from a file to SRT text.
 *
 * opts: { mkvmergePath, lang, useGpu, engine, customTesseractPath }
 * onProgress: (0-1) fraction complete, or null if indeterminate
 *
 * Returns the SRT string.
 */
async function convertPgsToSrt(inputMkv, trackId, opts, onProgress) {
  const lang = (opts && opts.lang) || 'und';
  const [result] = await convertPgsTracksToSrt(
    inputMkv, [{ id: trackId, lang }], opts, onProgress
  );
  if (result.error) throw result.error;
  return result.srt;
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

module.exports = { getStatus, convertPgsToSrt, convertPgsTracksToSrt, pgsAvailable };
