'use strict';

// ── State ──────────────────────────────────────────────────────────────────────
const sources = [];     // [{ file, tracks, loaded }]
let settings = {};
let merging = false;

// ── DOM helpers ────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

// ── Init ───────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  settings = await api.getSettings();
  $('setting-output').value = settings.outputPath;
  $('setting-on-exists').value = settings.onFileExists;

  const status = await api.getToolsStatus();
  if (!status.mkvmerge) {
    $('tools-banner-msg').textContent = 'mkvmerge not found — install MKVToolNix.';
    show($('tools-banner'));
  }

  bindEvents();

  // IPC events
  api.on('log', (msg) => appendLog(msg));
  api.on('progress', (pct) => {
    $('progress-bar').style.width = pct + '%';
    $('progress-pct').textContent = pct + '%';
  });
  api.on('merge-complete', ({ output }) => {
    setMerging(false);
    appendLog('Done → ' + output);
  });
  api.on('merge-error', (msg) => {
    setMerging(false);
    appendLog('Error: ' + msg, 'error');
  });
});

function bindEvents() {
  $('btn-add-sources').addEventListener('click', addSources);
  $('btn-add-more').addEventListener('click', addSources);
  $('btn-clear-all').addEventListener('click', clearAll);
  $('btn-merge').addEventListener('click', startMerge);
  $('btn-cancel').addEventListener('click', cancelMerge);
  $('btn-toggle-log').addEventListener('click', () => $('log-wrap').classList.toggle('hidden'));
  $('btn-clear-log').addEventListener('click', () => { $('log').innerHTML = ''; });
  $('btn-settings').addEventListener('click', () => { showView('view-settings'); });
  $('btn-back').addEventListener('click', () => { showView('view-main'); });
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('btn-choose-output-folder').addEventListener('click', async () => {
    const p = await api.chooseFolder();
    if (p) { settings.outputPath = p; $('setting-output').value = p; }
  });
  $('btn-browse-output').addEventListener('click', async () => {
    const p = await api.chooseFolder();
    if (p) $('output-path').value = p;
  });

  // Drag & drop on the whole window
  document.body.addEventListener('dragover', (e) => e.preventDefault());
  document.body.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files].map(f => f.path).filter(Boolean);
    if (files.length) addFiles(files);
  });
}

// ── Sources management ─────────────────────────────────────────────────────────
async function addSources() {
  const files = await api.chooseSources();
  if (files.length) addFiles(files);
}

async function addFiles(files) {
  for (const file of files) {
    if (sources.find(s => s.file === file)) continue;
    sources.push({ file, tracks: [], loaded: false });
  }
  renderAll();
  // Identify newly added files
  for (const src of sources.filter(s => !s.loaded)) {
    const idx = sources.indexOf(src);
    updateSourceStatus(idx, 'Identifying…', 'loading');
    const result = await api.identifySource(src.file);
    if (result.ok) {
      src.tracks = result.tracks;
      src.loaded = true;
      updateSourceStatus(idx, result.tracks.length + ' tracks', '');
      renderSourceTracks(idx);
    } else {
      src.loaded = true;
      updateSourceStatus(idx, 'Error: ' + result.error, 'error');
    }
  }
  checkSync();
  setOutputName();
}

function clearAll() {
  sources.length = 0;
  renderAll();
}

function removeSource(idx) {
  sources.splice(idx, 1);
  renderAll();
  checkSync();
}

// ── Rendering ──────────────────────────────────────────────────────────────────
function renderAll() {
  const hasSources = sources.length > 0;
  hasSources ? show($('sources-section')) : hide($('sources-section'));
  hasSources ? hide($('empty-state')) : show($('empty-state'));
  $('source-list').innerHTML = '';
  sources.forEach((_, i) => renderSourceCard(i));
  if (sources.length > 0) setOutputName();
}

function renderSourceCard(idx) {
  const src = sources[idx];
  const name = src.file.split('/').pop();
  const card = document.createElement('div');
  card.className = 'source-card';
  card.id = 'source-card-' + idx;
  card.innerHTML = `
    <div class="source-card-header">
      <span class="source-index">${idx + 1}</span>
      <span class="source-filename" title="${src.file}">${name}</span>
      <span class="source-status ${src.loaded ? '' : 'loading'}" id="src-status-${idx}">${src.loaded ? src.tracks.length + ' tracks' : 'Identifying…'}</span>
      <button class="btn-icon small" title="Remove" data-remove="${idx}">✕</button>
    </div>
    <div class="source-tracks" id="src-tracks-${idx}"></div>
  `;
  card.querySelector('[data-remove]').addEventListener('click', (e) => {
    removeSource(parseInt(e.currentTarget.dataset.remove, 10));
  });
  $('source-list').appendChild(card);
  if (src.loaded && src.tracks.length) renderSourceTracks(idx);
}

function renderSourceTracks(idx) {
  const src = sources[idx];
  const container = $('src-tracks-' + idx);
  if (!container) return;
  container.innerHTML = '';

  const byType = { video: [], audio: [], subtitles: [] };
  for (const t of src.tracks) {
    const key = t.type === 'subtitles' ? 'subtitles' : t.type;
    if (byType[key]) byType[key].push(t);
  }

  if (byType.video.length) {
    addTrackGroupLabel(container, 'Video');
    for (const t of byType.video) {
      container.appendChild(makeTrackRow('video', idx, t));
    }
  }
  if (byType.audio.length) {
    addTrackGroupLabel(container, 'Audio');
    for (const t of byType.audio) {
      container.appendChild(makeTrackRow('audio', idx, t));
    }
  }
  if (byType.subtitles.length) {
    addTrackGroupLabel(container, 'Subtitles');
    for (const t of byType.subtitles) {
      container.appendChild(makeTrackRow('subtitles', idx, t));
    }
  }
}

