'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  settings: {},
  meta: { fileVariables: [], audioVariables: [], subtitleVariables: [], seriesVariables: [], builtinPresets: {}, uiLanguages: [] },
  strings: {},
  uiLang: 'en',
  sources: [],      // [{ file, tracks, title, ok, loading, error }]
  plan: null,       // planMergeTracks result: { videoSourceIndex, plan }
  syncResults: [],  // analyzeSyncSources result
  movie: null,      // identified movie/series
  overrides: {},    // globalId -> boolean (forced keep/drop)
  forcedVideoSource: null,
  merging: false,
  tplFields: {},
};

function t(key, vars) {
  let s = state.strings[key] || key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.getAttribute('data-i18n');
    if (state.strings[k] !== undefined) el.textContent = state.strings[k];
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const k = el.getAttribute('data-i18n-title');
    if (state.strings[k] !== undefined) el.title = state.strings[k];
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const k = el.getAttribute('data-i18n-ph');
    if (state.strings[k] !== undefined) el.placeholder = state.strings[k];
  });
}

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  state.settings = await window.api.getSettings();
  state.meta     = await window.api.getMeta();
  state.uiLang   = state.settings.uiLang || 'en';
  state.strings  = await window.api.getStrings(state.uiLang);
  buildSettingsUI();
  populateSettings();
  applyTranslations();
  attachEvents();
  subscribeEvents();
  checkTools();
  addLog(t('log_ready'), 'info');
}

async function checkTools() {
  const st = await window.api.getToolsStatus();
  const msgs = [];
  if (!st.mkvmerge.installed) msgs.push(t('banner_no_mkvmerge'));
  if (!st.ffmpeg.installed)   msgs.push(t('banner_no_ffmpeg'));
  const banner = $('tools-banner');
  if (msgs.length) {
    $('tools-banner-msg').textContent = msgs.join(' · ');
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

// ── Events ────────────────────────────────────────────────────────────────────
function attachEvents() {
  $('btn-settings').addEventListener('click', () => showView('settings'));
  $('btn-back').addEventListener('click', () => showView('main'));
  $('btn-toggle-log').addEventListener('click', () => $('log-wrap').classList.toggle('hidden'));
  $('btn-clear-log').addEventListener('click', () => $('log-wrap').classList.add('hidden'));
  $('btn-add-sources').addEventListener('click', addSources);
  $('btn-add-more').addEventListener('click', addSources);
  $('btn-clear-all').addEventListener('click', clearAll);
  $('btn-edit-tracks').addEventListener('click', openTrackEditor);
  $('btn-close-tracks').addEventListener('click', () => hideModal('modal-tracks'));
  $('btn-close-tracks2').addEventListener('click', () => hideModal('modal-tracks'));
  $('btn-reset-tracks').addEventListener('click', resetTrackOverrides);
  $('btn-change-movie').addEventListener('click', openMovieSearch);
  $('btn-close-movie').addEventListener('click', () => hideModal('modal-movie'));
  $('btn-movie-search').addEventListener('click', doMovieSearch);
  $('btn-movie-none').addEventListener('click', clearMovieId);
  $('movie-search-input').addEventListener('keydown', e => { if (e.key === 'Enter') doMovieSearch(); });
  document.querySelectorAll('input[name="search-type"]').forEach(r => r.addEventListener('change', onSearchTypeChange));
  $('btn-browse-output').addEventListener('click', browseOutput);
  $('btn-merge').addEventListener('click', doMerge);
  $('btn-cancel').addEventListener('click', doCancel);
  $('btn-choose-folder').addEventListener('click', async () => {
    const f = await window.api.chooseFolder();
    if (f) $('setting-output').value = f;
  });
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('setting-create-folder').addEventListener('change', toggleFolderRow);
  $('setting-series-folders').addEventListener('change', toggleSeriesFolders);
  $('setting-jellyfin-enabled').addEventListener('change', toggleJellyfin);
  $('tmdb-key-link')?.addEventListener('click', e => {
    e.preventDefault();
    window.api.openUrl('https://www.themoviedb.org/settings/api');
  });

  // Drag & drop
  const dz = $('dropzone');
  document.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) dz.classList.remove('dragover'); });
  document.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('dragover');
    const paths = [...e.dataTransfer.files].map(f => window.api.getFilePath(f)).filter(Boolean);
    if (paths.length) addSourcePaths(paths);
  });

  // Accordion
  document.querySelectorAll('.settings-section[data-acc] .acc-header').forEach(h => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('open'));
  });
}

