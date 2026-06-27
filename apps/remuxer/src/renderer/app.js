// ── State ────────────────────────────────────────────────────────────────────
const state = {
  settings: {},
  meta: { fileVariables: [], trackVariables: [], builtinPresets: {}, uiLanguages: [] },
  queue: [],          // [{ filePath, movie, candidates, tracks, plan, fileTitle, status }]
  searchTargetPath: null,
  tplFields: {},      // fieldKey -> { input, previewEl, varsType }
  strings: {},        // current language strings
  uiLang: 'en',
  processing: false
};

// Translation helper: t('key') or t('key', {name:'x'}) for {name} substitution
function t(key, vars) {
  let s = state.strings[key] || key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}

// Apply translations to all tagged elements
function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (state.strings[key]) el.textContent = state.strings[key];
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (state.strings[key]) el.title = state.strings[key];
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const key = el.getAttribute('data-i18n-ph');
    if (state.strings[key]) el.placeholder = state.strings[key];
  });
}

const $ = id => document.getElementById(id);
const COMMON_CODECS = ['AC-3', 'E-AC-3', 'DTS', 'DTS-HD', 'TrueHD', 'PCM', 'FLAC', 'AAC'];

// Maps tpl-field data-field -> settings key
const FIELD_TO_SETTING = {
  fileTitle: 'fileTitleTemplate',
  outputName: 'outputNameTemplate',
  folderName: 'folderNameTemplate',
  audioName: 'audioNameTemplate',
  subName: 'subNameTemplate',
  seriesOutputName: 'seriesOutputNameTemplate',
  seriesFileTitle: 'seriesFileTitleTemplate',
  seriesShowFolder: 'seriesShowFolderTemplate',
  seriesSeasonFolder: 'seriesSeasonFolderTemplate'
};

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  state.settings = await window.api.getSettings();
  state.meta = await window.api.getMeta();
  state.uiLang = state.settings.uiLang || 'en';
  state.strings = await window.api.getStrings(state.uiLang);
  buildSettingsUI();
  buildLangSelector();
  populateSettings();
  applyTranslations();
  attachEvents();
  attachMakemkvEvents();
  subscribeEvents();
  addLog(t('ready'), 'info');
  checkTools();
}

function buildLangSelector() {
  const sel = $('setting-ui-lang');
  if (!sel) return;
  sel.innerHTML = '';
  (state.meta.uiLanguages || []).forEach(l => {
    const o = document.createElement('option');
    o.value = l.code; o.textContent = l.name;
    sel.appendChild(o);
  });
  sel.value = state.uiLang;
  sel.addEventListener('change', async () => {
    state.uiLang = sel.value;
    state.strings = await window.api.getStrings(state.uiLang);
    applyTranslations();
    // Refresh dynamic bits that aren't plain data-i18n
    refreshFilePreviews();
    for (const k of Object.keys(state.tplFields)) updateTplPreview(k);
    renderQueue();
    // Persist immediately
    await window.api.saveSettings({ uiLang: state.uiLang });
    state.settings.uiLang = state.uiLang;
  });
}

function updateTmdbKeyHint(key) {
  const warn = $('tmdb-key-warn');
  const hint = $('tmdb-key-hint');
  if (!warn || !hint) return;
  if (key.trim()) {
    warn.classList.add('hidden');
    hint.classList.remove('hidden');
  } else {
    warn.classList.remove('hidden');
    hint.classList.add('hidden');
  }
}

function attachEvents() {
  $('btn-settings').addEventListener('click', () => { showView('settings'); checkTools(); });
  $('tmdb-key-link')?.addEventListener('click', e => {
    e.preventDefault();
    window.api.openUrl('https://www.themoviedb.org/settings/api');
  });
  $('setting-tmdb-key')?.addEventListener('input', e => updateTmdbKeyHint(e.target.value));
  $('btn-back').addEventListener('click', () => showView('main'));
  $('btn-toggle-log').addEventListener('click', () => $('log-wrap').classList.toggle('hidden'));
  $('btn-clear-log').addEventListener('click', () => $('log-wrap').classList.add('hidden'));
  $('btn-add-files').addEventListener('click', addFiles);
  $('btn-add-more').addEventListener('click', addFiles);
  $('btn-clear-queue').addEventListener('click', clearQueue);
  $('btn-process').addEventListener('click', processBatch);
  $('btn-cancel').addEventListener('click', cancelBatch);

  $('btn-search').addEventListener('click', doSearch);
  $('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  $('btn-close-search').addEventListener('click', () => hide('view-movie-search'));
  $('btn-confirm-manual').addEventListener('click', confirmManual);
  $('btn-close-preview').addEventListener('click', () => hide('view-preview'));
  $('btn-preview-reset').addEventListener('click', resetPreviewOverrides);
  $('btn-preview-close2').addEventListener('click', () => hide('view-preview'));

  $('btn-choose-folder').addEventListener('click', async () => {
    const f = await window.api.chooseFolder();
    if (f) $('setting-output').value = f;
  });
  $('btn-choose-rip-temp').addEventListener('click', async () => {
    const f = await window.api.chooseFolder();
    if (f) $('setting-rip-temp').value = f;
  });
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('setting-create-folder').addEventListener('change', toggleFolderRow);
  $('setting-jellyfin-enabled').addEventListener('change', toggleJellyfin);
  $('setting-series-folders').addEventListener('change', toggleSeriesFolders);
  $('setting-custom-title').addEventListener('change', toggleCustomTitle);
  $('setting-series-custom-title').addEventListener('change', toggleSeriesCustomTitle);

  // Drag & drop
  const dz = $('dropzone');
  ['dragover', 'dragenter'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); if (ev !== 'drop' && e.relatedTarget) return; dz.classList.remove('dragover'); }));
  document.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('dragover');
    const paths = [];
    for (const f of e.dataTransfer.files) {
      const p = window.api.getFilePath(f);
      if (p) paths.push(p);
    }
    if (paths.length) enqueueFiles(paths);
  });
}

function subscribeEvents() {
  window.api.on('log', ({ message, level, time }) => addLog(message, level, time));
  window.api.on('progress', ({ key, percent }) => {
    if (key === '__overall__') { $('overall-bar').style.width = percent + '%'; $('overall-pct').textContent = percent + '%'; }
    else updateItemProgress(key, percent);
  });
  window.api.on('item-done', ({ filePath, ok }) => markItemDone(filePath, ok));
  window.api.on('batch-complete', () => {
    state.processing = false;
    $('btn-process').classList.remove('hidden');
    $('btn-cancel').classList.add('hidden');
    addLog(t('all_done'), 'success');
  });
}

// ── File queue ──────────────────────────────────────────────────────────────
async function addFiles() {
  const paths = await window.api.chooseFiles();
  if (paths.length) enqueueFiles(paths);
}

async function enqueueFiles(paths, tmpDir, preselectedMedia, autoProcess = false) {
  $('dropzone').classList.add('hidden');
  $('queue-section').classList.remove('hidden');

  for (const p of paths) {
    if (state.queue.some(it => it.filePath === p)) continue;
    const item = {
      filePath: p, movie: null, candidates: [], tracks: [], plan: [],
      fileTitle: '', status: 'analyzing',
      tmpDir: tmpDir || null,
      preselectedMedia: preselectedMedia || null,
      autoProcess
    };
    state.queue.push(item);
    renderQueue();
    analyzeItem(item);
  }
  updateQueueCount();
}

async function analyzeItem(item) {
  try {
    const res = await window.api.analyzeFile(item.filePath);
    if (!res.ok) {
      item.status = 'error';
      item.error = res.error;
    } else {
      item.tracks = res.tracks;
      item.plan = res.plan;
      item.fileTitle = res.fileTitle;
      if (item.preselectedMedia) {
        item.movie = item.preselectedMedia;
        item.candidates = [item.preselectedMedia];
        item.status = 'ready';
      } else {
        item.movie = res.movie;
        item.candidates = res.candidates || [];
        item.status = res.movie && res.movie.title ? (res.movie.id ? 'ready' : 'review') : 'review';
      }
    }
  } catch (err) {
    item.status = 'error';
    item.error = err.message;
  }
  renderQueue();
  updateQueueCount();
  refreshFilePreviews();

  // Auto-process if this item came from an automatic rip and is ready
  if (item.autoProcess && item.status === 'ready' && !state.processing) {
    processBatch();
  }
}

// Refresh the "Example:" lines of file-type template fields with real movie data
function refreshFilePreviews() {
  for (const [fieldKey, f] of Object.entries(state.tplFields)) {
    if (f.varsType === 'file' || f.varsType === 'series') updateTplPreview(fieldKey);
  }
}

function clearQueue() {
  state.queue = [];
  $('queue-section').classList.add('hidden');
  $('dropzone').classList.remove('hidden');
  renderQueue();
}

