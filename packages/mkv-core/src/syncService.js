'use strict';
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const path = require('path');
const ffmpegSetup = require('./ffmpegSetup');

const WORKER_PATH = path.join(__dirname, 'syncWorker.js');

// Run the O(N×M) cross-correlation in a dedicated worker thread so the
// main process event loop stays responsive during long audio analysis.
function crossCorrelate(bufA, bufB) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData: { bufA, bufB } });
    worker.on('message', resolve);
    worker.on('error', reject);
    worker.on('exit', code => {
      if (code !== 0) reject(new Error(`syncWorker exited with code ${code}`));
    });
  });
}

const EXTRACT_RATE    = 8000;          // Hz — PCM extraction rate fed to the worker
const WINDOW_SEC      = 30;            // seconds of audio per sample point
const MIN_CONF        = 0.25;          // minimum correlation confidence to accept a measurement
const SAMPLE_NORMAL   = [0.05, 0.50, 0.82];             // same-language: dialogue is distinctive
const SAMPLE_FALLBACK = [0.05, 0.25, 0.45, 0.65, 0.82]; // effects-only: more points to compensate
const LOWPASS_HZ      = 300;           // cut-off for music/effects fallback (no dialogue above ~300 Hz)

/**
 * Analyze sync between sources[0] (reference) and each additional source.
 * sources: [{ file, tracks }]
 * tracks must include { type:'video', duration (ns) }
 *
 * Returns [{ sourceIndex, status, offsetMs, speedCorrection, confidence, lagSamples }]
 * status: 'in-sync' | 'offset' | 'drift' | 'different-cuts' | 'no-ffmpeg' | 'failed' | 'too-short'
 * speedCorrection: null | { originalMs, adjustedMs }  (for mkvmerge --sync TID:delay,orig/adj)
 */