function subscribeEvents() {
  window.api.on('log',            ({ message, level, time }) => addLog(message, level, time));
  window.api.on('progress',       pct => setProgress(pct));
  window.api.on('merge-complete', ({ output }) => onMergeComplete(output));
  window.api.on('merge-error',    msg => onMergeError(msg));
}

// ── View management ───────────────────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
}
function hideModal(id) { $(id).classList.add('hidden'); }
function showModal(id) { $(id).classList.remove('hidden'); }

// ── Source management ─────────────────────────────────────────────────────────
async function addSources() {
  const paths = await window.api.chooseSources();
  if (paths.length) addSourcePaths(paths);
}

async function addSourcePaths(paths) {
  const newPaths = paths.filter(p => !state.sources.some(s => s.file === p));
  if (!newPaths.length) return;

  for (const file of newPaths) {
    state.sources.push({ file, tracks: null, title: '', ok: null, loading: true });
  }
  showWorkArea();
  renderSources();

  for (const file of newPaths) {
    const src = state.sources.find(s => s.file === file);
    const res = await window.api.identifySource(file);
    src.loading = false;
    if (res.ok) {
      src.tracks = res.tracks;
      src.title  = res.title;
      src.ok     = true;
    } else {
      src.tracks = [];
      src.ok     = false;
      src.error  = res.error;
    }
    renderSources();
  }

  if (state.sources.every(s => !s.loading)) {
    await autoIdentifyAndPlan();
  }
}

async function removeSource(index) {
  state.sources.splice(index, 1);
  if (state.forcedVideoSource !== null && state.forcedVideoSource >= state.sources.length) {
    state.forcedVideoSource = null;
  }
  if (state.sources.length === 0) { clearAll(); return; }
  renderSources();
  await replan();
}

function clearAll() {
  state.sources = [];
  state.plan = null;
  state.syncResults = [];
  state.movie = null;
  state.overrides = {};
  state.forcedVideoSource = null;
  hideWorkArea();
  renderSources();
  renderSyncCard();
  renderPlanCard();
  renderMovieCard();
}

function showWorkArea() {
  $('dropzone').classList.add('hidden');
  $('work-area').classList.remove('hidden');
}
function hideWorkArea() {
  $('dropzone').classList.remove('hidden');
  $('work-area').classList.add('hidden');
}

// ── Auto-flow ─────────────────────────────────────────────────────────────────
async function autoIdentifyAndPlan() {
  if (!state.movie) {
    const primary = state.sources.find(s => s.ok);
    if (primary) {
      const res = await window.api.analyzeMovie(primary.file);
      state.movie = res.movie || null;
      renderMovieCard();
    }
  }

  await replan();

  if (state.sources.filter(s => s.ok).length >= 2) {
    if (sourcesNeedSyncCheck()) {
      await runSyncAnalysis();
    } else {
      const durations = state.sources
        .filter(s => s.ok && s.tracks)
        .map(s => (s.tracks.find(t => t.type === 'video') || {}).duration || 0);
      const diffMs = Math.round((Math.max(...durations) - Math.min(...durations)) / 1e6);
      addLog(t('log_sync_skipped', { ms: diffMs }), 'info');
    }
  }
}

function sourcesNeedSyncCheck() {
  const durations = state.sources
    .filter(s => s.ok && s.tracks)
    .map(s => (s.tracks.find(t => t.type === 'video') || {}).duration || 0);
  if (durations.length < 2) return false;
  const max = Math.max(...durations), min = Math.min(...durations);
  return (max - min) > 500_000_000; // nanoseconds — >500ms diff triggers check
}

async function replan() {
  if (!state.sources.some(s => s.ok)) return;
  const sources = state.sources.map(s => ({ file: s.file, tracks: s.tracks || [], title: s.title }));
  const result = await window.api.planTracks({ sources, overrides: state.overrides, forcedVideoSource: state.forcedVideoSource });
  state.plan = result;
  renderSources();
  renderPlanCard();
  updateOutputName();
}

async function runSyncAnalysis() {
  const syncCard = $('sync-card');
  syncCard.classList.remove('hidden');
  $('sync-content').innerHTML = `<span class="spinner"></span> ${t('sync_analyzing')}`;

  const sources = state.sources.filter(s => s.ok).map(s => ({ file: s.file, tracks: s.tracks }));
  const res = await window.api.analyzeSync(sources);
  if (res.ok) {
    state.syncResults = res.results;
  } else {
    state.syncResults = [];
    addLog(t('log_sync_failed', { err: res.error }), 'warn');
  }
  renderSyncCard();
}

