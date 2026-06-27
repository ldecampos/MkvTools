const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findMkvmerge, buildMatroskaFlagArgs } = require('@mkv-tools/core/src/mkvmergeService');
const { writeTagsFile } = require('@mkv-tools/core/src/tagsService');
const { downloadPoster } = require('@mkv-tools/core/src/posterService');

let activeProcess = null;

const remuxService = {
  findMkvmerge,

  identifyTracks: require('@mkv-tools/core/src/mkvmergeService').identifyTracks,
  planTracks: require('@mkv-tools/core/src/mkvmergeService').planTracks,

  /** Produce the output MKV in one mkvmerge pass. */
  async produce({ input, output, plan, fileTitle, movie, writeImdbTag, embedCoverArt, onProgress, onLog }) {
    const mkvmerge = findMkvmerge();
    const kept = plan.filter(p => p.keep);
    const video = kept.filter(p => p.role === 'video');
    const audio = kept.filter(p => p.role === 'audio');
    const subs  = kept.filter(p => p.role === 'subtitles');
    if (video.length === 0) throw new Error('No video track selected');

    const args = ['--gui-mode', '--output', output, '--no-buttons', '--no-attachments',
                  '--disable-track-statistics-tags'];

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

    if (fileTitle && fileTitle.length) args.push('--title', fileTitle);
    else args.push('--title', '');

    args.push('--video-tracks', video.map(t => t.id).join(','));
    if (audio.length) args.push('--audio-tracks', audio.map(t => t.id).join(',')); else args.push('--no-audio');
    if (subs.length)  args.push('--subtitle-tracks', subs.map(t => t.id).join(',')); else args.push('--no-subtitles');

    video.forEach((t, i) => {
      args.push('--track-name', `${t.id}:`);
      args.push('--language', `${t.id}:und`);
      args.push('--default-track-flag', `${t.id}:${i === 0 ? 'yes' : 'no'}`);
      args.push('--forced-display-flag', `${t.id}:no`);
    });
    audio.forEach(t => {
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
    args.push(...buildMatroskaFlagArgs([...audio, ...subs]));

    args.push('--no-track-tags');
    args.push(input);

    onLog?.('Running mkvmerge...');
    try {
      await runWithProgress(mkvmerge, args, onProgress, onLog);
    } finally {
      if (tagsFile)   { try { fs.unlinkSync(tagsFile);   } catch (_) {} }
      if (posterFile) { try { fs.unlinkSync(posterFile); } catch (_) {} }
    }
    return output;
  },

  cancel() { if (activeProcess) { activeProcess.kill('SIGTERM'); activeProcess = null; } }
};

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

module.exports = { remuxService };