async function analyzeSyncSources(sources, onLog) {
  const ffmpeg = ffmpegSetup.findFfmpeg();
  if (!ffmpeg) {
    return sources.slice(1).map((_, i) => ({
      sourceIndex: i + 1, status: 'no-ffmpeg', offsetMs: 0,
      speedCorrection: null, confidence: 0
    }));
  }

  const durations = sources.map(s => {
    const vid = (s.tracks || []).find(t => t.type === 'video');
    return vid ? (vid.duration ?? 0) / 1e9 : 0; // ns → s
  });

  const refDuration = durations[0];
  const results = [];

  for (let i = 1; i < sources.length; i++) {
    const srcDuration = durations[i];
    const minDur = Math.min(refDuration, srcDuration);
    const durationDiffMs = Math.abs(refDuration - srcDuration) * 1000;

    onLog?.(`${'─'.repeat(48)}`);
    onLog?.(`Sync  S1 vs S${i + 1}`);
    onLog?.(`  S1 duration: ${fmtDuration(refDuration)}  S${i + 1}: ${fmtDuration(srcDuration)}  Δ=${durationDiffMs < 1 ? '<1' : (refDuration > srcDuration ? '+' : '-') + Math.round(durationDiffMs)}ms`);

    if (minDur < 60) {
      onLog?.(`  ✗ Too short for analysis (${fmtDuration(minDur)} < 60s)`);
      results.push({ sourceIndex: i, status: 'too-short', offsetMs: 0, speedCorrection: null, confidence: 0 });
      continue;
    }

    // Duration within 100ms → identical release, skip correlation
    if (durationDiffMs < 100) {
      onLog?.(`  ✓ Identical release — durations match within ${Math.round(durationDiffMs)}ms, no correction needed`);
      results.push({ sourceIndex: i, status: 'in-sync', offsetMs: 0, speedCorrection: null, confidence: 1 });
      continue;
    }

    // Pick matching-language audio streams for correlation
    const { idxA, idxB, lang: audioLang } = pickAudioStreamIndex(
      sources[0].tracks || [], sources[i].tracks || []
    );
    const useFallback = !audioLang;
    if (audioLang) {
      onLog?.(`  Using [${audioLang}] audio stream for correlation (S1:a:${idxA} ↔ S${i + 1}:a:${idxB})`);
    } else {
      onLog?.(`  No common audio language — correlating music/effects only (lowpass ${LOWPASS_HZ} Hz, ${SAMPLE_FALLBACK.length} samples)`);
    }

    const sampleFractions = useFallback ? SAMPLE_FALLBACK : SAMPLE_NORMAL;
    const points = sampleFractions
      .map(f => Math.floor(minDur * f))
      .filter(t => t + WINDOW_SEC < minDur);

    onLog?.(`  Sampling audio at ${points.map(t => fmtTime(t)).join(', ')} (${WINDOW_SEC}s windows)…`);

    const lags = [], times = [], confs = [];

    for (const pt of points) {
      try {
        const [bufA, bufB] = await Promise.all([
          extractPcm(ffmpeg, sources[0].file, pt, WINDOW_SEC, idxA, useFallback),
          extractPcm(ffmpeg, sources[i].file, pt, WINDOW_SEC, idxB, useFallback),
        ]);
        const { lagMs, confidence } = await crossCorrelate(bufA, bufB);
        const sign = lagMs >= 0 ? '+' : '';
        const confPct = Math.round(confidence * 100);
        const accepted = confidence >= MIN_CONF;
        onLog?.(`  @${fmtTime(pt)}: lag=${sign}${lagMs}ms  conf=${confPct}%${accepted ? '' : '  (low confidence, ignored)'}`);
        if (accepted) { lags.push(lagMs); times.push(pt); confs.push(confidence); }
      } catch (e) {
        onLog?.(`  @${fmtTime(pt)}: sample failed — ${e.message}`);
      }
    }

    if (lags.length === 0) {
      onLog?.(`  ✗ All samples below confidence threshold (${Math.round(MIN_CONF * 100)}%) — audio may be silence or incompatible`);
      results.push({ sourceIndex: i, status: 'failed', offsetMs: 0, speedCorrection: null, confidence: 0 });
      continue;
    }

    const avgConf = confs.reduce((a, b) => a + b, 0) / confs.length;
    const spread  = Math.max(...lags) - Math.min(...lags);
    const avgLag  = Math.round(lags.reduce((a, b) => a + b, 0) / lags.length);

    if (lags.length === 1 || spread < 150) {
      if (Math.abs(avgLag) < 100) {
        onLog?.(`  ✓ In sync — offset ${avgLag >= 0 ? '+' : ''}${avgLag}ms is within tolerance, no correction needed`);
        results.push({ sourceIndex: i, status: 'in-sync', offsetMs: 0, speedCorrection: null, confidence: avgConf });
      } else {
        const hint = Math.abs(avgLag) < 2000
          ? 'minor sync difference (re-encode or container change)'
          : 'large sync difference (possibly different sync master or HDR/SDR variant)';
        onLog?.(`  ✓ Constant offset ${avgLag >= 0 ? '+' : ''}${avgLag}ms — ${hint}`);
        onLog?.(`    Applying: --sync TID:${avgLag} to audio+subtitle tracks of S${i + 1}`);
        results.push({ sourceIndex: i, status: 'offset', offsetMs: avgLag, speedCorrection: null, confidence: avgConf });
      }
      continue;
    }

    // Check for linear drift (speed difference)
    if (lags.length >= 2) {
      const n = lags.length;
      const xMean = times.reduce((a, b) => a + b, 0) / n;
      const yMean = lags.reduce((a, b) => a + b, 0) / n;
      const ssXY  = times.reduce((s, x, i2) => s + (x - xMean) * (lags[i2] - yMean), 0);
      const ssXX  = times.reduce((s, x) => s + (x - xMean) ** 2, 0);
      const slope = ssXX === 0 ? 0 : ssXY / ssXX; // ms/s

      if (Math.abs(slope) >= 0.5) {
        const offsetMs   = Math.round(yMean - slope * xMean);
        const refMs      = Math.round(refDuration * 1000);
        const adjustedMs = Math.round(refMs * (1 + slope / 1000));
        const driftPerMin = (Math.abs(slope) * 60).toFixed(1);
        const absSlopePct = Math.abs(slope / 10); // ms/s → % of speed

        // Human-readable cause hint
        let cause = 'encode speed variance';
        if (Math.abs(absSlopePct - 4.1) < 0.3)  cause = 'NTSC↔PAL (23.976↔25fps)';
        else if (Math.abs(absSlopePct - 0.1) < 0.05) cause = '23.976↔24fps conversion';
        else if (absSlopePct > 2)                cause = 'significant frame-rate difference';

        onLog?.(`  ✓ Speed drift detected: ${slope >= 0 ? '+' : ''}${slope.toFixed(2)}ms/s (${driftPerMin}ms/min) → ${cause}`);
        onLog?.(`    At t=0: ${offsetMs >= 0 ? '+' : ''}${offsetMs}ms offset  |  total over ${fmtDuration(refDuration)}: ~${Math.round(Math.abs(slope) * refDuration)}ms`);
        onLog?.(`    Applying: --sync TID:${offsetMs},${refMs}/${adjustedMs} to audio+subtitle tracks of S${i + 1}`);
        results.push({
          sourceIndex: i, status: 'drift', offsetMs,
          speedCorrection: { originalMs: refMs, adjustedMs },
          confidence: avgConf
        });
        continue;
      }
    }

    // Spread too high, not linear → different cuts
    const lagStr = lags.map(l => (l >= 0 ? '+' : '') + l + 'ms').join(' → ');
    onLog?.(`  ✗ Inconsistent offsets (${lagStr}, spread=${spread}ms) — different edit versions`);
    onLog?.(`    No auto-correction applied. Verify tracks manually or use a single source.`);
    results.push({ sourceIndex: i, status: 'different-cuts', offsetMs: 0, speedCorrection: null, confidence: avgConf, lags });
  }

  onLog?.(`${'─'.repeat(48)}`);

  return results;
}

