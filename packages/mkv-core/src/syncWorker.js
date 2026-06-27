'use strict';
const { workerData, parentPort } = require('worker_threads');

const EXTRACT_RATE  = 8000;
const WORKING_RATE  = 100;
const DS_FACTOR     = EXTRACT_RATE / WORKING_RATE;
const MAX_OFFSET_MS = 60000;

function crossCorrelate(bufA, bufB) {
  const toFloat = buf => {
    const n = Math.floor(buf.length / 2);
    const s16 = new Int16Array(buf.buffer, buf.byteOffset, n);
    const outLen = Math.floor(n / DS_FACTOR);
    const f = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) f[i] = s16[i * DS_FACTOR] / 32768.0;
    return f;
  };

  const a = toFloat(bufA);
  const b = toFloat(bufB);
  const N = a.length;
  const M = b.length;

  let ea = 0, eb = 0;
  for (let i = 0; i < N; i++) ea += a[i] * a[i];
  for (let i = 0; i < M; i++) eb += b[i] * b[i];
  if (ea < 1e-6 || eb < 1e-6) return { lagMs: 0, confidence: 0 };

  const maxLag = Math.min(
    Math.floor((MAX_OFFSET_MS / 1000) * WORKING_RATE),
    Math.floor(Math.min(N, M) * 0.75)
  );

  let bestCorr = -Infinity;
  let bestLag  = 0;

  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const iStart = Math.max(0, lag);
    const iEnd   = Math.min(N, M + lag);
    if (iEnd <= iStart) continue;
    let corr = 0;
    for (let i = iStart; i < iEnd; i++) corr += a[i] * b[i - lag];
    corr /= (iEnd - iStart);
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }

  const rmsA = Math.sqrt(ea / N);
  const rmsB = Math.sqrt(eb / M);
  const confidence = Math.max(0, Math.min(1, bestCorr / (rmsA * rmsB)));
  const lagMs = Math.round((bestLag / WORKING_RATE) * 1000);

  return { lagMs, confidence };
}

parentPort.postMessage(crossCorrelate(workerData.bufA, workerData.bufB));