function renderQueue() {
  const list = $('queue-list');
  list.innerHTML = '';
  state.queue.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = `queue-item status-${item.status}`;
    row.dataset.path = item.filePath;

    const fname = item.filePath.split('/').pop();
    const m = item.movie;
    const isSeries = m && m.type === 'series';
    let movieLabel = '—';
    if (m && m.title) {
      if (isSeries) {
        const pad = n => String(n || 0).padStart(2, '0');
        const code = `S${pad(m.season)}E${pad(m.episode)}`;
        movieLabel = `${m.title} · ${code}${m.episodeTitle ? ' · ' + m.episodeTitle : ''}`;
      } else {
        movieLabel = `${m.title}${m.year ? ' (' + m.year + ')' : ''}`;
      }
    }
    const typeBadge = m ? `<span class="type-badge ${isSeries ? 'series' : 'movie'}">${isSeries ? t('type_series') : t('type_movie')}</span>` : '';
    const badge = {
      analyzing: `<span class="badge analyzing">${t('st_analyzing')}</span>`,
      ready: `<span class="badge ready">${t('st_identified')}</span>`,
      review: `<span class="badge review">${t('st_review')}</span>`,
      error: `<span class="badge error">${t('st_error')}</span>`,
      processing: `<span class="badge processing">${t('st_processing')}</span>`,
      done: `<span class="badge done">${t('st_done')}</span>`,
      failed: `<span class="badge error">${t('st_failed')}</span>`
    }[item.status] || '';

    const poster = item.movie?.posterPath ? `<img class="qi-poster" src="${item.movie.posterPath}" onerror="this.style.visibility='hidden'">` : `<div class="qi-poster placeholder">${isSeries ? '📺' : '🎬'}</div>`;

    row.innerHTML = `
      ${poster}
      <div class="qi-info">
        <div class="qi-movie">${typeBadge}${esc(movieLabel)}</div>
        <div class="qi-file">${esc(fname)}</div>
        ${item.status === 'error' ? `<div class="qi-error">${esc(item.error || '')}</div>` : ''}
        <div class="qi-progress hidden"><div class="qi-bar" style="width:0%"></div></div>
      </div>
      <div class="qi-actions">
        ${badge}
        ${item.status !== 'analyzing' && item.status !== 'processing' ? `<button class="btn-secondary small" data-action="type" data-idx="${idx}" title="${t('change_type')}">${isSeries ? '📺' : '🎬'}</button>` : ''}
        ${item.status !== 'analyzing' && item.status !== 'processing' ? `<button class="btn-secondary small" data-action="movie" data-idx="${idx}">${isSeries ? t('type_series') : t('type_movie')}</button>` : ''}
        ${item.tracks.length ? `<button class="btn-secondary small" data-action="preview" data-idx="${idx}">${t('btn_tracks')}</button>` : ''}
        <button class="btn-icon small" data-action="remove" data-idx="${idx}" title="${t('remove')}">✕</button>
      </div>`;
    list.appendChild(row);
  });

  // Wire action buttons
  list.querySelectorAll('button[data-action]').forEach(btn => {
    const idx = parseInt(btn.dataset.idx);
    const action = btn.dataset.action;
    btn.addEventListener('click', () => {
      if (action === 'movie') { state.searchTargetPath = state.queue[idx].filePath; openMovieSearch(state.queue[idx]); }
      else if (action === 'preview') showPreview(state.queue[idx]);
      else if (action === 'type') toggleMediaType(idx);
      else if (action === 'remove') { state.queue.splice(idx, 1); renderQueue(); updateQueueCount(); if (!state.queue.length) clearQueue(); }
    });
  });
}

// Switch a queue item between movie and series, then re-identify
async function toggleMediaType(idx) {
  const item = state.queue[idx];
  if (!item || !item.movie) return;
  const newType = item.movie.type === 'series' ? 'movie' : 'series';
  item.movie.type = newType;
  item.status = 'analyzing';
  renderQueue();
  // Re-search using the new type with the current title
  const title = item.movie.title || '';
  try {
    let results = newType === 'series' ? await window.api.searchTV(title) : await window.api.searchMovie(title);
    if (results && results.length) {
      const chosen = results[0];
      if (newType === 'series') {
        // try to keep season/episode from filename guess if present
        chosen.season = item.movie.season || 1;
        chosen.episode = item.movie.episode || 1;
        if (chosen.id) {
          const ep = await window.api.getEpisode({ tvId: chosen.id, season: chosen.season, episode: chosen.episode });
          chosen.episodeTitle = ep.episodeTitle;
        }
      }
      item.movie = chosen;
      item.status = chosen.id ? 'ready' : 'review';
    } else {
      item.status = 'review';
    }
  } catch (_) {
    item.status = 'review';
  }
  renderQueue();
  updateQueueCount();
  refreshFilePreviews();
}

function updateQueueCount() {
  const n = state.queue.length;
  const review = state.queue.filter(i => i.status === 'review').length;
  const fileWord = n !== 1 ? t('files') : t('file');
  $('queue-count').textContent = `${n} ${fileWord}` + (review ? ` · ${review} ${t('need_review')}` : '');
}

function updateItemProgress(filePath, pct) {
  const row = $('queue-list').querySelector(`[data-path="${cssEsc(filePath)}"]`);
  if (!row) return;
  const item = state.queue.find(i => i.filePath === filePath);
  if (item && item.status !== 'processing') { item.status = 'processing'; }
  const prog = row.querySelector('.qi-progress');
  const bar = row.querySelector('.qi-bar');
  if (prog && bar) { prog.classList.remove('hidden'); bar.style.width = pct + '%'; }
}

function markItemDone(filePath, ok) {
  const item = state.queue.find(i => i.filePath === filePath);
  if (item) item.status = ok ? 'done' : 'failed';
  renderQueue();
}

// ── Movie identification ──────────────────────────────────────────────────────
function openMovieSearch(item) {
  state.searchTargetPath = item.filePath;
  state.searchIsSeries = item.movie && item.movie.type === 'series';
  $('search-input').value = item.movie?.title || '';
  $('search-results').innerHTML = '';
  const heading = $('search-heading');
  if (heading) heading.textContent = state.searchIsSeries ? t('identify_series') : t('identify_movie');
  // Season/episode row only for series
  const seRow = $('search-series-row');
  if (state.searchIsSeries) {
    seRow.classList.remove('hidden');
    $('search-season').value = item.movie?.season || 1;
    $('search-episode').value = item.movie?.episode || 1;
  } else {
    seRow.classList.add('hidden');
  }
  // Prefill the manual block (hidden until a search returns nothing)
  $('manual-title').value = item.movie?.title || '';
  $('manual-year').value = item.movie?.year || '';
  $('manual-block').classList.add('hidden');
  show('view-movie-search');
  if ($('search-input').value.trim()) setTimeout(doSearch, 150);
}

async function doSearch() {
  const q = $('search-input').value.trim();
  if (!q) return;
  $('search-results').innerHTML = `<div class="muted-pad">${t('searching')}</div>`;
  const results = state.searchIsSeries ? await window.api.searchTV(q) : await window.api.searchMovie(q);
  const box = $('search-results');
  if (!results.length) {
    box.innerHTML = `<div class="muted-pad">${t('no_results')}</div>`;
    // Reveal the manual block with the right fields for the type
    const manual = $('manual-block');
    manual.classList.remove('hidden');
    $('manual-series-row').classList.toggle('hidden', !state.searchIsSeries);
    if (!$('manual-title').value.trim()) $('manual-title').value = q;
    if (state.searchIsSeries) {
      $('manual-season').value = $('search-season').value || 1;
      $('manual-episode').value = $('search-episode').value || 1;
    }
    return;
  }
  // Have results → hide the manual block
  $('manual-block').classList.add('hidden');
  box.innerHTML = '';
  results.forEach(m => {
    const el = document.createElement('div');
    el.className = 'result-item';
    el.innerHTML = `
      <img class="result-poster" src="${m.posterPath || ''}" onerror="this.style.visibility='hidden'">
      <div class="result-info">
        <div class="result-title">${esc(m.title)}</div>
        <div class="result-year">${m.year}${m.imdbId ? ' · ' + m.imdbId : ''}</div>
        <div class="result-overview">${esc(m.overview || '')}</div>
      </div>`;
    el.addEventListener('click', () => assignMovie(m));
    box.appendChild(el);
  });
}

