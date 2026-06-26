const { findMkvmerge } = require('@mkv-tools/core/src/mkvmergeSetup');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let activeProcess = null;

// Checks if source video durations differ significantly (>500ms).
// Returns { ok, diffMs, sourceA, sourceB } — caller decides what to do.
function checkSync(sources) {
  const durations = sources.map(s => {
    const vid = (s.tracks || []).find(t => t.type === 'video');
    return vid ? (vid.duration ?? 0) : 0;
  });
  const valid = durations.filter(d => d > 0);
  if (valid.length < 2) return { ok: true };
  const max = Math.max(...valid);
  const min = Math.min(...valid);
  const diffMs = Math.round((max - min) / 1e6);
  return { ok: diffMs <= 500, diffMs };
}

// plan = {
//   sources: [{ file, videoTracks: [id,...], audioTracks: [id,...], subtitleTracks: [id,...] }],
//   output:  '/abs/path/output.mkv',
//   title:   'Movie Title (2024)'   // optional
// }
async function produce({ plan, onProgress, onLog }) {
  const mkvmerge = await findMkvmerge();
  const { sources, output, title } = plan;

  fs.mkdirSync(path.dirname(output), { recursive: true });

  const args = ['--output', output];
  if (title) args.push('--title', title);

  let videoSourceSeen = false;
  for (const src of sources) {
    const { file, videoTracks = [], audioTracks = [], subtitleTracks = [] } = src;
    if (!videoTracks.length && !audioTracks.length && !subtitleTracks.length) continue;

    if (!videoTracks.length) {
      args.push('--no-video');
    } else {
      args.push('-d', videoTracks.join(','));
      videoSourceSeen = true;
    }

    if (!audioTracks.length) args.push('--no-audio');
    else args.push('-a', audioTracks.join(','));

    if (!subtitleTracks.length) args.push('--no-subtitles');
    else args.push('-s', subtitleTracks.join(','));

    // Keep chapters only from the video source; discard from the rest.
    if (videoSourceSeen && !videoTracks.length) args.push('--no-chapters');

    args.push(file);
  }

  onLog && onLog('Running: mkvmerge ' + args.join(' '));

  return new Promise((resolve, reject) => {
    activeProcess = spawn(mkvmerge, args);

    activeProcess.stdout.on('data', (data) => {
      const text = data.toString();
      onLog && onLog(text.trimEnd());
      const m = text.match(/Progress:\s*(\d+)%/);
      if (m) onProgress && onProgress(parseInt(m[1], 10));
    });

    activeProcess.stderr.on('data', (data) => {
      onLog && onLog('[err] ' + data.toString().trimEnd());
    });

    activeProcess.on('close', (code) => {
      activeProcess = null;
      // mkvmerge exits 0 = success, 1 = warnings (still usable), 2+ = errors
      if (code === 0 || code === 1) resolve({ warnings: code === 1 });
      else reject(new Error(`mkvmerge exited with code ${code}`));
    });

    activeProcess.on('error', (err) => {
      activeProcess = null;
      reject(err);
    });
  });
}

function cancel() {
  if (activeProcess) { activeProcess.kill(); activeProcess = null; }
}

module.exports = { produce, cancel, checkSync };
