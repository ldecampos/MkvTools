'use strict';
const { workerData, parentPort } = require('worker_threads');

const EXTRACT_RATE  = 8000;   // Hz — PCM rate of the incoming buffers
const ENVELOPE_RATE = 100;    // Hz — energy-envelope rate we correlate at
const FRAME         = EXTRACT_RATE / ENVELOPE_RATE; // 80 samples → one envelope point
const MAX_OFFSET_MS = 60000;  // widest offset to search for
const MIN_OVERLAP   = 0.5;    // require ≥50% window overlap so short-overlap noise can't win

// Energy envelope: RMS of each FRAME-sample block.
//
// We correlate the *loudness pattern* over time, not the raw waveform. Two
// encodes of the same content (e.g. DTS-HD vs E-AC-3) reconstruct slightly
// different samples, so sample-level correlation decorrelates — but their
// envelopes still match because the same sounds happen at the same moments.
// Block-averaging into the envelope also provides the anti-alias low-pass that
// a naive 80:1 decimation lacked (decimating raw samples folds all content
// above 50 Hz back as noise, destroying the signal).
function envelope(buf) {
  const n = Math.floor(buf.length / 2);
  const s16 = new Int16Array(buf.buffer, buf.byteOffset, n);
  const outLen = Math.floor(n / FRAME);
  const env = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    let sum = 0;
    const base = i * FRAME;
    for (let j = 0; j < FRAME; j++) {
      const s = s16[base + j];
      sum += s * s;
    }
    env[i] = Math.sqrt(sum / FRAME);
  }
  return env;
}

function crossCorrelate(bufA, bufB) {
  const a = envelope(bufA);
  const b = envelope(bufB);
  const N = a.length;
  const M = b.length;
  if (N < 2 || M < 2) return { lagMs: 0, confidence: 0 };

  // Correlate fluctuations around the mean, not the constant loudness level.
  let mA = 0, mB = 0;
  for (let i = 0; i < N; i++) mA += a[i];
  for (let i = 0; i < M; i++) mB += b[i];
  mA /= N; mB /= M;
  for (let i = 0; i < N; i++) a[i] -= mA;
  for (let i = 0; i < M; i++) b[i] -= mB;

  let ea = 0, eb = 0;
  for (let i = 0; i < N; i++) ea += a[i] * a[i];
  for (let i = 0; i < M; i++) eb += b[i] * b[i];
  if (ea < 1e-9 || eb < 1e-9) return { lagMs: 0, confidence: 0 };

  const maxLag = Math.min(
    Math.floor((MAX_OFFSET_MS / 1000) * ENVELOPE_RATE),
    Math.floor(Math.min(N, M) * 0.75)
  );
  const minOverlap = Math.floor(Math.min(N, M) * MIN_OVERLAP);

  let bestCorr = -Infinity;
  let bestLag  = 0;

  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const iStart = Math.max(0, lag);
    const iEnd   = Math.min(N, M + lag);
    if (iEnd - iStart < minOverlap) continue;

    // Normalized (Pearson) correlation over the overlapping region only, so the
    // confidence is comparable across lags and ∈ [-1, 1] regardless of overlap.
    let dot = 0, sa = 0, sb = 0;
    for (let i = iStart; i < iEnd; i++) {
      const av = a[i];
      const bv = b[i - lag];
      dot += av * bv;
      sa  += av * av;
      sb  += bv * bv;
    }
    const denom = Math.sqrt(sa * sb);
    if (denom < 1e-9) continue;
    const corr = dot / denom;
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }

  const confidence = Math.max(0, Math.min(1, bestCorr));
  const lagMs = Math.round((bestLag / ENVELOPE_RATE) * 1000);

  return { lagMs, confidence };
}

parentPort.postMessage(crossCorrelate(workerData.bufA, workerData.bufB));