async function assignMovie(m) {
  const item = state.queue.find(i => i.filePath === state.searchTargetPath);
  if (item) {
    if (m.type === 'series') {
      // Prefer the season/episode the user set in the search modal (if visible)
      const seRow = $('search-series-row');
      if (seRow && !seRow.classList.contains('hidden')) {
        m.season = parseInt($('search-season').value) || 1;
        m.episode = parseInt($('search-episode').value) || 1;
      } else {
        m.season = item.movie?.season || 1;
        m.episode = item.movie?.episode || 1;
      }
      if (m.id) {
        try {
          const ep = await window.api.getEpisode({ tvId: m.id, season: m.season, episode: m.episode });
          m.episodeTitle = ep.episodeTitle;
        } catch (_) {}
      }
    }
    item.movie = m;
    item.status = m.id ? 'ready' : 'review';
  }
  hide('view-movie-search');
  renderQueue();
  updateQueueCount();
  refreshFilePreviews();
}

async function confirmManual() {
  const title = $('manual-title').value.trim();
  const year = $('manual-year').value.trim();
  if (!title) { alert(t('enter_title_alert')); return; }
  const item = state.queue.find(i => i.filePath === state.searchTargetPath);
  const isSeries = item && item.movie && item.movie.type === 'series';
  if (isSeries) {
    const season = parseInt($('manual-season').value) || 1;
    const episode = parseInt($('manual-episode').value) || 1;
    assignMovie({ id: null, type: 'series', title, year, imdbId: null, posterPath: null,
      season, episode, episodeTitle: '' });
  } else {
    assignMovie({ id: null, type: 'movie', title, year, imdbId: null, posterPath: null });
  }
}

// ── Track preview ─────────────────────────────────────────────────────────────
function showPreview(item) {
  state.previewItem = item;
  renderPreviewList();
  show('view-preview');
  // Fetch the natural (filters-only) state so we can detect redundant overrides
  if (!item.naturalState) {
    window.api.replan({ tracks: item.tracks, overrides: item.overrides || {} })
      .then(res => { if (res && res.natural) item.naturalState = res.natural; })
      .catch(() => {});
  }
}

function renderPreviewList() {
  const item = state.previewItem;
  if (!item) return;
  const list = $('preview-list');
  list.innerHTML = '';

  // Find same-lang tracks with no detected variant (unknown duplicates)
  const langCounts = {};
  for (const p of item.plan) {
    if (p.role === 'video') continue;
    const key = (p.lang || 'und') + ':' + p.role;
    langCounts[key] = (langCounts[key] || 0) + 1;
  }
  const isUnknownDup = (p) =>
    p.role !== 'video' &&
    !p.variant &&
    langCounts[(p.lang || 'und') + ':' + p.role] > 1;

  const order = { video: 0, audio: 1, subtitles: 2 };
  const sorted = [...item.plan].sort((a, b) => (order[a.role] - order[b.role]) || (a.id - b.id));

  for (const p of sorted) {
    const editable = p.role !== 'video';
    const row = document.createElement('div');
    row.className = 'preview-row ' + (p.keep ? 'keep' : 'drop') + (editable ? ' editable' : '');

    const icon = p.role === 'video' ? '🎬' : p.role === 'audio' ? '🔊' : '💬';
    const details = [];
    if (p.codec) details.push(p.codec);
    if (p.channels) details.push(p.channels + 'ch');
    if (p.forced) details.push('Forced');

    // Status tag
    let tag = '';
    if (p.manual) tag = `<span class="pv-tag manual">${t('lbl_manual')}</span>`;
    else if (p.bestOfLang) tag = `<span class="pv-tag best">★ ${t('best_quality')}</span>`;
    else if (p.dropReason === 'duplicate')       tag = `<span class="pv-tag dup">${t('lbl_duplicate')}</span>`;
    else if (p.dropReason === 'accessibility')   tag = `<span class="pv-tag ad">${t('lbl_accessibility')}</span>`;
    else if (p.dropReason === 'commentary')      tag = `<span class="pv-tag commentary">${t('lbl_commentary')}</span>`;
    else if (p.dropReason === 'sdh_disabled')    tag = `<span class="pv-tag sdh">${t('lbl_sdh_disabled')}</span>`;
    else if (p.dropReason === 'signs_disabled')  tag = `<span class="pv-tag signs">${t('lbl_signs_disabled')}</span>`;
    else if (p.dropReason === 'normal_disabled') tag = `<span class="pv-tag dup">${t('lbl_normal_disabled')}</span>`;
    else if (p.dropReason === 'forced_disabled') tag = `<span class="pv-tag dup">${t('lbl_forced_disabled')}</span>`;
    else if (p.dropReason === 'unknown_disabled')tag = `<span class="pv-tag unknown">${t('lbl_unknown_disabled')}</span>`;

    // Variant badge
    let variantBadge = '';
    if (p.variant && !p.variant.startsWith('_')) {
      const region = p.variant.split('-')[1] || '';
      variantBadge = `<span class="variant-badge" title="${esc(p.variantLabel || '')}">${esc(region)}</span>`;
    } else if (p.variant === '_AD') {
      variantBadge = `<span class="variant-badge ad" title="${t('lbl_accessibility')}">AD</span>`;
    } else if (p.variant === '_COMMENTARY') {
      variantBadge = `<span class="variant-badge commentary" title="${t('lbl_commentary')}">DIR</span>`;
    } else if (p.variant === '_SDH') {
      variantBadge = `<span class="variant-badge sdh" title="${t('lbl_sdh')}">${t('lbl_sdh')}</span>`;
    } else if (p.variant === '_SIGNS') {
      variantBadge = `<span class="variant-badge signs" title="${t('lbl_signs')}">${t('lbl_signs')}</span>`;
    } else if (p.trackType === 'unknown') {
      variantBadge = `<span class="variant-badge unknown" title="${t('lbl_unknown_type')}">⚑ ${t('lbl_unknown_type')}</span>`;
    } else if (isUnknownDup(p)) {
      variantBadge = `<span class="variant-badge unknown" title="${t('variant_unknown_tip')}">?</span>`;
    }

    // Original source name (if exists and differs from rendered name)
    const sourceName = p.name && p.name !== p.newName
      ? `<span class="pv-source-name">${esc(p.name)}</span>` : '';

    row.innerHTML = `
      <span class="pv-icon">${icon}</span>
      <span class="pv-lang">${esc((p.lang || 'und').toUpperCase())}${variantBadge}</span>
      <span class="pv-details">${esc(details.join(' · '))} ${tag}${sourceName}</span>
      <span class="pv-name">${p.newName ? '"' + esc(p.newName) + '"' : '<i>' + t('no_name') + '</i>'}</span>
      <span class="pv-status">${p.keep ? t('keep') : t('drop')}</span>`;

    // "Set variant" button for unknown duplicates
    if (editable && isUnknownDup(p)) {
      const setBtn = document.createElement('button');
      setBtn.className = 'btn-icon small pv-variant-btn';
      setBtn.title = t('variant_set_tip');
      setBtn.textContent = '⚑';
      setBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openVariantPicker(p, row, item);
      });
      row.appendChild(setBtn);
    }

    if (editable) {
      row.title = t('toggle_track');
      row.addEventListener('click', () => toggleTrack(p.id));
    }
    list.appendChild(row);
  }
}

function openVariantPicker(track, row, item) {
  // Remove any existing picker
  document.querySelectorAll('.variant-picker').forEach(el => el.remove());

  const iso2 = track.lang.length === 2 ? track.lang : (track.lang.length === 3 ? isoLangToIso2Client(track.lang) : track.lang);
  const knownVariants = getVariantsForLang(iso2);

  const picker = document.createElement('div');
  picker.className = 'variant-picker';

  const options = [
    ...knownVariants.map(v => `<option value="${v.variant}">${v.label} (${v.variant})</option>`),
    `<option value="_COMMENTARY">${t('lbl_commentary')}</option>`,
    `<option value="_AD">${t('lbl_accessibility')}</option>`,
  ].join('');

  picker.innerHTML = `
    <select id="variant-picker-select">
      <option value="">${t('variant_select_placeholder')}</option>
      ${options}
    </select>
    <button class="btn-primary small" id="variant-picker-ok">${t('ok')}</button>
    <button class="btn-secondary small" id="variant-picker-cancel">✕</button>`;

  row.appendChild(picker);

  // Stop ALL clicks inside the picker from bubbling to the row's toggleTrack handler
  picker.addEventListener('click', (e) => e.stopPropagation());

  picker.querySelector('#variant-picker-cancel').addEventListener('click', () => {
    picker.remove();
  });

  picker.querySelector('#variant-picker-ok').addEventListener('click', () => {
    const sel = picker.querySelector('#variant-picker-select').value;
    if (sel) setTrackVariant(track.id, sel, item);
    picker.remove();
  });
}

function setTrackVariant(trackId, variant, item) {
  // Apply variant override to the track in item.tracks so replan sees it
  const variantLabels = {};
  const vm = state.meta.variantMap || {};
  for (const [v, entry] of Object.entries(vm)) variantLabels[v] = entry.label;

  const track = item.tracks.find(t => t.id === trackId);
  if (track) {
    track.variant = variant;
    track.variantLabel = variantLabels[variant] || variant;
    track.trackType = variant === '_AD' ? 'accessibility' : variant === '_COMMENTARY' ? 'commentary' : 'normal';
  }
  recomputeItemPlan(item);
}