// ── Render: sources ───────────────────────────────────────────────────────────
function renderSources() {
  const list = $('source-list');
  list.innerHTML = '';
  const videoSrcIdx = state.plan?.videoSourceIndex ?? 0;

  state.sources.forEach((src, i) => {
    const fname = src.file.split('/').pop();
    const isVideoSrc = i === videoSrcIdx;
    const card = document.createElement('div');
    card.className = `source-card${isVideoSrc ? ' video-selected' : ''}`;

    let status = '';
    if (src.loading) status = '<span class="source-status loading">Analyzing…</span>';
    else if (!src.ok) status = `<span class="source-status error">Error: ${esc(src.error || 'unknown')}</span>`;
    else status = `<span class="source-status">${src.tracks.length} tracks</span>`;

    const tracks = src.tracks || [];
    const vid = tracks.find(t => t.role === 'video');
    const audios = tracks.filter(t => t.role === 'audio');
    const subs   = tracks.filter(t => t.role === 'subtitles');
    const videoLabel = vid ? `${vid.codec}${vid.width ? ' · ' + vid.width + 'x' + vid.height : ''}` : 'No video';
    const summaryParts = [];
    if (audios.length) summaryParts.push(`${audios.length} audio`);
    if (subs.length)   summaryParts.push(`${subs.length} sub`);

    card.innerHTML = `
      <div class="source-card-header">
        <div class="source-num">${i + 1}</div>
        <div class="source-filename" title="${esc(src.file)}">${esc(fname)}</div>
        ${status}
        <button class="btn-icon small" data-remove="${i}" title="Remove">✕</button>
      </div>
      ${src.ok ? `
      <div class="source-body">
        <label class="source-video-row">
          <input type="radio" name="video-source" value="${i}" ${isVideoSrc ? 'checked' : ''}>
          <span class="source-video-label">Video: ${esc(videoLabel)}</span>
          ${isVideoSrc ? '<span class="source-video-badge">VIDEO SOURCE</span>' : ''}
        </label>
        <div class="source-tracks-summary">${summaryParts.join(' · ') || 'No audio or subtitles'}</div>
      </div>` : ''}`;

    card.querySelector('[data-remove]')?.addEventListener('click', e => {
      e.stopPropagation();
      removeSource(parseInt(e.currentTarget.dataset.remove));
    });
    card.querySelector('input[type="radio"]')?.addEventListener('change', async e => {
      state.forcedVideoSource = parseInt(e.target.value);
      await replan();
    });

    list.appendChild(card);
  });
}