function addTrackGroupLabel(container, label) {
  const el = document.createElement('div');
  el.className = 'track-group-label';
  el.textContent = label;
  container.appendChild(el);
}

function makeTrackRow(type, sourceIdx, track) {
  const row = document.createElement('label');
  row.className = 'track-row';

  const input = document.createElement('input');
  if (type === 'video') {
    input.type = 'radio';
    input.name = 'video-source';
    input.value = sourceIdx + ':' + track.id;
    // Auto-select video from first source that has it
    if (!document.querySelector('input[name="video-source"]:checked')) {
      input.checked = true;
    }
  } else {
    input.type = 'checkbox';
    input.name = type + '-track';
    input.value = sourceIdx + ':' + track.id;
    input.checked = true; // all audio/sub checked by default
  }

  const name = document.createElement('span');
  name.className = 'track-name';
  name.textContent = trackLabel(track);

  row.appendChild(input);
  row.appendChild(name);

  const codec = track.codec || '';
  if (codec) {
    const badge = document.createElement('span');
    badge.className = 'track-badge';
    badge.textContent = codec.replace(/^V_|^A_|^S_/, '').toLowerCase();
    row.appendChild(badge);
  }

  return row;
}

function trackLabel(track) {
  const lang = track.lang || '';
  const name = track.name || '';
  const ch = track.channels ? track.channels + 'ch' : '';
  return [lang, name, ch].filter(Boolean).join(' ') || track.codec || `Track ${track.id}`;
}

function updateSourceStatus(idx, text, cls) {
  const el = $('src-status-' + idx);
  if (!el) return;
  el.textContent = text;
  el.className = 'source-status' + (cls ? ' ' + cls : '');
}

// ── Sync check ─────────────────────────────────────────────────────────────────
function checkSync() {
  if (sources.length < 2 || !sources.every(s => s.loaded)) return;
  const durations = sources.map(s => {
    const vid = s.tracks.find(t => t.type === 'video');
    return vid ? (vid.duration ?? 0) : 0;
  }).filter(d => d > 0);
  if (durations.length < 2) return;
  const diffMs = Math.round((Math.max(...durations) - Math.min(...durations)) / 1e6);
  if (diffMs > 500) {
    $('sync-diff').textContent = `(${(diffMs / 1000).toFixed(2)}s difference)`;
    show($('sync-warning'));
  } else {
    hide($('sync-warning'));
  }
}

// ── Output name ────────────────────────────────────────────────────────────────
function setOutputName() {
  if (!$('output-path').value) $('output-path').value = settings.outputPath;
  if (!$('output-name').value && sources.length) {
    const base = sources[0].file.split('/').pop().replace(/\.[^.]+$/, '');
    $('output-name').value = base + '.merged.mkv';
  }
}

// ── Merge ──────────────────────────────────────────────────────────────────────
function buildPlan() {
  const planSources = sources.map((src, idx) => ({
    file: src.file,
    videoTracks: [],
    audioTracks: [],
    subtitleTracks: []
  }));

  const videoRadio = document.querySelector('input[name="video-source"]:checked');
  if (videoRadio) {
    const [sIdx, tId] = videoRadio.value.split(':').map(Number);
    if (planSources[sIdx]) planSources[sIdx].videoTracks.push(tId);
  }

  for (const cb of document.querySelectorAll('input[name="audio-track"]:checked')) {
    const [sIdx, tId] = cb.value.split(':').map(Number);
    if (planSources[sIdx]) planSources[sIdx].audioTracks.push(tId);
  }
  for (const cb of document.querySelectorAll('input[name="subtitles-track"]:checked')) {
    const [sIdx, tId] = cb.value.split(':').map(Number);
    if (planSources[sIdx]) planSources[sIdx].subtitleTracks.push(tId);
  }

  const dir = $('output-path').value || settings.outputPath;
  const filename = $('output-name').value || 'output.mkv';

  return {
    sources: planSources,
    output: dir.replace(/\/$/, '') + '/' + filename
  };
}

async function startMerge() {
  if (merging || sources.length < 2) return;
  if (!sources.every(s => s.loaded)) { appendLog('Still identifying sources…', 'warn'); return; }

  const plan = buildPlan();
  const hasVideo = plan.sources.some(s => s.videoTracks.length > 0);
  if (!hasVideo) { appendLog('No video track selected.', 'warn'); return; }

  setMerging(true);
  $('log').innerHTML = '';
  show($('log-wrap'));
  await api.merge(plan);
}

async function cancelMerge() {
  await api.cancel();
  setMerging(false);
  appendLog('Cancelled.');
}

function setMerging(active) {
  merging = active;
  $('btn-merge').classList.toggle('hidden', active);
  $('btn-cancel').classList.toggle('hidden', !active);
  $('progress-wrap').classList.toggle('hidden', !active);
  if (!active) { $('progress-bar').style.width = '0%'; $('progress-pct').textContent = '0%'; }
}

// ── Log ────────────────────────────────────────────────────────────────────────
function appendLog(msg, cls) {
  const el = document.createElement('div');
  el.className = 'log-line' + (cls ? ' ' + cls : '');
  el.textContent = msg;
  $('log').appendChild(el);
  $('log').scrollTop = $('log').scrollHeight;
}

// ── Settings ───────────────────────────────────────────────────────────────────
async function saveSettings() {
  settings.outputPath = $('setting-output').value;
  settings.onFileExists = $('setting-on-exists').value;
  await api.saveSettings(settings);
  show($('save-feedback'));
  setTimeout(() => hide($('save-feedback')), 1800);
}

// ── Views ──────────────────────────────────────────────────────────────────────
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(id).classList.add('active');
}
