'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findMkvmerge, buildMatroskaFlagArgs } = require('@mkv-tools/core/src/mkvmergeService');
const { writeTagsFile } = require('@mkv-tools/core/src/tagsService');
const { downloadPoster } = require('@mkv-tools/core/src/posterService');

let activeProcess = null;

/**
 * Produce a merged MKV from multiple sources.
 *
 * plan: output of planMergeTracks()  [{ ...track, sourceIndex, keep, role, newName }]
 * syncResults: [{ sourceIndex, status, offsetMs, speedCorrection }] from analyzeSyncSources
 * Sources that have status 'offset' or 'drift' get --sync flags applied.
 */
async function produce({ sources, output, plan, fileTitle, movie, writeImdbTag, embedCoverArt, syncResults = [], onProgress, onLog }) {
  const mkvmerge = findMkvmerge();
  if (!mkvmerge) throw new Error('mkvmerge not found. Install MKVToolNix.');

  fs.mkdirSync(path.dirname(output), { recursive: true });

  const args = ['--gui-mode', '--output', output,
    '--no-buttons', '--no-attachments', '--disable-track-statistics-tags'];

  // Global tags / IMDB
  let tagsFile = null;
  if (writeImdbTag && movie && (movie.imdbId || movie.id)) {
    tagsFile = writeTagsFile(movie);
    args.push('--no-global-tags', '--global-tags', tagsFile);
  } else {
    args.push('--no-global-tags');
  }

  // Cover art attachment
  let posterFile = null;
  if (embedCoverArt && movie?.posterPath) {
    posterFile = await downloadPoster(movie.posterPath);
    if (posterFile) {
      const ext  = path.extname(posterFile).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
      args.push('--attachment-name', 'cover' + ext,
                '--attachment-mime-type', mime,
                '--attach-file', posterFile);
      onLog?.(`Cover art attached (${path.basename(posterFile)})`);
    } else {
      onLog?.('Cover art: download failed, skipping.');
    }
  }

  if (fileTitle) args.push('--title', fileTitle); else args.push('--title', '');

  // Build per-source argument groups
  const syncMap = new Map(); // sourceIndex → syncResult
  for (const r of syncResults) syncMap.set(r.sourceIndex, r);

  // Group plan by source
  const bySource = new Map();
  for (const p of plan) {
    if (!bySource.has(p.sourceIndex)) bySource.set(p.sourceIndex, []);
    bySource.get(p.sourceIndex).push(p);
  }

  for (const [si, tracks] of bySource.entries()) {
    const videos = tracks.filter(p => p.role === 'video' && p.keep);
    const audios = tracks.filter(p => p.role === 'audio' && p.keep);
    const subs   = tracks.filter(p => p.role === 'subtitles' && p.keep);

    // Skip source if it contributes nothing
    if (!videos.length && !audios.length && !subs.length) continue;

    // Track selection flags
    if (videos.length) args.push('--video-tracks', videos.map(t => t.id).join(','));
    else args.push('--no-video');

    if (audios.length) args.push('--audio-tracks', audios.map(t => t.id).join(','));
    else args.push('--no-audio');

    if (subs.length) args.push('--subtitle-tracks', subs.map(t => t.id).join(','));
    else args.push('--no-subtitles');

    // Sync correction (delay + optional speed ratio)
    const sync = syncMap.get(si);
    if (sync && (sync.status === 'offset' || sync.status === 'drift') && sync.offsetMs !== 0) {
      const corrected = [...audios, ...subs];
      for (const t of corrected) {
        if (sync.speedCorrection) {
          const { originalMs, adjustedMs } = sync.speedCorrection;
          args.push('--sync', `${t.id}:${sync.offsetMs},${originalMs}/${adjustedMs}`);
        } else {
          args.push('--sync', `${t.id}:${sync.offsetMs}`);
        }
      }
    }

    // Track metadata
    videos.forEach((t, i) => {
      args.push('--track-name', `${t.id}:`);
      args.push('--language', `${t.id}:und`);
      args.push('--default-track-flag', `${t.id}:${i === 0 ? 'yes' : 'no'}`);
      args.push('--forced-display-flag', `${t.id}:no`);
    });
    audios.forEach(t => {
      args.push('--track-name', `${t.id}:${t.newName || ''}`);
      args.push('--default-track-flag', `${t.id}:no`);
      args.push('--forced-display-flag', `${t.id}:no`);
    });
    subs.forEach(t => {
      args.push('--track-name', `${t.id}:${t.newName || ''}`);
      args.push('--default-track-flag', `${t.id}:no`);
      args.push('--forced-display-flag', `${t.id}:${t.forced ? 'yes' : 'no'}`);
    });

    // Write Matroska RFC 9559 type flags so detection is cached in the output file
    args.push(...buildMatroskaFlagArgs([...audios, ...subs]));

    args.push('--no-track-tags');
    args.push(sources[si].file);
  }

  logPlan(plan, syncResults, onLog);
  onLog?.('Running mkvmerge…');
  try {
    await runWithProgress(mkvmerge, args, onProgress, onLog);
  } finally {
    if (tagsFile)   { try { fs.unlinkSync(tagsFile);   } catch (_) {} }
    if (posterFile) { try { fs.unlinkSync(posterFile); } catch (_) {} }
  }
  return output;
}