// ── Render: sync card ─────────────────────────────────────────────────────────
function renderSyncCard() {
  const card = $('sync-card');
  const content = $('sync-content');
  if (!state.syncResults.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');

  const videoSrcIdx = state.plan?.videoSourceIndex ?? 0;
  content.innerHTML = '';

  state.syncResults.forEach(r => {
    if (r.sourceIndex === videoSrcIdx) return;
    const fname = (state.sources[r.sourceIndex]?.file || '').split('/').pop();

    const { badgeClass, badgeText, desc } = syncBadge(r);

    const row = document.createElement('div');
    row.className = 'sync-row';
    row.innerHTML = `
      <span class="sync-badge ${badgeClass}">${badgeText}</span>
      <span style="color:var(--text2);font-size:11px;flex:none;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
        title="${esc(state.sources[r.sourceIndex]?.file)}">${esc(fname)}</span>
      <span class="sync-desc">${esc(desc)}</span>`;
    content.appendChild(row);
  });
}

function syncBadge(r) {
  const ms = r.offsetMs > 0 ? `+${r.offsetMs}` : String(r.offsetMs);
  switch (r.status) {
    case 'in-sync':        return { badgeClass: 'in-sync',   badgeText: t('sync_in_sync'),   desc: t('sync_desc_in_sync') };
    case 'offset':         return { badgeClass: 'offset',    badgeText: t('sync_offset'),    desc: t('sync_desc_offset', { ms }) };
    case 'drift':          return { badgeClass: 'drift',     badgeText: t('sync_drift'),     desc: t('sync_desc_drift', { ms }) };
    case 'different-cuts': return { badgeClass: 'different', badgeText: t('sync_different'), desc: t('sync_desc_different') };
    case 'no-ffmpeg':      return { badgeClass: 'failed',    badgeText: t('sync_no_ffmpeg'), desc: t('sync_desc_no_ffmpeg') };
    case 'too-short':      return { badgeClass: 'failed',    badgeText: t('sync_too_short'), desc: t('sync_desc_too_short') };
    case 'failed':         return { badgeClass: 'failed',    badgeText: t('sync_failed'),    desc: r.error || t('sync_desc_failed') };
    default:               return { badgeClass: 'analyzing', badgeText: r.status,            desc: '' };
  }
}

// ── Render: track plan ────────────────────────────────────────────────────────
function renderPlanCard() {
  const card = $('plan-card');
  const content = $('plan-content');
  if (!state.plan) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');

  const { plan } = state.plan;
  if (!plan || !plan.length) { content.innerHTML = `<span class="hint">${t('tracks_none')}</span>`; return; }

  content.innerHTML = '';
  for (const p of plan.filter(p => p.keep)) {
    const row = document.createElement('div');
    row.className = 'plan-row';
    const icon   = p.role === 'video' ? '🎬' : p.role === 'audio' ? '🔊' : '💬';
    const detail = p.role === 'video'
      ? `${p.codec}${p.width ? ' · ' + p.width + 'x' + p.height : ''}`
      : `${p.codec}${p.channels ? ' · ' + p.channels + 'ch' : ''}${p.lang ? ' · ' + p.lang : ''}`;
    row.innerHTML = `
      <span class="plan-icon">${icon}</span>
      <span class="plan-lang">${esc(p.lang || 'und')}</span>
      <span class="plan-detail">${esc(detail)}</span>
      <span class="plan-source">S${p.sourceIndex + 1}</span>
      ${p.newName ? `<span class="plan-name">${esc(p.newName)}</span>` : ''}`;
    content.appendChild(row);
  }

  const dropped = plan.filter(p => !p.keep).length;
  if (dropped) {
    const note = document.createElement('div');
    note.className = 'hint'; note.style.marginTop = '6px';
    note.textContent = t(dropped > 1 ? 'tracks_filtered_plural' : 'tracks_filtered', { n: dropped });
    content.appendChild(note);
  }
}

// ── Render: movie card ────────────────────────────────────────────────────────
function renderMovieCard() {
  const card = $('movie-card');
  const content = $('movie-content');
  card.classList.remove('hidden');

  if (!state.movie) {
    content.innerHTML = `<span class="movie-none">${t('movie_none')}</span>`;
    updateOutputName();
    return;
  }
  const m = state.movie;
  const isSeries = m.type === 'series';
  const poster = m.posterPath ? `<img class="movie-poster" src="${esc(m.posterPath)}" alt="">` : '';
  const typeBadge = `<span class="movie-type-badge">${isSeries ? t('type_series') : t('type_movie')}</span>`;
  let label = esc(m.title || '');
  if (isSeries && m.season) {
    const pad = n => String(n).padStart(2, '0');
    label += ` · S${pad(m.season)}E${pad(m.episode || 1)}`;
    if (m.episodeTitle) label += ` · ${esc(m.episodeTitle)}`;
  }
  content.innerHTML = `
    ${poster}
    <div class="movie-info">
      <div class="movie-title">${typeBadge} ${label}</div>
      <div class="movie-year">${esc(m.year || '')}</div>
    </div>`;
  updateOutputName();
}

// ── Output name ───────────────────────────────────────────────────────────────
function updateOutputName() {
  const folder = state.settings.outputPath || '';
  $('output-path').value = folder;
  if (!state.movie) { $('output-name').value = ''; $('output-name').placeholder = 'output.mkv'; return; }
  const m = state.movie;
  const isSeries = m.type === 'series';
  let name;
  if (isSeries && m.season) {
    const pad = n => String(n).padStart(2, '0');
    name = `${m.title || 'Show'} - S${pad(m.season)}E${pad(m.episode || 1)}`;
    if (m.episodeTitle) name += ` - ${m.episodeTitle}`;
  } else {
    const year = m.year ? ` (${m.year})` : '';
    name = `${m.title || 'output'}${year}`;
  }
  $('output-name').value = sanitizeFilename(name);
}

async function browseOutput() {
  const f = await window.api.chooseFolder();
  if (f) $('output-path').value = f;
}

// ── Track editor modal ────────────────────────────────────────────────────────
function openTrackEditor() {
  if (!state.plan) return;
  buildTrackEditorList();
  showModal('modal-tracks');
}

function buildTrackEditorList() {
  const list = $('track-editor-list');
  list.innerHTML = '';
  if (!state.plan?.plan) return;

  const groups = [
    { role: 'video',     icon: '🎬', label: () => t('group_video') },
    { role: 'audio',     icon: '🔊', label: () => t('group_audio') },
    { role: 'subtitles', icon: '💬', label: () => t('group_subtitles') },
  ];

  for (const { role, icon, label } of groups) {
    const tracks = state.plan.plan.filter(p => p.role === role);
    if (!tracks.length) continue;

    const groupLabel = document.createElement('div');
    groupLabel.className = 'te-group-label';
    groupLabel.textContent = label();
    list.appendChild(groupLabel);

    for (const p of tracks) {
      const globalId = `${p.sourceIndex}:${p.id}`;
      const isVideo = role === 'video';
      const row = document.createElement('div');
      row.className = `te-row ${p.keep ? 'keep' : 'drop'}`;

      const detail = role === 'video'
        ? `${p.codec}${p.width ? ' · ' + p.width + 'x' + p.height : ''}`
        : `${p.codec}${p.channels ? ' · ' + p.channels + 'ch' : ''}${p.name ? ' · ' + p.name : ''}`;

      row.innerHTML = `
        <input type="checkbox" ${p.keep ? 'checked' : ''} ${isVideo ? 'disabled' : ''}>
        <span>${icon}</span>
        <span class="te-lang">${esc(p.lang || 'und')}</span>
        <span class="te-detail">${esc(detail)}</span>
        <span class="te-source">S${p.sourceIndex + 1}</span>
        ${p.newName ? `<span class="te-name">${esc(p.newName)}</span>` : ''}`;

      if (!isVideo) {
        const cb = row.querySelector('input');
        cb.addEventListener('change', async () => {
          state.overrides[globalId] = cb.checked;
          await replan();
          buildTrackEditorList();
        });
      }
      list.appendChild(row);
    }
  }
}

async function resetTrackOverrides() {
  state.overrides = {};
  await replan();
  buildTrackEditorList();
}

// ── Movie search modal ────────────────────────────────────────────────────────
function openMovieSearch() {
  $('movie-search-input').value = state.movie?.title || '';
  $('movie-search-year').value  = state.movie?.year  || '';
  $('movie-search-results').innerHTML = '';
  $('movie-search-series-row').classList.add('hidden');
  document.querySelector('input[name="search-type"][value="movie"]').checked = true;
  showModal('modal-movie');
}

function onSearchTypeChange() {
  const isTv = document.querySelector('input[name="search-type"]:checked')?.value === 'tv';
  $('movie-search-series-row').classList.toggle('hidden', !isTv);
}

async function doMovieSearch() {
  const q = $('movie-search-input').value.trim();
  if (!q) return;
  const yr   = $('movie-search-year').value.trim() || undefined;
  const isTv = document.querySelector('input[name="search-type"]:checked')?.value === 'tv';
  $('movie-search-results').innerHTML = `<span class="hint">${t('search_searching')}</span>`;

  let results = isTv
    ? await window.api.searchTV({ query: q, year: yr })
    : await window.api.searchMovie({ query: q, year: yr });

  if (results && results.noKey) {
    $('movie-search-results').innerHTML = `<span class="hint" style="color:var(--warn)">${t('search_no_key')}</span>`;
    return;
  }
  if (!Array.isArray(results)) results = [];

  const container = $('movie-search-results');
  container.innerHTML = '';
  if (!results.length) { container.innerHTML = `<span class="hint">${t('search_no_results')}</span>`; return; }

  results.forEach(r => {
    const item = document.createElement('div');
    item.className = 'result-item';
    const poster = r.posterPath
      ? `<img class="result-poster" src="${esc(r.posterPath)}" alt="">`
      : `<div class="result-poster"></div>`;
    item.innerHTML = `${poster}<div class="result-info"><div class="result-title">${esc(r.title)}</div><div class="result-year">${esc(r.year || '')}</div></div>`;
    item.addEventListener('click', () => selectSearchResult(r, isTv));
    container.appendChild(item);
  });
}

async function selectSearchResult(r, isTv) {
  if (isTv) {
    r.type    = 'series';
    r.season  = parseInt($('movie-search-season')?.value)  || 1;
    r.episode = parseInt($('movie-search-episode')?.value) || 1;
    if (r.id) {
      const ep = await window.api.getEpisode({ tvId: r.id, season: r.season, episode: r.episode });
      r.episodeTitle = ep.episodeTitle || '';
    }
  } else {
    r.type = 'movie';
  }
  state.movie = r;
  renderMovieCard();
  hideModal('modal-movie');
}

function clearMovieId() {
  state.movie = null;
  renderMovieCard();
  hideModal('modal-movie');
}

// ── Merge ─────────────────────────────────────────────────────────────────────
async function doMerge() {
  if (state.merging) return;
  if (!state.plan || !state.sources.some(s => s.ok)) {
    addLog(t('log_no_sources'), 'warn'); return;
  }

  state.merging = true;
  $('btn-merge').classList.add('hidden');
  $('btn-cancel').classList.remove('hidden');
  $('progress-wrap').classList.remove('hidden');
  setProgress(0);

  const sources = state.sources.map(s => ({ file: s.file, tracks: s.tracks }));

  const res = await window.api.merge({
    sources,
    plan:             state.plan.plan,
    movie:            state.movie,
    syncResults:      state.syncResults,
    videoSourceIndex: state.plan.videoSourceIndex,
  });

  if (!res.ok) onMergeError(res.error);
}

async function doCancel() {
  await window.api.cancel();
  finishMerge(false);
  addLog(t('log_cancelled'), 'warn');
}

function onMergeComplete(output) {
  addLog(t('log_done', { path: output }), 'success');
  setProgress(100);
  finishMerge(true);
}

function onMergeError(msg) {
  addLog(`Error: ${msg}`, 'error');
  finishMerge(false);
}

function finishMerge(ok) {
  state.merging = false;
  $('btn-merge').classList.remove('hidden');
  $('btn-cancel').classList.add('hidden');
  if (!ok) setProgress(0);
}

function setProgress(pct) {
  $('progress-bar').style.width = pct + '%';
  $('progress-pct').textContent = pct + '%';
}

// ── Log ───────────────────────────────────────────────────────────────────────
function addLog(message, level = 'info', time) {
  const log = $('log');
  const line = document.createElement('span');
  line.className = `log-line ${level}`;
  const ts = time || new Date().toLocaleTimeString();
  line.innerHTML = `<span class="time">${esc(ts)}</span><span class="msg">${esc(message)}</span>`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

// ── Settings ──────────────────────────────────────────────────────────────────
const FIELD_TO_SETTING = {
  outputName:        'outputNameTemplate',
  folderName:        'folderNameTemplate',
  audioName:         'audioNameTemplate',
  subName:           'subNameTemplate',
  seriesOutputName:  'seriesOutputNameTemplate',
  seriesShowFolder:  'seriesShowFolderTemplate',
  seriesSeasonFolder:'seriesSeasonFolderTemplate',
};

function buildSettingsUI() {
  // Language selector
  const langSel = $('setting-ui-lang');
  if (langSel) {
    langSel.innerHTML = '';
    (state.meta.uiLanguages || []).forEach(l => {
      const o = document.createElement('option');
      o.value = l.code; o.textContent = l.name;
      langSel.appendChild(o);
    });
    langSel.value = state.uiLang;
    langSel.addEventListener('change', async () => {
      state.uiLang = langSel.value;
      state.strings = await window.api.getStrings(state.uiLang);
      applyTranslations();
      for (const k of Object.keys(state.tplFields)) updateTplPreview(k);
      await window.api.saveSettings({ uiLang: state.uiLang });
      state.settings.uiLang = state.uiLang;
    });
  }

  document.querySelectorAll('.tpl-field').forEach(container => {
    buildTemplateField(container, container.dataset.field, container.dataset.vars);
  });
}

function buildTemplateField(container, fieldKey, varsType) {
  const vars = varsType === 'audio'    ? state.meta.audioVariables
             : varsType === 'subtitle' ? state.meta.subtitleVariables
             : varsType === 'series'   ? state.meta.seriesVariables
             : state.meta.fileVariables;

  const input = document.createElement('input');
  input.type = 'text'; input.className = 'input'; input.placeholder = '(empty)';

  const chipRow = document.createElement('div');
  chipRow.className = 'chip-row';
  (vars || []).forEach(v => {
    const chip = document.createElement('button');
    chip.className = 'chip var-chip'; chip.textContent = v.token; chip.title = v.desc;
    chip.addEventListener('click', () => insertAtCursor(input, v.token));
    chipRow.appendChild(chip);
  });

  const presetRow = document.createElement('div');
  presetRow.className = 'preset-row';
  const select = document.createElement('select');
  select.className = 'input';
  const applyBtn = mkBtn('Apply', 'btn-secondary small');
  presetRow.append(select, applyBtn);

  const preview = document.createElement('div');
  preview.className = 'preview-name';

  container.append(chipRow, input, presetRow, preview);
  state.tplFields[fieldKey] = { input, preview, select, varsType };

  input.addEventListener('input', () => updateTplPreview(fieldKey));
  applyBtn.addEventListener('click', () => { input.value = select.value; updateTplPreview(fieldKey); });

  const builtin = state.meta.builtinPresets?.[fieldKey] || [];
  builtin.forEach(p => {
    const o = document.createElement('option');
    o.value = p.value; o.textContent = p.label;
    select.appendChild(o);
  });
}

function updateTplPreview(fieldKey) {
  const { input, preview, varsType } = state.tplFields[fieldKey];
  const ctx = sampleCtx(varsType);
  preview.textContent = t('tpl_example') + ' ' + renderSample(input.value, ctx);
}

const _VID_SHORT = {'V_MPEG4/ISO/AVC':'H.264','V_MPEGH/ISO/HEVC':'H.265','V_AV1':'AV1','V_MPEG2':'MPEG-2'};
const _AUD_SHORT = {'A_DTS/MA':'DTS-HD MA','A_DTS':'DTS','A_EAC3':'E-AC3','A_AC3':'AC-3','A_TRUEHD':'TrueHD','A_FLAC':'FLAC','A_AAC':'AAC','A_OPUS':'Opus'};
const _SRC_PAT   = [[/\bremux\b/i,'BluRay REMUX'],[/\bblu-?ray\b/i,'BluRay'],[/\bweb-?dl\b/i,'WEB-DL'],[/\bweb-?rip\b/i,'WEBRip'],[/\bhdtv\b/i,'HDTV'],[/\bdvdrip\b/i,'DVDRip']];
function _mRes(d){if(!d)return'';const[w,h]=d.split('x').map(Number);if(h>=2160||w>=3840)return'2160p';if(h>=1080||w>=1920)return'1080p';if(h>=720||w>=1280)return'720p';return h?`${h}p`:'';}
function _mHdr(tr,pr){if(tr===16&&pr===9)return'HDR10';if(tr===16)return'HDR';if(tr===18)return'HLG';return'';}
function _mCh(n){return n===8?'7.1':n===6?'5.1':n===2?'2.0':n===1?'1.0':n?`${n}ch`:'';}
function mediaCtxFromPlan(plan, filePath, title) {
  const fname = (filePath||'').split('/').pop().replace(/\.[^.]+$/,'');
  const vid  = (plan||[]).find(p=>p.role==='video'&&p.keep);
  const aud  = (plan||[]).filter(p=>p.role==='audio'&&p.keep).sort((a,b)=>(b.channels||0)-(a.channels||0))[0];
  let rg='', m=/-([A-Za-z0-9]{2,12})(?:\.[a-z]{1,4})?$/.exec(fname);
  if(m)rg=m[1]; else{m=/\[([A-Za-z0-9]{2,12})\](?:\.[a-z]{1,4})?$/.exec(fname);if(m)rg=m[1];}
  let src=''; for(const[re,lbl]of _SRC_PAT){if(re.test(fname)){src=lbl;break;}}
  return{resolution:_mRes(vid?.pixelDimensions),video_codec:_VID_SHORT[vid?.codec]||'',hdr:_mHdr(vid?.colorTransfer,vid?.colorPrimaries),audio_codec:_AUD_SHORT[aud?.codec]||'',audio_channels:_mCh(aud?.channels),release_group:rg,source:src,clean_title:(title||'').replace(/['"`:!?]/g,'').replace(/\s+/g,' ').trim()};
}

function sampleCtx(varsType) {
  if (varsType === 'audio')    return { lang: 'spa', codec: 'E-AC-3', channels: '5.1', variant_label: '', codec_short: 'EAC3' };
  if (varsType === 'subtitle') return { lang: 'eng', codec: 'SubRip/SRT', variant_label: '', forced: '' };
  const plan = state.plan?.plan || [];
  const si   = state.plan?.videoSourceIndex ?? 0;
  const pFile = state.sources[si]?.file || '';
  const pTitle = state.sources.find(s => s.ok)?.movie?.title || '';
  const med = plan.length ? mediaCtxFromPlan(plan, pFile, pTitle)
    : { resolution:'1080p', video_codec:'H.265', hdr:'HDR10', audio_codec:'DTS-HD MA', audio_channels:'5.1', release_group:'GROUP', source:'BluRay', clean_title: varsType === 'series' ? 'My Show' : 'Movie Title' };
  if (varsType === 'series') return { series: 'My Show', year: '2024', season: '1', episode: '5', season2: '01', episode2: '05', sxxexx: 'S01E05', episode_title: 'Episode Title', filename: 'show.s01e05', ...med };
  return { title: 'Movie Title', year: '2024', title_year: 'Movie Title (2024)', filename: 'movie.file', ...med };
}

function renderSample(tpl, ctx) {
  if (!tpl) return '(empty)';
  return tpl.replace(/\{(\w+)\}/g, (_, k) => ctx?.[k] !== undefined ? ctx[k] : `{${k}}`);
}

function populateSettings() {
  const s = state.settings;
  const v = (id, val) => { const el = $(id); if (el) el.value = val ?? ''; };
  const c = (id, val) => { const el = $(id); if (el) el.checked = !!val; };

  v('setting-output',   s.outputPath);
  const langSel = $('setting-ui-lang'); if (langSel) langSel.value = state.uiLang;
  const oe = $('setting-on-exists'); if (oe) oe.value = s.onFileExists || 'rename';
  c('setting-create-folder',   s.createFolder);
  c('setting-fetch-episode',   s.fetchEpisodeTitle);
  c('setting-series-folders',  s.seriesCreateFolders);
  v('setting-audio-langs',     s.audioLangs);
  v('setting-audio-codecs',    s.audioCodecs);
  c('setting-one-audio',       s.oneAudioPerLang);
  v('setting-sub-langs',       s.subLangs);
  c('setting-one-sub',         s.oneSubPerLang);
  c('setting-imdb-tag',        s.writeImdbTag);
  c('setting-imdb-folder',     s.imdbInFolder);
  c('setting-embed-cover',     s.embedCoverArt);
  v('setting-tmdb-key',        s.tmdbApiKey);
  c('setting-jellyfin-enabled',s.jellyfinEnabled);
  v('setting-jellyfin-url',    s.jellyfinUrl);
  v('setting-jellyfin-key',    s.jellyfinApiKey);

  // Template fields
  const tplMap = {
    outputName:        s.outputNameTemplate,
    folderName:        s.folderNameTemplate,
    audioName:         s.audioNameTemplate,
    subName:           s.subNameTemplate,
    seriesOutputName:  s.seriesOutputNameTemplate,
    seriesShowFolder:  s.seriesShowFolderTemplate,
    seriesSeasonFolder:s.seriesSeasonFolderTemplate,
  };
  for (const [fieldKey, val] of Object.entries(tplMap)) {
    const f = state.tplFields[fieldKey];
    if (f) { f.input.value = val || ''; updateTplPreview(fieldKey); }
  }

  toggleFolderRow();
  toggleSeriesFolders();
  toggleJellyfin();
  $('output-path').value = s.outputPath || '';
}

async function saveSettings() {
  const s = {};
  const v = id => $(id)?.value ?? '';
  const c = id => !!($(id)?.checked);

  s.outputPath          = v('setting-output');
  s.onFileExists        = v('setting-on-exists');
  s.createFolder        = c('setting-create-folder');
  s.fetchEpisodeTitle   = c('setting-fetch-episode');
  s.seriesCreateFolders = c('setting-series-folders');
  s.audioLangs          = v('setting-audio-langs');
  s.audioCodecs         = v('setting-audio-codecs');
  s.oneAudioPerLang     = c('setting-one-audio');
  s.subLangs            = v('setting-sub-langs');
  s.oneSubPerLang       = c('setting-one-sub');
  s.writeImdbTag        = c('setting-imdb-tag');
  s.imdbInFolder        = c('setting-imdb-folder');
  s.embedCoverArt       = c('setting-embed-cover');
  s.tmdbApiKey          = v('setting-tmdb-key');
  s.jellyfinEnabled     = c('setting-jellyfin-enabled');
  s.jellyfinUrl         = v('setting-jellyfin-url');
  s.jellyfinApiKey      = v('setting-jellyfin-key');

  for (const [fieldKey, settingKey] of Object.entries(FIELD_TO_SETTING)) {
    const f = state.tplFields[fieldKey];
    if (f) s[settingKey] = f.input.value;
  }

  await window.api.saveSettings(s);
  Object.assign(state.settings, s);

  const fb = $('save-feedback');
  fb.classList.remove('hidden');
  setTimeout(() => fb.classList.add('hidden'), 2000);
}

function toggleFolderRow() {
  const on = $('setting-create-folder')?.checked;
  $('folder-template-row')?.classList.toggle('hidden', !on);
}
function toggleSeriesFolders() {
  const on = $('setting-series-folders')?.checked;
  $('series-show-folder-row')?.classList.toggle('hidden', !on);
  $('series-season-folder-row')?.classList.toggle('hidden', !on);
}
function toggleJellyfin() {
  const on = $('setting-jellyfin-enabled')?.checked;
  $('jellyfin-fields')?.classList.toggle('hidden', !on);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function mkBtn(text, cls) {
  const b = document.createElement('button');
  b.className = cls; b.textContent = text; return b;
}
function insertAtCursor(input, text) {
  const s = input.selectionStart, e = input.selectionEnd, v = input.value;
  input.value = v.slice(0, s) + text + v.slice(e);
  input.selectionStart = input.selectionEnd = s + text.length;
  input.dispatchEvent(new Event('input'));
}
function sanitizeFilename(s) {
  return (s || 'output').replace(/[/\\:*?"<>|]/g, '').trim() || 'output';
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