/**
 * Find the 0-based audio stream index in each source that shares a language.
 * Prefers the first language present in both. Falls back to index 0 if none match.
 * Returns { idxA, idxB, lang } — lang is null when no common language was found.
 */
function pickAudioStreamIndex(tracksA, tracksB) {
  const audiosA = tracksA.filter(t => t.type === 'audio');
  const audiosB = tracksB.filter(t => t.type === 'audio');

  for (let a = 0; a < audiosA.length; a++) {
    const lang = audiosA[a].lang;
    if (!lang || lang === 'und') continue;
    const b = audiosB.findIndex(t => t.lang === lang);
    if (b !== -1) return { idxA: a, idxB: b, lang };
  }

  return { idxA: 0, idxB: 0, lang: null };
}

// Extract raw PCM from a file at a given time position
function extractPcm(ffmpeg, filePath, startSec, duration, streamIdx = 0, lowpass = false) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(startSec),
      '-t', String(duration),
      '-i', filePath,
      '-map', `0:a:${streamIdx}`,
      '-ac', '1',
      '-ar', String(EXTRACT_RATE),
      ...(lowpass ? ['-af', `lowpass=f=${LOWPASS_HZ}`] : []),
      '-f', 's16le', '-',
    ];
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    proc.stdout.on('data', d => chunks.push(d));
    proc.on('close', code => {
      const buf = Buffer.concat(chunks);
      if (buf.length < 400) return reject(new Error(`No audio data (exit ${code})`));
      resolve(buf);
    });
    proc.on('error', reject);
  });
}

function fmtTime(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDuration(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h${String(m).padStart(2,'0')}m${String(s).padStart(2,'0')}s`;
  return `${m}m${String(s).padStart(2,'0')}s`;
}

module.exports = { analyzeSyncSources };