const CODEC_LABEL = {
  'V_MPEG4/ISO/AVC': 'H.264', 'V_MPEGH/ISO/HEVC': 'H.265', 'V_AV1': 'AV1', 'V_MPEG2': 'MPEG-2',
  'A_DTS/MA': 'DTS-HD MA', 'A_DTS': 'DTS', 'A_EAC3': 'E-AC3', 'A_AC3': 'AC-3',
  'A_TRUEHD': 'TrueHD', 'A_FLAC': 'FLAC', 'A_AAC': 'AAC', 'A_OPUS': 'Opus',
};
const fmtCodec = c => CODEC_LABEL[c] || c || '?';

const SYNC_STATUS_LABEL = {
  'in-sync':       'in sync — no correction needed',
  'offset':        (r) => `constant offset ${r.offsetMs >= 0 ? '+' : ''}${r.offsetMs}ms — corrected`,
  'drift':         (r) => `speed drift — corrected (${r.speedCorrection ? `${r.speedCorrection.originalMs}/${r.speedCorrection.adjustedMs}` : ''})`,
  'different-cuts':'different cut — no auto-correction',
  'failed':        'analysis failed — no correction',
  'too-short':     'too short to analyze',
  'no-ffmpeg':     'ffmpeg not available',
};

function logPlan(plan, syncResults, onLog) {
  if (!onLog) return;
  const kept = plan.filter(p => p.keep);
  const videos = kept.filter(p => p.role === 'video');
  const audios = kept.filter(p => p.role === 'audio');
  const subs   = kept.filter(p => p.role === 'subtitles');

  onLog('─'.repeat(48));
  onLog('Merge plan');

  for (const t of videos) {
    const dim = t.pixelDimensions ? `  ${t.pixelDimensions}` : '';
    onLog(`  Video:  [S${t.sourceIndex + 1}] ${fmtCodec(t.codec)}${dim}`);
  }

  audios.forEach((t, i) => {
    const ch  = t.channels ? ` ${t.channels}ch` : '';
    const lbl = t.newName ? ` · ${t.newName}` : '';
    onLog(`  ${i === 0 ? 'Audio:  ' : '        '}[S${t.sourceIndex + 1}] ${fmtCodec(t.codec)}${ch}${lbl}`);
  });
  if (audios.length === 0) onLog('  Audio:  none');

  subs.forEach((t, i) => {
    const lbl = t.newName ? ` · ${t.newName}` : (t.lang ? ` · ${t.lang}` : '');
    onLog(`  ${i === 0 ? 'Subs:   ' : '        '}[S${t.sourceIndex + 1}] ${fmtCodec(t.codec)}${lbl}`);
  });
  if (subs.length === 0) onLog('  Subs:   none');

  if (syncResults && syncResults.length) {
    syncResults.forEach(r => {
      const label = typeof SYNC_STATUS_LABEL[r.status] === 'function'
        ? SYNC_STATUS_LABEL[r.status](r)
        : (SYNC_STATUS_LABEL[r.status] || r.status);
      onLog(`  Sync:   S${r.sourceIndex + 1} ${label}`);
    });
  } else {
    onLog('  Sync:   not needed — durations matched');
  }

  onLog('─'.repeat(48));
}

function runWithProgress(bin, args, onProgress, onLog) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    activeProcess = proc;
    let stderr = '';
    proc.stdout.on('data', d => {
      for (const line of d.toString().split('\n')) {
        const m = line.match(/#GUI#progress\s+(\d+)%/);
        if (m) onProgress?.(parseInt(m[1]) / 100);
        else if (line.trim() && !line.startsWith('#GUI#')) onLog?.(line.trim());
      }
    });
    proc.stderr.on('data', d => { stderr += d; onLog?.(d.toString().trim()); });
    proc.on('close', code => {
      activeProcess = null;
      if (code === 0 || code === 1) resolve();
      else reject(new Error(`mkvmerge exited ${code}. ${stderr.slice(0, 200)}`));
    });
    proc.on('error', e => { activeProcess = null; reject(e); });
  });
}

function cancel() {
  if (activeProcess) { activeProcess.kill('SIGTERM'); activeProcess = null; }
}

module.exports = { produce, cancel };