function getVariantsForLang(iso2) {
  const vm = state.meta.variantMap || {};
  return Object.entries(vm)
    .filter(([v, _]) => !v.startsWith('_') && v.startsWith(iso2 + '-'))
    .map(([variant, entry]) => ({ variant, label: entry.label }));
}

function isoLangToIso2Client(iso3) {
  const map = { spa:'es', eng:'en', fra:'fr', por:'pt', deu:'de', ita:'it', jpn:'ja', zho:'zh', kor:'ko', rus:'ru' };
  return map[iso3] || iso3;
}

// Toggle a track keep/drop for the current preview item (manual override)
function toggleTrack(trackId) {
  const item = state.previewItem;
  if (!item) return;
  const track = item.plan.find(p => p.id === trackId);
  if (!track || track.role === 'video') return;
  if (!item.overrides) item.overrides = {};
  const desired = !track.keep;
  // If desired state matches what the filters would do anyway, it's not a real
  // override — remove it so the "manual" flag disappears.
  if (item.naturalState && item.naturalState[trackId] === desired) {
    delete item.overrides[trackId];
  } else {
    item.overrides[trackId] = desired;
  }
  if (Object.keys(item.overrides).length === 0) item.overrides = null;
  recomputeItemPlan(item);
}

async function recomputeItemPlan(item) {
  // Ask the backend to re-plan with current settings + overrides
  try {
    const res = await window.api.replan({ tracks: item.tracks, overrides: item.overrides || {} });
    if (res && res.plan) {
      item.plan = res.plan;
      if (res.natural) item.naturalState = res.natural;
      renderPreviewList();
    }
  } catch (_) {}
}

function resetPreviewOverrides() {
  const item = state.previewItem;
  if (!item) return;
  item.overrides = null;
  recomputeItemPlan(item);
}

// ── Processing ──────────────────────────────────────────────────────────────
async function processBatch() {
  if (state.processing) return;
  const items = state.queue.filter(i => i.status === 'ready' || i.status === 'review');
  if (!items.length) { addLog(t('nothing_to_process'), 'warn'); return; }
  const needReview = items.filter(i => i.status === 'review');
  if (needReview.length) {
    if (!confirm(t('confirm_unreviewed', { n: needReview.length }))) return;
  }
  state.processing = true;
  $('btn-process').classList.add('hidden');
  $('btn-cancel').classList.remove('hidden');
  $('overall-progress').classList.remove('hidden');
  $('overall-bar').style.width = '0%';
  $('overall-pct').textContent = '0%';
  const payload = items.map(i => ({ filePath: i.filePath, movie: i.movie, overrides: i.overrides || null, tmpDir: i.tmpDir || null, tracks: i.tracks || null }));
  await window.api.processBatch(payload);
}

async function cancelBatch() {
  state.processing = false;
  await window.api.cancel();
  $('btn-process').classList.remove('hidden');
  $('btn-cancel').classList.add('hidden');
  addLog(t('cancelled'), 'warn');
}

// ── Settings UI (with reusable template fields) ───────────────────────────────
function buildSettingsUI() {
  // Codec toggle chips
  const cp = $('codec-picker');
  cp.innerHTML = '';
  COMMON_CODECS.forEach(c => {
    const chip = document.createElement('button');
    chip.className = 'chip'; chip.textContent = c; chip.dataset.codec = c;
    chip.addEventListener('click', () => chip.classList.toggle('active'));
    cp.appendChild(chip);
  });

  // Build each template field component
  document.querySelectorAll('.tpl-field').forEach(container => {
    const fieldKey = container.dataset.field;
    const varsType = container.dataset.vars;
    buildTemplateField(container, fieldKey, varsType);
  });

  // Accordion: click header to toggle its section. Multiple can be open.
  document.querySelectorAll('.settings-section[data-acc] .acc-header').forEach(header => {
    header.addEventListener('click', () => {
      header.parentElement.classList.toggle('open');
    });
  });
  // Group-level collapse: click group header to hide/show all its sections.
  document.querySelectorAll('.settings-group-header').forEach(h => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
  });
}

function buildTemplateField(container, fieldKey, varsType) {
  const vars = varsType === 'audio' ? state.meta.audioVariables
    : varsType === 'subtitle' ? state.meta.subtitleVariables
    : varsType === 'series' ? state.meta.seriesVariables
    : varsType === 'track' ? state.meta.trackVariables
    : state.meta.fileVariables;

  // Input
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'input';
  input.placeholder = '(empty)';

  // Variable chips
  const chipRow = document.createElement('div');
  chipRow.className = 'chip-row';
  vars.forEach(v => {
    const chip = document.createElement('button');
    chip.className = 'chip var-chip';
    chip.textContent = v.token;
    chip.title = v.desc;
    chip.addEventListener('click', () => insertAtCursor(input, v.token));
    chipRow.appendChild(chip);
  });

  // Special chip for track fields: pick a display language → inserts {lang_XX}
  if (varsType === 'track' || varsType === 'audio' || varsType === 'subtitle') {
    const langChip = document.createElement('button');
    langChip.className = 'chip var-chip lang-picker-chip';
    langChip.textContent = '{lang_…}';
    langChip.title = 'Language name in a specific language — pick which one';
    langChip.addEventListener('click', async () => {
      const code = await pickLanguage();
      if (code) insertAtCursor(input, `{lang_${code}}`);
    });
    chipRow.appendChild(langChip);
  }

  // Special chip for file/series fields: fixed release group → inserts {rg_NAME}
  if (varsType === 'file' || varsType === 'series') {
    const rgChip = document.createElement('button');
    rgChip.className = 'chip var-chip lang-picker-chip';
    rgChip.textContent = '{rg_…}';
    rgChip.title = t('rg_chip_title');
    rgChip.addEventListener('click', async () => {
      const name = await askText(t('rg_chip_title'), t('rg_chip_prompt'));
      if (name) insertAtCursor(input, `{rg_${name}}`);
    });
    chipRow.appendChild(rgChip);
  }

  // Preset manager
  const presetRow = document.createElement('div');
  presetRow.className = 'preset-row';
  const select = document.createElement('select');
  select.className = 'input';
  const applyBtn = mkBtn('Apply', 'btn-secondary small');
  const saveBtn = mkBtn('Save as…', 'btn-secondary small');
  const delBtn = mkBtn('Delete', 'btn-secondary small');
  presetRow.append(select, applyBtn, saveBtn, delBtn);

  // Live preview
  const preview = document.createElement('div');
  preview.className = 'preview-name';

  container.append(chipRow, input, presetRow, preview);

  // Register
  state.tplFields[fieldKey] = { input, preview, select, varsType };

  // Events
  input.addEventListener('input', () => updateTplPreview(fieldKey));
  applyBtn.addEventListener('click', () => { input.value = select.value; updateTplPreview(fieldKey); });
  saveBtn.addEventListener('click', () => savePreset(fieldKey));
  delBtn.addEventListener('click', () => deletePreset(fieldKey));

  refreshPresetOptions(fieldKey);
}

function refreshPresetOptions(fieldKey) {
  const { select } = state.tplFields[fieldKey];
  const builtin = state.meta.builtinPresets[fieldKey] || [];
  const user = (state.settings.userPresets && state.settings.userPresets[fieldKey]) || [];
  select.innerHTML = '';
  const add = (p, isUser) => {
    const o = document.createElement('option');
    o.value = p.value;
    o.textContent = (isUser ? '★ ' : '') + p.label;
    o.dataset.user = isUser ? '1' : '0';
    o.dataset.label = p.label;
    select.appendChild(o);
  };
  builtin.forEach(p => add(p, false));
  user.forEach(p => add(p, true));
}

async function savePreset(fieldKey) {
  const { input } = state.tplFields[fieldKey];
  const label = await askText(t('save_preset'), t('preset_name'));
  if (!label) return;
  if (!state.settings.userPresets) state.settings.userPresets = {};
  if (!state.settings.userPresets[fieldKey]) state.settings.userPresets[fieldKey] = [];
  const arr = state.settings.userPresets[fieldKey];
  const existing = arr.findIndex(p => p.label === label);
  const entry = { label, value: input.value };
  if (existing >= 0) arr[existing] = entry; else arr.push(entry);
  refreshPresetOptions(fieldKey);
  // Persist immediately so it survives even without "Save Settings"
  await window.api.saveSettings({ userPresets: state.settings.userPresets });
  addLog(t('preset_saved', { name: label }), 'success');
}

async function deletePreset(fieldKey) {
  const { select } = state.tplFields[fieldKey];
  const opt = select.options[select.selectedIndex];
  if (!opt || opt.dataset.user !== '1') { addLog(t('select_own_preset'), 'warn'); return; }
  const label = opt.dataset.label;
  const arr = state.settings.userPresets[fieldKey] || [];
  state.settings.userPresets[fieldKey] = arr.filter(p => p.label !== label);
  refreshPresetOptions(fieldKey);
  await window.api.saveSettings({ userPresets: state.settings.userPresets });
  addLog(t('preset_deleted', { name: label }), 'info');
}

function updateTplPreview(fieldKey) {
  const { input, preview, varsType } = state.tplFields[fieldKey];
  let fileCtx = null;
  if (varsType === 'file') fileCtx = sampleFileCtx('movie');
  else if (varsType === 'series') fileCtx = sampleFileCtx('series');
  preview.textContent = t('example') + ' ' + renderSample(input.value, varsType, fileCtx);
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

const _MEDIA_SAMPLE = { resolution:'1080p', video_codec:'H.265', hdr:'HDR10', audio_codec:'DTS-HD MA', audio_channels:'5.1', release_group:'GROUP', source:'BluRay' };

// Build a file context from the first identified movie in the queue, if any
function sampleFileCtx(kind) {
  const item = state.queue.find(i => i.movie && i.movie.title && (i.movie.type || 'movie') === kind);
  if (!item) return null;
  const m = item.movie;
  const filename = item.filePath.split('/').pop().replace(/\.[^.]+$/, '');
  const med = mediaCtxFromPlan(item.plan, item.filePath, m.title);
  if (kind === 'series') {
    const pad = n => String(n || 0).padStart(2, '0');
    return {
      series: m.title, year: m.year || '',
      season: String(m.season || 0), episode: String(m.episode || 0),
      season2: pad(m.season), episode2: pad(m.episode),
      sxxexx: `S${pad(m.season)}E${pad(m.episode)}`,
      episode_title: m.episodeTitle || '', filename, ...med,
    };
  }
  return {
    title: m.title, year: m.year || '',
    title_year: m.year ? `${m.title} (${m.year})` : m.title,
    filename, ...med,
  };
}

function renderSample(tpl, varsType, fileCtx) {
  if (!tpl) return '(empty)';

  if (varsType === 'track' || varsType === 'audio' || varsType === 'subtitle') {
    const ctx = {
      lang: 'Español', iso2: 'es', iso3: 'spa', ISO2: 'ES', ISO3: 'SPA',
      codec: 'DTS-HD Master Audio', codec_short: 'DTS-HD MA', channels: '5.1',
      forced: varsType === 'subtitle' ? 'Forced' : '',
      default: '',
      variant: 'LA', variant_label: 'Latin American',
    };
    let out = tpl.replace(/\{lang_([a-z]{2,3})\}/g, (m, dl) => displayName('es', dl) || m);
    out = out.replace(/\{(\w+)\}/g, (m, k) => (k in ctx ? ctx[k] : m));
    return cleanup(out);
  }

  if (varsType === 'series') {
    const ctx = fileCtx || {
      series: 'Breaking Bad', year: '2008', season: '1', episode: '5',
      season2: '01', episode2: '05', sxxexx: 'S01E05',
      episode_title: 'Gray Matter', filename: 'breaking.bad.s01e05',
      clean_title: 'Breaking Bad', ..._MEDIA_SAMPLE,
    };
    let out = tpl.replace(/\{rg_([^}]+)\}/g, (_, name) => name);
    out = out.replace(/\{(\w+)\}/g, (m, k) => (k in ctx ? ctx[k] : m));
    return cleanup(out);
  }

  // File context: use the real movie if we have one, else placeholder
  const ctx = fileCtx || { title: 'The Matrix', year: '1999', title_year: 'The Matrix (1999)', filename: 'the.matrix.1999.1080p', clean_title: 'The Matrix', ..._MEDIA_SAMPLE };
  let out = tpl.replace(/\{rg_([^}]+)\}/g, (_, name) => name);
  out = out.replace(/\{(\w+)\}/g, (m, k) => (k in ctx ? ctx[k] : m));
  return cleanup(out);
}

function cleanup(s) {
  return s.replace(/\s{2,}/g, ' ').replace(/\s+([-–·,|])\s*$/g, '').replace(/^\s*([-–·,|])\s+/g, '').trim() || '(empty)';
}

// Language name helpers for the live preview (Intl works in the renderer too)
function displayName(code, displayLang) {
  try { const n = new Intl.DisplayNames([displayLang], { type: 'language' }).of(code); return n ? n.charAt(0).toUpperCase() + n.slice(1) : ''; }
  catch (_) { return ''; }
}
function nativeName(code) { return displayName(code, code); }
// Minimal iso2->iso3 for the sample preview (interface langs only)
function toIso3Client(code) {
  const map = { en: 'eng', es: 'spa', fr: 'fra', de: 'deu', it: 'ita', pt: 'por', zh: 'zho', ja: 'jpn' };
  return map[code] || code;
}

function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const pos = start + text.length;
  input.focus();
  input.setSelectionRange(pos, pos);
  // Trigger preview update
  input.dispatchEvent(new Event('input'));
}


function populateSettings() {
  const s = state.settings;
  $('setting-output').value = s.outputPath || '';
  $('setting-create-folder').checked = !!s.createFolder;
  $('setting-one-audio').checked = !!s.oneAudioPerLang;
  $('setting-one-sub').checked = !!s.oneSubPerLang;
  $('setting-include-normal').checked  = s.includeNormalSubs  !== false;
  $('setting-include-forced').checked  = s.includeForcedSubs  !== false;
  $('setting-include-sdh').checked     = !!s.includeSdh;
  $('setting-include-signs').checked         = !!s.includeSigns;
  $('setting-include-commentary').checked    = !!s.includeCommentary;
  $('setting-include-accessibility').checked = !!s.includeAccessibility;
  $('setting-include-unknown').checked       = s.includeUnknownSubs !== false;
  $('setting-ocr-enabled').checked     = !!s.ocrEnabled;
  $('setting-ocr-path').value          = s.ocrPath || '';
  $('setting-imdb-tag').checked = !!s.writeImdbTag;
  $('setting-imdb-folder').checked = !!s.imdbInFolder;
  $('setting-embed-cover').checked = !!s.embedCoverArt;
  $('setting-on-exists').value = s.onFileExists || 'rename';
  $('setting-audio-langs').value = s.audioLangs || '';
  { const saved = (s.audioCodecs || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    document.querySelectorAll('#codec-picker .chip').forEach(ch => ch.classList.toggle('active', saved.length > 0 && saved.includes(ch.dataset.codec.toLowerCase()))); }
  $('setting-sub-langs').value = s.subLangs || '';
  $('setting-tmdb-key').value = s.tmdbApiKey || '';
  updateTmdbKeyHint(s.tmdbApiKey || '');
  $('setting-rip-temp').value = s.ripTempPath || '';
  $('setting-jellyfin-enabled').checked = !!s.jellyfinEnabled;
  $('setting-jellyfin-url').value = s.jellyfinUrl || '';
  $('setting-jellyfin-key').value = s.jellyfinApiKey || '';
  $('setting-fetch-episode').checked = !!s.fetchEpisodeTitle;
  $('setting-series-folders').checked = !!s.seriesCreateFolders;
  $('setting-custom-title').checked = !!s.customFileTitle;
  $('setting-series-custom-title').checked = !!s.seriesCustomFileTitle;

  // Template fields
  for (const [fieldKey, setKey] of Object.entries(FIELD_TO_SETTING)) {
    if (state.tplFields[fieldKey]) {
      state.tplFields[fieldKey].input.value = s[setKey] || '';
      updateTplPreview(fieldKey);
    }
  }
  toggleFolderRow();
  toggleJellyfin();
  toggleSeriesFolders();
  toggleCustomTitle();
  toggleSeriesCustomTitle();
}

function toggleFolderRow() {
  $('folder-template-row').style.display = $('setting-create-folder').checked ? '' : 'none';
}
function toggleJellyfin() {
  $('jellyfin-fields').style.display = $('setting-jellyfin-enabled').checked ? '' : 'none';
}
function toggleSeriesFolders() {
  const on = $('setting-series-folders').checked;
  $('series-show-folder-row')?.classList.toggle('hidden', !on);
  $('series-season-folder-row')?.classList.toggle('hidden', !on);
}
function toggleCustomTitle() {
  const row = $('movie-title-row');
  if (row) row.style.display = $('setting-custom-title').checked ? '' : 'none';
}
function toggleSeriesCustomTitle() {
  const row = $('series-title-row');
  if (row) row.style.display = $('setting-series-custom-title').checked ? '' : 'none';
}

async function saveSettings() {
  const s = {
    outputPath: $('setting-output').value,
    createFolder: $('setting-create-folder').checked,
    oneAudioPerLang: $('setting-one-audio').checked,
    oneSubPerLang: $('setting-one-sub').checked,
    writeImdbTag: $('setting-imdb-tag').checked,
    imdbInFolder: $('setting-imdb-folder').checked,
    embedCoverArt: $('setting-embed-cover').checked,
    onFileExists: $('setting-on-exists').value,
    audioLangs: $('setting-audio-langs').value,
    audioCodecs: [...document.querySelectorAll('#codec-picker .chip.active')].map(ch => ch.dataset.codec).join(', '),
    subLangs: $('setting-sub-langs').value,
    includeNormalSubs:  $('setting-include-normal')?.checked  !== false,
    includeForcedSubs:  $('setting-include-forced')?.checked  !== false,
    includeSdh:         !!$('setting-include-sdh')?.checked,
    includeSigns:          !!$('setting-include-signs')?.checked,
    includeCommentary:     !!$('setting-include-commentary')?.checked,
    includeAccessibility:  !!$('setting-include-accessibility')?.checked,
    includeUnknownSubs:    $('setting-include-unknown')?.checked !== false,
    ocrEnabled: !!$('setting-ocr-enabled')?.checked,
    ocrPath:    $('setting-ocr-path')?.value?.trim() || '',
    tmdbApiKey: $('setting-tmdb-key').value,
    ripTempPath: $('setting-rip-temp').value.trim(),
    jellyfinEnabled: $('setting-jellyfin-enabled').checked,
    jellyfinUrl: $('setting-jellyfin-url').value,
    jellyfinApiKey: $('setting-jellyfin-key').value,
    uiLang: state.uiLang,
    fileTitleTemplate: state.tplFields.fileTitle.input.value,
    outputNameTemplate: state.tplFields.outputName.input.value,
    folderNameTemplate: state.tplFields.folderName.input.value,
    audioNameTemplate: state.tplFields.audioName.input.value,
    subNameTemplate: state.tplFields.subName.input.value,
    fetchEpisodeTitle: $('setting-fetch-episode').checked,
    seriesCreateFolders: $('setting-series-folders').checked,
    customFileTitle: $('setting-custom-title').checked,
    seriesCustomFileTitle: $('setting-series-custom-title').checked,
    seriesOutputNameTemplate: state.tplFields.seriesOutputName.input.value,
    seriesFileTitleTemplate: state.tplFields.seriesFileTitle.input.value,
    seriesShowFolderTemplate: state.tplFields.seriesShowFolder.input.value,
    seriesSeasonFolderTemplate: state.tplFields.seriesSeasonFolder.input.value,
    userPresets: state.settings.userPresets || {}
  };
  await window.api.saveSettings(s);
  state.settings = { ...state.settings, ...s };
  $('save-feedback').classList.remove('hidden');
  setTimeout(() => $('save-feedback').classList.add('hidden'), 2500);
}

// ── Helpers ────────────────────────────────────────────────────────────────────
// Promise-based language picker. Resolves to an iso2 code or null.
function pickLanguage() {
  return new Promise(resolve => {
    const list = $('langpick-list');
    const search = $('langpick-search');
    const render = (filter = '') => {
      const f = filter.toLowerCase();
      list.innerHTML = '';
      const langs = (state.meta.allLangs || []).filter(l =>
        !f || l.en.toLowerCase().includes(f) || l.native.toLowerCase().includes(f) || l.iso2.includes(f) || l.iso3.includes(f)
      );
      langs.forEach(l => {
        const item = document.createElement('div');
        item.className = 'langpick-item';
        item.innerHTML = `<span class="lp-native">${esc(l.native)}</span><span class="lp-en">${esc(l.en)}</span><span class="lp-code">${l.iso2}</span>`;
        item.addEventListener('click', () => { cleanup(); resolve(l.iso2); });
        list.appendChild(item);
      });
      if (!langs.length) list.innerHTML = `<div class="muted-pad">${t('no_matches')}</div>`;
    };
    const onSearch = () => render(search.value);
    const onClose = () => { cleanup(); resolve(null); };
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    const cleanup = () => {
      hide('view-langpick');
      search.removeEventListener('input', onSearch);
      $('langpick-close').removeEventListener('click', onClose);
      search.removeEventListener('keydown', onKey);
    };
    search.value = '';
    render('');
    show('view-langpick');
    setTimeout(() => search.focus(), 50);
    search.addEventListener('input', onSearch);
    $('langpick-close').addEventListener('click', onClose);
    search.addEventListener('keydown', onKey);
  });
}

function mkBtn(text, cls) { const b = document.createElement('button'); b.className = cls; b.textContent = text; return b; }

// Promise-based text input modal (replaces window.prompt which Electron blocks)
function askText(title, label, initial = '') {
  return new Promise(resolve => {
    $('asktext-title').textContent = title;
    $('asktext-label').textContent = label;
    const input = $('asktext-input');
    input.value = initial;
    show('view-asktext');
    setTimeout(() => input.focus(), 50);

    const cleanup = () => {
      hide('view-asktext');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
    };
    const onOk = () => { const v = input.value.trim(); cleanup(); resolve(v || null); };
    const onCancel = () => { cleanup(); resolve(null); };
    const onKey = e => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };

    const okBtn = $('asktext-ok');
    const cancelBtn = $('asktext-cancel');
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}
function showView(name) { document.querySelectorAll('.view').forEach(v => { const on = v.id === `view-${name}`; v.classList.toggle('active', on); v.classList.toggle('hidden', !on); }); }
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }
function addLog(msg, level = 'info', time) {
  const t = time || new Date().toLocaleTimeString();
  const line = document.createElement('span');
  line.className = `log-line ${level}`;
  line.innerHTML = `<span class="time">${t}</span><span class="msg">${esc(msg)}</span>`;
  $('log').appendChild(line);
  $('log').scrollTop = $('log').scrollHeight;
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function cssEsc(s) { return s.replace(/["\\]/g, '\\$&'); }

// ── Tools & MakeMKV ──────────────────────────────────────────────────────────

let toolsStatus = null;
let selectedTitleId = null;
let selectedDisc = null;
let selectedDiscMedia = null; // TMDb result for the disc

async function checkTools() {
  toolsStatus = await window.api.getToolsStatus();

  // mkvmerge banner
  const banner = $('tools-banner');
  if (!toolsStatus.mkvmerge.installed) {
    $('tools-banner-msg').textContent = t('mkvmerge_not_found_banner');
    const btn = $('tools-banner-action');
    btn.textContent = t('mkvmerge_how_to_install');
    btn.onclick = () => window.api.openUrl(toolsStatus.mkvmerge.guide?.downloadUrl || 'https://mkvtoolnix.download');
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  // MakeMKV section in settings
  refreshMakemkvSettingsUI();
}

function refreshMakemkvSettingsUI() {
  if (!toolsStatus) return;
  const mk = toolsStatus.makemkv;
  const badge = $('makemkv-status-badge');
  const text = $('makemkv-status-text');
  const dlRow = $('makemkv-download-row');

  if (mk.installed) {
    badge.textContent = '✓';
    badge.className = 'status-badge ok';
    text.textContent = `${t('makemkv_installed')} — ${mk.path}`;
    dlRow?.classList.add('hidden');
  } else {
    badge.textContent = '✗';
    badge.className = 'status-badge error';
    text.textContent = t('makemkv_not_installed');
    dlRow?.classList.remove('hidden');
  }
}

async function refreshOcrStatus() {
  const st = await window.api.getOcrStatus();
  const tess = st?.tesseract;
  const setBadge = (id, ok, label) => {
    const el = $(id);
    if (!el) return;
    el.textContent = (ok ? '✓ ' : '✗ ') + label;
    el.className = 'status-badge ' + (ok ? 'ok' : 'error');
  };
  setBadge('ocr-status-tesseract', tess?.installed,
    tess?.installed ? `${t('ocr_tesseract_ok')} ${tess.version || ''}` : t('ocr_tesseract_missing'));
  if (st?.pgsrip?.installed)
    setBadge('ocr-status-pgsrip', true, t('ocr_pgsrip_ok'));
  else
    $('ocr-status-pgsrip').textContent = '';
  if (st?.pgsocr?.installed)
    setBadge('ocr-status-pgsocr', true, t('ocr_pgsocr_ok'));
  else
    $('ocr-status-pgsocr').textContent = '';
  const gpuEl = $('ocr-status-gpu');
  if (gpuEl) {
    if (st?.gpu?.type) { gpuEl.textContent = '✓ ' + t('ocr_gpu_available') + (st.gpu.name ? ` (${st.gpu.name})` : ''); gpuEl.className = 'status-badge ok'; }
    else { gpuEl.textContent = t('ocr_gpu_none'); gpuEl.className = 'status-badge muted'; }
  }
  const langsEl = $('ocr-langs-text');
  if (langsEl) {
    langsEl.textContent = tess?.langs?.length ? tess.langs.join(', ') : '—';
  }
  const installCard = $('ocr-install-card');
  if (installCard) installCard.classList.toggle('hidden', !!tess?.installed);
}

function attachMakemkvEvents() {
  $('btn-rip-disc').addEventListener('click', openRipDisc);
  $('btn-rip-disc-queue').addEventListener('click', openRipDisc);
  $('btn-close-disc-rip').addEventListener('click', () => hide('view-disc-rip'));
  $('btn-disc-retry').addEventListener('click', startDiscScan);
  $('btn-disc-rescan').addEventListener('click', startDiscScan);
  $('btn-disc-rip').addEventListener('click', startRip);
  $('btn-disc-cancel-rip').addEventListener('click', cancelRip);
  $('btn-rip-banner-cancel').addEventListener('click', cancelRip);
  $('btn-close-makemkv-setup').addEventListener('click', () => hide('view-makemkv-setup'));
  $('btn-makemkv-check-again').addEventListener('click', async () => {
    await checkTools();
    if (toolsStatus.makemkv.installed) { hide('view-makemkv-setup'); openRipDisc(); }
    else $('makemkv-setup-body').textContent = t('makemkv_still_not_found');
  });
  $('btn-makemkv-download').addEventListener('click', () =>
    window.api.openUrl('https://www.makemkv.com/download/'));

  $('btn-makemkv-open-download').addEventListener('click', () =>
    window.api.openUrl('https://www.makemkv.com/download/'));

  // OCR section
  $('btn-ocr-check')?.addEventListener('click', refreshOcrStatus);
  $('btn-choose-ocr-path')?.addEventListener('click', async () => {
    const f = await window.api.chooseFolder();
    if (f) { $('setting-ocr-path').value = f; }
  });
  $('ocr-win-link')?.addEventListener('click', e => {
    e.preventDefault();
    window.api.openUrl('https://github.com/UB-Mannheim/tesseract/wiki');
  });
  refreshOcrStatus();

  // Season/episode inputs refresh badges
  $('disc-series-season')?.addEventListener('input', renderTitleEpisodeBadges);
  $('disc-series-start-ep')?.addEventListener('input', renderTitleEpisodeBadges);

  // Rip events from main process
  window.api.on('rip-started', () => {
    hide('view-disc-rip');
    $('rip-banner').classList.remove('hidden');
    $('rip-banner-bar').style.width = '0%';
    $('rip-banner-pct').textContent = '0%';
    $('rip-banner-label').textContent = t('disc_ripping_label');
  });
  window.api.on('rip-progress', pct => {
    $('rip-banner-bar').style.width = pct + '%';
    $('rip-banner-pct').textContent = pct + '%';
  });
  window.api.on('rip-complete', ({ filePath, tmpDir, media, auto }) => {
    $('rip-banner').classList.add('hidden');
    addLog(t('disc_rip_complete', { file: filePath.split('/').pop() }), 'success');
    enqueueFiles([filePath], tmpDir, media || null, !!auto);
  });
  window.api.on('rip-failed', ({ error }) => {
    $('rip-banner').classList.add('hidden');
    showDiscState('disc-error');
    show('view-disc-rip');
    $('disc-error-msg').textContent = error;
  });
}

async function openRipDisc() {
  if (!toolsStatus) await checkTools();
  if (!toolsStatus.makemkv.installed) {
    showMakemkvSetup();
    return;
  }
  show('view-disc-rip');
  startDiscScan();
}

function showMakemkvSetup() {
  const body = $('makemkv-setup-body');
  body.innerHTML = '';
  show('view-makemkv-setup');
}

// ── Confidence helpers ────────────────────────────────────────────────────────

// Returns {title, confident} — confident when one title clearly dominates
function pickBestTitle(titles) {
  if (!titles.length) return { title: null, confident: false };
  if (titles.length === 1) return { title: titles[0], confident: true };

  const preferred = parseLangList(state.settings.audioLangs || '');
  const scored = titles.map(t => ({
    title: t,
    lang: langScore(t, preferred),
    secs: durationSeconds(t.duration)
  }));

  const best = scored.reduce((a, b) => {
    if (a.lang !== b.lang) return a.lang > b.lang ? a : b;
    return a.secs >= b.secs ? a : b;
  });

  const maxSecs = Math.max(...scored.map(s => s.secs));
  const secondBestSecs = scored
    .filter(s => s.title !== best.title)
    .reduce((a, b) => Math.max(a, b.secs), 0);

  // Confident if it has preferred langs AND is at least 20% longer than next candidate
  const dominant = best.secs >= secondBestSecs * 1.20;
  const hasLang = preferred.length === 0 || best.lang > 0;
  return { title: best.title, confident: dominant && hasLang };
}

// Name similarity: what fraction of disc words appear in TMDb title
function nameSimilarity(discName, tmdbTitle) {
  if (!discName || !tmdbTitle) return 0;
  const clean = s => s.toUpperCase().replace(/[^A-Z0-9\s]/g, '').trim();
  const discWords = clean(discName).split(/\s+/).filter(w => w.length > 2);
  const tmdb = clean(tmdbTitle);
  if (!discWords.length) return 0;
  const matches = discWords.filter(w => tmdb.includes(w)).length;
  return matches / discWords.length;
}

async function startDiscScan() {
  showDiscState('disc-scanning');
  selectedTitleId = null;
  selectedDiscMedia = null;
  $('btn-disc-rip').disabled = true;

  const res = await window.api.scanDisc();
  if (!res.ok || !res.discs || res.discs.length === 0) {
    showDiscState('disc-error');
    $('disc-error-msg').textContent = res.error || t('disc_no_disc');
    return;
  }

  const disc = res.discs[0];
  selectedDisc = disc;

  // ── Step 1: pick best title ───────────────────────────────────────────────
  const { title: bestTitle, confident: titleConfident } = pickBestTitle(disc.titles);
  selectedTitleId = bestTitle?.id ?? null;

  // ── Step 2: identify movie via TMDb ──────────────────────────────────────
  let movieConfident = false;
  if (disc.discTitle) {
    try {
      const isSeries = looksLikeSeries(disc.discTitle);
      const searchFn = isSeries ? window.api.searchTV : window.api.searchMovie;
      const tmdbRes = await searchFn({ query: disc.discTitle });
      if (tmdbRes && !tmdbRes.noKey) {
        const results = Array.isArray(tmdbRes) ? tmdbRes : (tmdbRes.results || []);
        if (results.length > 0) {
          const sim = nameSimilarity(disc.discTitle, results[0].title);
          movieConfident = sim >= 0.6;
          selectedDiscMedia = results[0];
        }
      }
    } catch (_) {}
  }

  // ── Step 3: fully automatic if confident about everything ─────────────────
  if (titleConfident && movieConfident && selectedTitleId !== null) {
    const label = selectedDiscMedia
      ? `${selectedDiscMedia.title}${selectedDiscMedia.year ? ` (${selectedDiscMedia.year})` : ''}`
      : `Title ${selectedTitleId}`;
    $('disc-rip-label').textContent = `${t('disc_ripping_label')} — ${label}`;
    showDiscState('disc-ripping');
    $('disc-rip-bar').style.width = '0%';
    $('disc-rip-pct').textContent = '0%';
    await window.api.ripTitle({
      discIndex: selectedDisc.index,
      discTarget: selectedDisc.target || null,
      titleId: selectedTitleId,
      media: selectedDiscMedia,
      auto: true
    });
    return;
  }

  // ── Step 4: show unified review modal ─────────────────────────────────────
  $('disc-name').textContent = disc.discTitle ? `Disc: ${disc.discTitle}` : `Disc ${disc.index}`;

  // Show/hide identification card based on confidence
  const card = $('disc-identify-card');
  if (card) {
    if (movieConfident && selectedDiscMedia) {
      showDiscIdentifyResult(selectedDiscMedia);
    } else if (disc.discTitle) {
      if (selectedDiscMedia) {
        // Found something but not confident — show it so user can confirm
        showDiscIdentifyResult(selectedDiscMedia);
      } else {
        showDiscIdentifyNone();
      }
    } else {
      showDiscIdentifyNone();
    }
  }

  renderTitleList(disc.titles);

  // Add a hint if we weren't confident about something
  const hints = [];
  if (!titleConfident && disc.titles.length > 1) hints.push(t('disc_hint_title'));
  if (!movieConfident) hints.push(t('disc_hint_movie'));
  const hintEl = $('disc-review-hint');
  if (hintEl) {
    hintEl.textContent = hints.length ? hints.join(' · ') : '';
    hintEl.classList.toggle('hidden', !hints.length);
  }

  showDiscState('disc-titles');
}

function renderTitleList(titles) {
  const list = $('disc-title-list');
  list.innerHTML = '';
  if (!titles.length) {
    list.innerHTML = '<div class="muted-pad">No titles found on disc.</div>';
    return;
  }
  titles.forEach(t => {
    const row = document.createElement('div');
    row.className = 'disc-title-row';
    row.dataset.id = t.id;

    const streams = t.streams || [];
    const langs = [...new Set(streams.filter(s => s.langCode).map(s => s.langCode))].join(', ');
    const size = t.sizeMB ? `${t.sizeMB >= 1024 ? (t.sizeMB / 1024).toFixed(1) + ' GB' : t.sizeMB + ' MB'}` : '';

    row.innerHTML = `
      <div class="dt-check"><input type="radio" name="disc-title" value="${t.id}"></div>
      <div class="dt-info">
        <div class="dt-name">${esc(t.name)}</div>
        <div class="dt-meta">
          ${t.duration ? `<span>⏱ ${esc(t.duration)}</span>` : ''}
          ${t.chapters ? `<span>📑 ${t.chapters} chapters</span>` : ''}
          ${size ? `<span>💾 ${size}</span>` : ''}
          ${langs ? `<span>🗣 ${esc(langs)}</span>` : ''}
        </div>
      </div>`;

    const radio = row.querySelector('input[type=radio]');
    radio.addEventListener('change', () => {
      document.querySelectorAll('.disc-title-row').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      selectedTitleId = t.id;
      $('btn-disc-rip').disabled = false;
    });
    row.addEventListener('click', () => radio.click());
    list.appendChild(row);
  });

  // Auto-select: prefer title with most configured-language tracks, break ties by duration
  if (titles.length) {
    const preferred = parseLangList(state.settings.audioLangs || '');
    const best = titles.reduce((a, b) => {
      const sa = langScore(a, preferred), sb = langScore(b, preferred);
      if (sa !== sb) return sa > sb ? a : b;
      return durationSeconds(b.duration) > durationSeconds(a.duration) ? b : a;
    });
    const autoRow = list.querySelector(`[data-id="${best.id}"]`);
    if (autoRow) autoRow.querySelector('input').click();
  }
}

function parseLangList(str) {
  return str.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function langScore(title, preferred) {
  if (!preferred.length) return 0;
  const streams = title.streams || [];
  const titleLangs = streams.map(s => (s.langCode || '').toLowerCase());
  return preferred.filter(p => titleLangs.some(l => l === p || l.startsWith(p) || p.startsWith(l))).length;
}

function durationSeconds(str) {
  if (!str) return 0;
  const p = str.split(':').map(Number);
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return parseInt(str) || 0;
}

// ── Disc identification ───────────────────────────────────────────────────────

function showDiscIdentifyCard(state) {
  ['disc-identify-searching', 'disc-identify-result', 'disc-identify-none',
   'disc-identify-search-box', 'disc-identify-results-list'].forEach(id => {
    const el = $(id);
    if (el) el.classList.add('hidden');
  });
  if (state) $(state)?.classList.remove('hidden');
}

// Returns the currently selected search type (movie/tv) from the radio buttons
function discSearchType() {
  const el = document.querySelector('input[name="disc-search-type"]:checked');
  return el ? el.value : 'movie';
}

function setDiscSearchType(type) {
  const el = document.querySelector(`input[name="disc-search-type"][value="${type}"]`);
  if (el) el.checked = true;
}

// Show/hide the series season+episode fields based on identified type
function updateSeriesFields() {
  const isTv = selectedDiscMedia && selectedDiscMedia.type === 'series';
  $('disc-series-fields')?.classList.toggle('hidden', !isTv);
  if (isTv) renderTitleEpisodeBadges();
}

// Re-render episode badges on title rows based on season/startEp inputs
function renderTitleEpisodeBadges() {
  const season = parseInt($('disc-series-season')?.value || '1', 10);
  const startEp = parseInt($('disc-series-start-ep')?.value || '1', 10);
  document.querySelectorAll('.disc-title-row').forEach((row, i) => {
    let badge = row.querySelector('.dt-episode-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'dt-episode-badge';
      row.querySelector('.dt-name')?.appendChild(badge);
    }
    badge.textContent = `S${String(season).padStart(2,'0')}E${String(startEp + i).padStart(2,'0')}`;
    row.dataset.episode = startEp + i;
    row.dataset.season = season;
  });
}

function showDiscIdentifyNone() {
  showDiscIdentifyCard('disc-identify-none');
  $('disc-series-fields')?.classList.add('hidden');
  $('btn-disc-identify-search').onclick = () => showDiscIdentifySearchBox();
}

function showDiscIdentifySearchBox(prefill = '', type = null) {
  showDiscIdentifyCard('disc-identify-search-box');
  const inp = $('disc-identify-query');
  if (prefill) inp.value = prefill;
  if (type) setDiscSearchType(type);
  inp.focus();

  const go = async () => {
    const query = inp.value.trim();
    const year = $('disc-identify-year-input')?.value?.trim() || '';
    const searchType = discSearchType();
    await discIdentifySearch(query, year ? parseInt(year) : null, searchType);
  };
  $('btn-disc-identify-go').onclick = go;
  inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
}

function showDiscIdentifyResult(media) {
  selectedDiscMedia = media;
  showDiscIdentifyCard('disc-identify-result');
  const poster = $('disc-identify-poster');
  if (media.posterPath) {
    poster.src = media.posterPath;
    poster.style.display = '';
  } else {
    poster.src = '';
    poster.style.display = 'none';
  }
  $('disc-identify-title').textContent = media.title;
  $('disc-identify-year').textContent = media.year || '';
  const badge = $('disc-identify-type-badge');
  if (badge) badge.textContent = media.type === 'series' ? t('disc_type_tv') : t('disc_type_movie');
  $('btn-disc-identify-change').onclick = () => showDiscIdentifySearchBox(media.title, media.type === 'series' ? 'tv' : 'movie');
  updateSeriesFields();
}

// Auto-detect if disc name looks like a TV series
function looksLikeSeries(name) {
  return /\bS\d{1,2}\b|\bSEASON\s*\d|\bTEMPORAD|\bSERIES?\b|\bEPISODE\b|\bSERIE\b/i.test(name || '');
}

async function discIdentifySearch(query, year, type) {
  if (!query) return;
  showDiscIdentifyCard('disc-identify-searching');
  try {
    const isTv = type === 'tv';
    const searchFn = isTv ? window.api.searchTV : window.api.searchMovie;
    const res = await searchFn({ query, year });
    if (res && res.noKey) { showDiscIdentifyNone(); return; }
    const results = Array.isArray(res) ? res : (res.results || []);
    if (!results || results.length === 0) { showDiscIdentifyNone(); return; }
    if (results.length === 1) { showDiscIdentifyResult(results[0]); return; }

    showDiscIdentifyCard('disc-identify-results-list');
    const list = $('disc-identify-results-list');
    list.innerHTML = '';
    results.forEach(m => {
      const opt = document.createElement('div');
      opt.className = 'disc-identify-option';
      opt.innerHTML = `
        <img src="${esc(m.posterPath || '')}" onerror="this.style.display='none'" alt="">
        <div class="disc-identify-option-info">
          <div class="disc-identify-option-title">${esc(m.title)}</div>
          <div class="disc-identify-option-year">${esc(m.year || '')}${m.type === 'series' ? ' · 📺' : ''}</div>
        </div>`;
      opt.addEventListener('click', () => showDiscIdentifyResult(m));
      list.appendChild(opt);
    });
  } catch (_) {
    showDiscIdentifyNone();
  }
}

// ── Rip ───────────────────────────────────────────────────────────────────────

async function startRip() {
  if (selectedTitleId === null || !selectedDisc) return;
  $('btn-disc-rip').disabled = true;
  showDiscState('disc-ripping');

  // Build series metadata if applicable
  let ripMedia = selectedDiscMedia || null;
  if (ripMedia && ripMedia.type === 'series') {
    const selectedRow = document.querySelector(`.disc-title-row[data-id="${selectedTitleId}"]`);
    ripMedia = {
      ...ripMedia,
      season: parseInt($('disc-series-season')?.value || '1', 10),
      episode: parseInt(selectedRow?.dataset.episode || $('disc-series-start-ep')?.value || '1', 10)
    };
  }

  await window.api.ripTitle({
    discIndex: selectedDisc.index,
    discTarget: selectedDisc.target || null,
    titleId: selectedTitleId,
    media: ripMedia
  });
}

async function cancelRip() {
  await window.api.cancelRip();
  hide('view-disc-rip');
  $('rip-banner').classList.add('hidden');
  $('btn-disc-rip').disabled = false;
  addLog('Rip cancelled', 'warn');
}

function showDiscState(stateId) {
  ['disc-scanning', 'disc-error', 'disc-titles', 'disc-ripping'].forEach(id => {
    const el = $(id);
    if (el) el.classList.toggle('hidden', id !== stateId);
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
