// NoteKeep - self-hosted notes synced to your own Nextcloud.
// Copyright (C) 2026 MtoseD
// SPDX-License-Identifier: AGPL-3.0-or-later
// Free software under the GNU AGPL v3 or later; see LICENSE. Comes with
// ABSOLUTELY NO WARRANTY. If you run a modified version for others over a
// network, AGPL section 13 requires you to offer them its source.

'use strict';

const BUILD_ID = '2026-08-16.5';
console.log('NoteKeep build', BUILD_ID);

// Upper bound on checklist rows drawn into a card preview. Keep this at or
// above what the .note-checklist max-height can show, so the CSS cap (not this
// number) is what decides where a long checklist gets cut off.
const PREVIEW_CHECKLIST_ITEMS = 10;

// style.css carries the build it was shipped with. If it disagrees with this
// file, the two came from different deploys and the UI will be subtly wrong in
// ways that look like bugs — unstyled controls, the wrong theme — so say so
// rather than leaving it to be rediscovered.
const CSS_BUILD = (() => {
  try {
    return getComputedStyle(document.documentElement)
      .getPropertyValue('--build').trim().replace(/^["']|["']$/g, '');
  } catch (e) { return ''; }
})();
function cssMismatch() { return !!CSS_BUILD && CSS_BUILD !== BUILD_ID; }
if (cssMismatch()) {
  console.warn('[nk] stylesheet/script build mismatch: style.css is ' + CSS_BUILD +
               ' but app.js is ' + BUILD_ID + ' — deploy the whole public/ folder.');
}

/* ================= Utilities ================= */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const escapeHtml = (s) => (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const COLORS = [
  { key: 'default', label: 'Default' },
  { key: 'coral', label: 'Coral' },
  { key: 'peach', label: 'Peach' },
  { key: 'sand', label: 'Sand' },
  { key: 'sage', label: 'Sage' },
  { key: 'mint', label: 'Mint' },
  { key: 'fog', label: 'Fog' },
  { key: 'storm', label: 'Storm' },
  { key: 'dusk', label: 'Dusk' },
  { key: 'blossom', label: 'Blossom' },
  { key: 'clay', label: 'Clay' },
  { key: 'chalk', label: 'Chalk' },
];

/* ================= State ================= */
let DATA = { notes: [], labels: [] };
let SERVER_VERSION = null;
// "We hold edits the server has not accepted yet." This lives in IndexedDB as
// well as memory: it used to be memory-only, so closing the app threw it away
// while the unsynced edits themselves stayed in the cache. On the next launch
// DIRTY was false, the pull below took the "server wins" branch, and those
// edits were overwritten by an older server copy — silent data loss, and the
// reported "sync deleted everything / went back to the server version".
let DIRTY = false;
async function setDirty(v) {
  DIRTY = v;
  try { await NKDB.set('dirty', v); } catch (e) { console.warn('Dirty flag write failed:', e); }
}
let VIEW = { type: 'notes' }; // {type:'notes'|'archive'|'trash'|'label', labelId}
let SEARCH = '';
let TOKEN = localStorage.getItem('nk_token') || '';

/* ================= API ================= */
// Off the home network the server's host resolves but never answers, so a bare
// fetch() sits there for the better part of a minute instead of rejecting —
// leaving the sync spinner turning and the real state ("offline") unreported.
// Give every API call a deadline so that resolves in seconds.
const API_TIMEOUT_MS = 10000;

async function apiFetch(url, opts = {}) {
  opts.headers = Object.assign({}, opts.headers, TOKEN ? { 'x-app-token': TOKEN } : {});
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
  } catch (e) {
    // "signal is aborted without reason" means nothing to the user.
    if (e && e.name === 'AbortError') throw new Error('server did not respond');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    TOKEN = window.prompt('This NoteKeep server requires an access token:') || '';
    localStorage.setItem('nk_token', TOKEN);
    return apiFetch(url, opts);
  }
  return res;
}

async function pingServer() {
  try {
    const res = await apiFetch('/api/ping');
    const j = await res.json();
    if (j.tokenRequired && !TOKEN) {
      TOKEN = window.prompt('This NoteKeep server requires an access token:') || '';
      localStorage.setItem('nk_token', TOKEN);
    }
  } catch (e) { /* offline, ignore */ }
}

async function pullFromServer(showToastOnFail) {
  setSyncSpinning(true);
  try {
    const res = await apiFetch('/api/data');
    if (!res.ok) {
      let detail = 'HTTP ' + res.status;
      try { const j = await res.json(); if (j.detail) detail = j.detail; else if (j.error) detail = j.error; } catch (e) { /* ignore */ }
      throw new Error(detail);
    }
    const j = await res.json();
    if (j.version !== SERVER_VERSION) {
      // Belt and braces on top of the persisted flag: even when we believe we
      // have nothing outstanding, refuse to replace a note with an older copy.
      // Getting DIRTY wrong for any reason must not cost anyone their notes.
      const localNewer = (DATA.notes || []).some((n) => {
        const r = ((j.data && j.data.notes) || []).find((x) => x.id === n.id);
        return !r || (n.updatedAt || 0) > (r.updatedAt || 0);
      });
      if (!DIRTY && !localNewer) {
        DATA = j.data && j.data.notes ? j.data : DATA;
        SERVER_VERSION = j.version;
        resetHistory();
        render();
        cacheLocally(DATA, SERVER_VERSION);
      } else {
        // We have unsynced local edits; merge instead of clobbering.
        DATA = mergeData(DATA, j.data);
        SERVER_VERSION = j.version;
        resetHistory();
        render();
        cacheLocally(DATA, SERVER_VERSION);
        pushToServer();
      }
    }
    setSyncStatus('ok');
  } catch (e) {
    setSyncStatus('offline');
    if (showToastOnFail) showToast("Can't reach your Nextcloud: " + e.message);
  } finally {
    setSyncSpinning(false);
  }
}

// Best-effort local cache write. This must never affect sync status or
// throw up to the caller — a phone's IndexedDB hiccuping is a local-storage
// problem, not a "can't reach Nextcloud" problem, and shouldn't be reported
// as one or block rendering the data we already fetched.
async function cacheLocally(data, version) {
  try {
    await NKDB.set('data', data);
    await NKDB.set('version', version);
  } catch (e) {
    console.warn('Local cache write failed (will retry next sync):', e);
  }
}

const pushToServer = debounce(async () => {
  if (!DIRTY) return;
  setSyncSpinning(true);
  try {
    const res = await apiFetch('/api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: DATA, baseVersion: SERVER_VERSION }),
    });
    if (res.status === 409) {
      const j = await res.json();
      DATA = mergeData(DATA, j.remote);
      SERVER_VERSION = j.version;
      resetHistory();
      render();
      cacheLocally(DATA, SERVER_VERSION);
      return pushToServer();
    }
    if (!res.ok) throw new Error('push failed ' + res.status);
    const j = await res.json();
    SERVER_VERSION = j.version;
    await setDirty(false);
    cacheLocally(DATA, SERVER_VERSION);
    setSyncStatus('ok');
  } catch (e) {
    setSyncStatus('offline'); // will retry on next periodic pull/push cycle
  } finally {
    setSyncSpinning(false);
  }
}, 1200);

function mergeData(local, remote) {
  remote = remote || { notes: [], labels: [] };
  const byId = new Map();
  (remote.notes || []).forEach((n) => byId.set(n.id, n));
  (local.notes || []).forEach((n) => {
    const r = byId.get(n.id);
    if (!r || (n.updatedAt || 0) >= (r.updatedAt || 0)) byId.set(n.id, n);
  });
  const labelIds = new Map();
  (remote.labels || []).forEach((l) => labelIds.set(l.id, l));
  (local.labels || []).forEach((l) => labelIds.set(l.id, l));
  return { notes: Array.from(byId.values()), labels: Array.from(labelIds.values()) };
}

/* ================= Persistence ================= */
/* ================= Undo / redo ================= */
// Snapshots of the whole dataset rather than a log of operations: every
// mutation already funnels through saveLocal(), so one hook covers editing
// text, ticking boxes, colours, labels, pin, archive and delete without each
// having to describe how to reverse itself.
//
// BASELINE is the state as of the last entry pushed. Pushing is debounced so a
// burst of keystrokes collapses into a single undo step instead of one per
// character — undoing a sentence letter by letter would be useless.
const HISTORY_LIMIT = 60;
const HISTORY_COALESCE_MS = 700;
let UNDO_STACK = [];
let REDO_STACK = [];
let BASELINE = null;
let historyTimer = null;

function serialize() { return JSON.stringify(DATA); }

// Sync is not an edit, and must never be undoable. Anything that replaces DATA
// from the server re-baselines and drops the stacks: the entries describe a
// dataset that no longer exists, and undoing across a sync would resurrect a
// pre-sync state — including, on a launch with an empty or stale local cache,
// the empty dataset that DATA starts out as. That is exactly how undo wiped
// every note and label: BASELINE was captured at init BEFORE the first pull,
// so the oldest undo entry was "nothing at all".
function resetHistory() {
  UNDO_STACK = [];
  REDO_STACK = [];
  clearTimeout(historyTimer); historyTimer = null;
  BASELINE = serialize();
  updateHistoryButtons();
}

function commitHistory() {
  clearTimeout(historyTimer); historyTimer = null;
  const now = serialize();
  if (BASELINE === null) { BASELINE = now; return; }
  if (BASELINE === now) return;
  UNDO_STACK.push(BASELINE);
  if (UNDO_STACK.length > HISTORY_LIMIT) UNDO_STACK.shift();
  REDO_STACK = [];          // a fresh edit invalidates anything redoable
  BASELINE = now;
  updateHistoryButtons();
}

function scheduleHistory() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(commitHistory, HISTORY_COALESCE_MS);
  updateHistoryButtons();
}

// Applying a snapshot must not itself become a new history entry, hence the
// suppression flag around the save.
let APPLYING_HISTORY = false;
async function applySnapshot(json) {
  APPLYING_HISTORY = true;
  DATA = JSON.parse(json);
  BASELINE = json;
  renderSidebarLabels();
  render();
  refreshEditorFromData();
  updateHistoryButtons();
  await setDirty(true);
  try { await NKDB.set('data', DATA); } catch (e) { console.warn('Local cache write failed:', e); }
  pushToServer();
  APPLYING_HISTORY = false;
}

// No single user action empties the entire dataset — notes and labels are only
// ever removed one at a time — so a snapshot that would wipe everything we
// currently hold cannot be a state the user was ever in. Refuse it rather than
// hand it to applySnapshot, which would also push it straight to Nextcloud.
// (Undoing the deletion of your only note is unaffected: that restores notes,
// it does not remove them.)
function wouldWipeEverything(json) {
  const has = (DATA.notes || []).length + (DATA.labels || []).length;
  if (!has) return false;
  try {
    const next = JSON.parse(json);
    return (next.notes || []).length === 0 && (next.labels || []).length === 0;
  } catch (e) { return true; }
}

function undo() {
  commitHistory();                 // fold in anything still being typed
  if (!UNDO_STACK.length) return;
  const snap = UNDO_STACK.pop();
  if (wouldWipeEverything(snap)) {
    console.warn('[nk] refusing an undo step that would empty everything');
    resetHistory();
    showToast('Undo history was out of date and has been cleared.');
    return;
  }
  REDO_STACK.push(serialize());
  applySnapshot(snap);
}

function redo() {
  commitHistory();
  if (!REDO_STACK.length) return;
  const snap = REDO_STACK.pop();
  if (wouldWipeEverything(snap)) {
    console.warn('[nk] refusing a redo step that would empty everything');
    resetHistory();
    return;
  }
  UNDO_STACK.push(serialize());
  applySnapshot(snap);
}

function updateHistoryButtons() {
  const u = document.getElementById('editorUndoBtn');
  const r = document.getElementById('editorRedoBtn');
  if (u) u.disabled = UNDO_STACK.length === 0;
  if (r) r.disabled = REDO_STACK.length === 0;
}

async function saveLocal() {
  if (!APPLYING_HISTORY) scheduleHistory();
  await setDirty(true);
  try { await NKDB.set('data', DATA); } catch (e) { console.warn('Local cache write failed:', e); }
  pushToServer();
}

function touch(note) { note.updatedAt = Date.now(); }

/* ================= CRUD ================= */
function nextOrder() {
  return (DATA.notes.reduce((m, n) => Math.max(m, n.order || 0), 0) || 0) + 10;
}

function createNote({ title, body, items, type, color, pinned, labels, archived }) {
  const clean = (title && title.trim()) || (body && body.trim()) || (items && items.some((i) => i.text.trim()));
  if (!clean) return null;
  const note = {
    id: uid(),
    type: type || 'text',
    title: (title || '').trim(),
    body: (body || '').trim(),
    items: type === 'checklist' ? (items || []).filter((i) => i.text.trim() || items.length === 1) : [],
    color: color || 'default',
    pinned: !!pinned,
    archived: !!archived,
    trashed: false,
    trashedAt: null,
    labels: labels ? labels.slice() : [],
    order: nextOrder(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  DATA.notes.unshift(note);
  saveLocal();
  return note;
}

function getNote(id) { return DATA.notes.find((n) => n.id === id); }

function updateNote(id, patch) {
  const n = getNote(id);
  if (!n) return;
  Object.assign(n, patch);
  touch(n);
  saveLocal();
}

function deleteForever(id) {
  DATA.notes = DATA.notes.filter((n) => n.id !== id);
  saveLocal();
  render();
}

function trashNote(id) { updateNote(id, { trashed: true, trashedAt: Date.now(), pinned: false }); render(); }
function restoreNote(id) { updateNote(id, { trashed: false, trashedAt: null }); render(); }
function archiveNote(id) { updateNote(id, { archived: true, pinned: false }); render(); }
function unarchiveNote(id) { updateNote(id, { archived: false }); render(); }
function togglePin(id) { const n = getNote(id); if (n) updateNote(id, { pinned: !n.pinned }); render(); }
function setColor(id, color) { updateNote(id, { color }); render(); }

function convertNoteType(id) {
  const n = getNote(id);
  if (!n) return;
  if (n.type === 'text') {
    const lines = (n.body || '').split('\n').map((l) => l.trim()).filter((l) => l.length);
    n.items = (lines.length ? lines : ['']).map((t) => ({ id: uid(), text: t, checked: false }));
    n.type = 'checklist';
    n.body = '';
  } else {
    n.body = (n.items || []).map((i) => i.text).filter((t) => t.trim()).join('\n');
    n.items = [];
    n.type = 'text';
  }
  touch(n);
  saveLocal();
}

function purgeOldTrash() {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const before = DATA.notes.length;
  DATA.notes = DATA.notes.filter((n) => !(n.trashed && n.trashedAt && n.trashedAt < weekAgo));
  if (DATA.notes.length !== before) saveLocal();
}

function addLabel(name) {
  name = (name || '').trim();
  if (!name) return null;
  const existing = DATA.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const label = { id: uid(), name };
  DATA.labels.push(label);
  saveLocal();
  renderSidebarLabels();
  return label;
}

function renameLabel(id) {
  const label = DATA.labels.find((l) => l.id === id);
  if (!label) return;
  const name = window.prompt('Rename label', label.name);
  if (!name || !name.trim()) return;
  label.name = name.trim();
  saveLocal();
  render();
}

function deleteLabel(id) {
  if (!window.confirm('Delete this label? It will be removed from all notes.')) return;
  DATA.labels = DATA.labels.filter((l) => l.id !== id);
  DATA.notes.forEach((n) => { n.labels = (n.labels || []).filter((lid) => lid !== id); });
  if (VIEW.type === 'label' && VIEW.labelId === id) setView({ type: 'notes' });
  saveLocal();
  render();
}

function toggleNoteLabel(noteId, labelId) {
  const n = getNote(noteId);
  if (!n) return;
  n.labels = n.labels || [];
  const i = n.labels.indexOf(labelId);
  if (i >= 0) n.labels.splice(i, 1); else n.labels.push(labelId);
  touch(n);
  saveLocal();
}

/* Checklist helpers */
function addChecklistItem(note, text = '') {
  note.items = note.items || [];
  note.items.push({ id: uid(), text, checked: false });
  return note.items[note.items.length - 1];
}
function removeChecklistItem(note, itemId) {
  note.items = (note.items || []).filter((i) => i.id !== itemId);
}
function toggleChecklistItem(note, itemId) {
  const it = (note.items || []).find((i) => i.id === itemId);
  if (it) it.checked = !it.checked;
}

/* ================= Filtering ================= */
function matchesSearch(n, q) {
  if (!q) return true;
  q = q.toLowerCase();
  if (n.title && n.title.toLowerCase().includes(q)) return true;
  if (n.body && n.body.toLowerCase().includes(q)) return true;
  if (n.items && n.items.some((i) => i.text.toLowerCase().includes(q))) return true;
  const labelNames = (n.labels || []).map((id) => (DATA.labels.find((l) => l.id === id) || {}).name || '');
  if (labelNames.some((name) => name.toLowerCase().includes(q))) return true;
  return false;
}

function currentList() {
  let list;
  if (SEARCH.trim()) {
    list = DATA.notes.filter((n) => !n.trashed && matchesSearch(n, SEARCH));
    return { list, flat: true };
  }
  if (VIEW.type === 'archive') list = DATA.notes.filter((n) => n.archived && !n.trashed);
  else if (VIEW.type === 'trash') list = DATA.notes.filter((n) => n.trashed);
  else if (VIEW.type === 'label') list = DATA.notes.filter((n) => !n.archived && !n.trashed && (n.labels || []).includes(VIEW.labelId));
  else list = DATA.notes.filter((n) => !n.archived && !n.trashed);
  return { list, flat: VIEW.type === 'trash' };
}

/* ================= Rendering ================= */
const pinnedGrid = document.getElementById('pinnedGrid');
const notesGrid = document.getElementById('notesGrid');
const pinnedHeading = document.getElementById('pinnedHeading');
const othersHeading = document.getElementById('othersHeading');
const viewHeading = document.getElementById('viewHeading');
const emptyState = document.getElementById('emptyState');
const emptyStateText = document.getElementById('emptyStateText');

function render() {
  // The sidebar label list is part of rendering DATA, so it belongs here
  // rather than at each call site. It used to be the caller's job, and
  // pullFromServer — which replaces DATA wholesale on every sync — never did
  // it: labels stayed missing from the sidebar until something called
  // setView(), i.e. until you clicked Archive or Trash.
  renderSidebarLabels();

  const { list, flat } = currentList();
  list.sort((a, b) => (b.order || 0) - (a.order || 0));

  viewHeading.style.display = 'none';
  pinnedHeading.classList.add('hidden');
  othersHeading.classList.add('hidden');

  let pinned = [], others = [];
  if (flat || SEARCH.trim()) {
    others = list;
  } else {
    pinned = list.filter((n) => n.pinned);
    others = list.filter((n) => !n.pinned);
  }

  const label = VIEW.type === 'label' ? (DATA.labels.find((l) => l.id === VIEW.labelId) || {}).name : null;
  if (!SEARCH.trim()) {
    if (VIEW.type === 'archive') { viewHeading.textContent = 'Archive'; viewHeading.style.display = 'block'; }
    else if (VIEW.type === 'trash') { viewHeading.textContent = 'Trash'; viewHeading.style.display = 'block'; }
    else if (VIEW.type === 'label') { viewHeading.textContent = label || 'Label'; viewHeading.style.display = 'block'; }
  }

  const showSections = pinned.length > 0 && others.length > 0 && !flat;
  if (showSections) { pinnedHeading.classList.remove('hidden'); othersHeading.classList.remove('hidden'); }

  renderGrid(pinnedGrid, pinned, { pinnedContext: true });
  renderGrid(notesGrid, others, { pinnedContext: false });

  const empty = pinned.length === 0 && others.length === 0;
  emptyState.classList.toggle('hidden', !empty);
  if (empty) {
    emptyStateText.textContent = SEARCH.trim() ? 'No matching notes'
      : VIEW.type === 'archive' ? 'Your archived notes appear here'
      : VIEW.type === 'trash' ? 'No notes in trash'
      : VIEW.type === 'label' ? 'No notes with this label yet'
      : 'Notes you add appear here';
  }

  requestAnimationFrame(() => { layoutMasonry(pinnedGrid); layoutMasonry(notesGrid); });
  setupSortable();
}

function renderGrid(grid, notes, ctx) {
  grid.innerHTML = '';
  notes.forEach((n) => grid.appendChild(renderNoteCard(n, ctx)));
}

function renderNoteCard(n, ctx) {
  const el = document.createElement('div');
  el.className = 'note-card';
  el.dataset.id = n.id;
  const bg = n.color && n.color !== 'default' ? `var(--c-${n.color})` : 'var(--surface)';
  el.style.background = bg;
  el.style.setProperty('--card-bg', bg);

  const inTrash = VIEW.type === 'trash' && !SEARCH.trim();

  let inner = '';
  if (!inTrash) {
    inner += `<button class="note-pin-btn ${n.pinned ? 'pinned' : ''}" data-act="pin" title="${n.pinned ? 'Unpin' : 'Pin'} note">
      <svg viewBox="0 0 24 24"><path d="M12 2l1.8 5.6L19 9l-4 3.6.9 6.4L12 16l-3.9 3 .9-6.4L5 9l5.2-1.4z"/></svg>
    </button>`;
  }
  if (n.title) inner += `<div class="note-title">${escapeHtml(n.title)}</div>`;

  if (n.type === 'checklist') {
    const items = n.items || [];
    // Render enough items to actually fill the taller preview cap; the CSS
    // max-height still does the real clipping, this just bounds the DOM work.
    const shown = items.slice(0, PREVIEW_CHECKLIST_ITEMS);
    inner += '<ul class="note-checklist">' + shown.map((i) => `
      <li class="${i.checked ? 'checked' : ''}"><span class="chk"></span><span>${escapeHtml(i.text)}</span></li>
    `).join('') + '</ul>';
    if (items.length > shown.length) inner += `<div class="note-checklist-more">+ ${items.length - shown.length} more</div>`;
  } else if (n.body) {
    inner += `<div class="note-body">${escapeHtml(n.body)}</div>`;
  }

  if (n.labels && n.labels.length) {
    inner += '<div class="note-labels">' + n.labels.map((id) => {
      const l = DATA.labels.find((x) => x.id === id);
      return l ? `<span class="note-label-chip">${escapeHtml(l.name)}</span>` : '';
    }).join('') + '</div>';
  }

  if (inTrash) {
    inner += `<div class="note-footer" style="opacity:1">
      <button class="icon-btn" data-act="restore" title="Restore"><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1015-6.7L21 8"/><path d="M21 2v6h-6"/></svg></button>
      <button class="icon-btn" data-act="delete-forever" title="Delete forever"><svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13"/></svg></button>
    </div>`;
  } else {
    const archiveIcon = n.archived
      ? `<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1015-6.7L21 8"/><path d="M21 2v6h-6"/></svg>`
      : `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 001 1h12a1 1 0 001-1V8"/><path d="M10 13h4"/></svg>`;
    inner += `<div class="note-footer">
      <button class="icon-btn" data-act="color" title="Background options"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20c1.5 0 2-1 2-2s-.5-1.5-.5-2 .5-1 1.5-1h1a5 5 0 005-5c0-5.5-4.5-10-9-10z"/><circle cx="7.5" cy="10.5" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="16.5" cy="10.5" r="1.2"/></svg></button>
      <button class="icon-btn" data-act="label" title="Add label"><svg viewBox="0 0 24 24"><path d="M20.6 12.6L12 21.2 2.8 12 11.4 3.4 20.6 12.6z"/><circle cx="8.5" cy="8.5" r="1.3"/></svg></button>
      <button class="icon-btn" data-act="${n.archived ? 'unarchive' : 'archive'}" title="${n.archived ? 'Unarchive' : 'Archive'}">${archiveIcon}</button>
      <button class="icon-btn" data-act="more" title="More"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg></button>
    </div>`;
  }

  el.innerHTML = inner;

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) { openEditor(n.id); return; }
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === 'pin') togglePin(n.id);
    else if (act === 'restore') restoreNote(n.id);
    else if (act === 'delete-forever') { if (window.confirm('Delete this note forever?')) deleteForever(n.id); }
    else if (act === 'archive') archiveNote(n.id);
    else if (act === 'unarchive') unarchiveNote(n.id);
    else if (act === 'color') openColorPopover(btn, n.id);
    else if (act === 'label') openLabelPopover(btn, n.id);
    else if (act === 'more') openMorePopover(btn, n.id);
  });

  return el;
}

/* ---- Masonry via CSS grid row-span technique ---- */
function layoutMasonry(grid) {
  // Read the *used* row height and gap off the grid itself rather than the
  // --row/--gap custom properties on :root. The mobile breakpoint narrows the
  // gap by setting `gap` on .notes-grid directly, which leaves --gap untouched
  // — so measuring the variable made every card on a phone come out one row
  // too short and clipped the label chips off the bottom.
  const styles = getComputedStyle(grid);
  const row = parseFloat(styles.gridAutoRows) || 8;
  const gap = parseFloat(styles.rowGap) || 14;
  const cards = Array.from(grid.children);
  // Reset spans first so a previously-set span doesn't mask the true
  // content height when shrinking.
  cards.forEach((card) => { card.style.gridRowEnd = 'span 1'; });
  // scrollHeight reflects the full content height even while the card is
  // visually clipped by the grid row sizing — unlike getBoundingClientRect,
  // which only reports the clipped height and was locking every card to
  // the minimum size.
  cards.forEach((card) => {
    const h = card.scrollHeight;
    const span = Math.ceil((h + gap + 2) / (row + gap));
    card.style.gridRowEnd = `span ${span}`;

    const content = card.querySelector('.note-body, .note-checklist');
    if (content) card.classList.toggle('has-more', content.scrollHeight > content.clientHeight + 2);
  });
}
window.addEventListener('resize', debounce(() => { layoutMasonry(pinnedGrid); layoutMasonry(notesGrid); }, 150));
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => { layoutMasonry(pinnedGrid); layoutMasonry(notesGrid); });
}

/* ---- Drag & drop reordering ---- */
let sortablePinned = null, sortableOthers = null;
function setupSortable() {
  const draggable = (VIEW.type === 'notes' || VIEW.type === 'label') && !SEARCH.trim();
  if (sortablePinned) { sortablePinned.destroy(); sortablePinned = null; }
  if (sortableOthers) { sortableOthers.destroy(); sortableOthers = null; }
  if (!draggable || typeof Sortable === 'undefined') return;

  const opts = {
    group: 'notes-group',
    animation: 150,
    delay: 80,
    delayOnTouchOnly: true,
    onEnd: onDragEnd,
  };
  sortablePinned = new Sortable(pinnedGrid, opts);
  sortableOthers = new Sortable(notesGrid, opts);
}

function onDragEnd(evt) {
  const pinnedIds = Array.from(pinnedGrid.children).map((el) => el.dataset.id);
  const otherIds = Array.from(notesGrid.children).map((el) => el.dataset.id);
  let order = pinnedIds.length + otherIds.length;
  pinnedIds.forEach((id) => {
    const n = getNote(id);
    if (n) { n.pinned = true; n.order = order--; }
  });
  otherIds.forEach((id) => {
    const n = getNote(id);
    if (n) { n.pinned = false; n.order = order--; }
  });
  saveLocal();
}

/* ================= Sidebar ================= */
const sidebar = document.getElementById('sidebar');
const sidebarScrim = document.getElementById('sidebarScrim');
document.getElementById('menuBtn').addEventListener('click', () => {
  if (window.matchMedia('(max-width: 880px)').matches) {
    sidebar.classList.toggle('open');
    sidebarScrim.classList.toggle('show');
  } else {
    sidebar.classList.toggle('collapsed');
  }
});
sidebarScrim.addEventListener('click', () => { sidebar.classList.remove('open'); sidebarScrim.classList.remove('show'); });

document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => setView({ type: btn.dataset.view }));
});

function setView(v) {
  VIEW = v;
  SEARCH = '';
  searchInput.value = '';
  clearSearchBtn.classList.add('hidden');
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === v.type));
  sidebar.classList.remove('open'); sidebarScrim.classList.remove('show');
  render();
}

// Label options menu. Built here rather than in index.html so this stays a
// single-file change — index.html/app.js deploy coupling has broken this app
// twice. Reuses the shared .popover machinery, so hideAllPopovers() and the
// click-outside handler pick it up for free.
let labelMenuTarget = null;
let labelMenuPopover = null;
function ensureLabelMenuPopover() {
  if (labelMenuPopover) return labelMenuPopover;
  const pop = document.createElement('div');
  pop.className = 'popover hidden';
  pop.id = 'labelMenuPopover';
  pop.innerHTML =
    '<button class="popover-item" data-act="label-rename">Rename label</button>' +
    '<button class="popover-item" data-act="label-delete">Delete label</button>';
  pop.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    hideAllPopovers();
    if (!labelMenuTarget) return;
    if (btn.dataset.act === 'label-rename') renameLabel(labelMenuTarget);
    else deleteLabel(labelMenuTarget);
  });
  document.body.appendChild(pop);
  labelMenuPopover = pop;
  return pop;
}
function openLabelMenu(anchor, labelId) {
  const pop = ensureLabelMenuPopover();
  hideAllPopovers();
  labelMenuTarget = labelId;
  positionPopover(pop, anchor, 'right');
}

function renderSidebarLabels() {
  const list = document.getElementById('labelList');
  list.innerHTML = '';
  DATA.labels.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((l) => {
    // The row is a wrapper, not a button: the options button cannot be nested
    // inside the label button (invalid, and the clicks fight each other), so it
    // sits alongside and is positioned over the row's right edge in CSS.
    const wrap = document.createElement('div');
    wrap.className = 'label-row';

    const row = document.createElement('button');
    row.className = 'label-item' + (VIEW.type === 'label' && VIEW.labelId === l.id ? ' active' : '');
    row.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20.6 12.6L12 21.2 2.8 12 11.4 3.4 20.6 12.6z"/><circle cx="8.5" cy="8.5" r="1.3"/></svg><span>${escapeHtml(l.name)}</span>`;
    row.addEventListener('click', () => setView({ type: 'label', labelId: l.id }));

    // Replaces a contextmenu handler that asked you to *type* "rename" or
    // "delete" into a prompt. iOS does not reliably fire contextmenu — long
    // press shows the system callout instead — so on a phone renaming or
    // deleting a label was simply unreachable.
    const menu = document.createElement('button');
    menu.type = 'button';
    // icon-btn/tiny are the app's standard control styles — reused rather than
    // restyled, so this button matches every other icon button by construction.
    menu.className = 'icon-btn tiny label-menu-btn popover-trigger';
    menu.title = 'Label options';
    menu.setAttribute('aria-label', 'Options for label ' + l.name);
    menu.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>';
    menu.addEventListener('click', (e) => { e.stopPropagation(); openLabelMenu(menu, l.id); });

    wrap.appendChild(row);
    wrap.appendChild(menu);
    list.appendChild(wrap);
  });
}
document.getElementById('addLabelBtn').addEventListener('click', () => {
  const name = window.prompt('New label name');
  if (name) addLabel(name);
});

/* ================= Search ================= */
const searchInput = document.getElementById('searchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');
searchInput.addEventListener('input', () => {
  SEARCH = searchInput.value;
  clearSearchBtn.classList.toggle('hidden', !SEARCH);
  render();
});
clearSearchBtn.addEventListener('click', () => { searchInput.value = ''; SEARCH = ''; clearSearchBtn.classList.add('hidden'); render(); });

/* ================= Composer ================= */
const composer = document.getElementById('composer');
const composerTitle = document.getElementById('composerTitle');
const composerBody = document.getElementById('composerBody');
const composerActions = document.getElementById('composerActions');
const composerChecklist = document.getElementById('composerChecklist');
let draft = { type: 'text', color: 'default', items: [], pinned: false, labels: [], archived: false };
const composerPinBtn = document.getElementById('composerPinBtn');
const composerArchiveBtn = document.getElementById('composerArchiveBtn');

function resetComposer() {
  draft = { type: 'text', color: 'default', items: [], pinned: false, labels: [], archived: false };
  composerTitle.value = '';
  composerBody.value = '';
  composerBody.style.height = 'auto';
  composerChecklist.innerHTML = '';
  composerChecklist.classList.add('hidden');
  composerBody.classList.remove('hidden');
  composer.style.background = 'var(--surface)';
  composerActions.classList.add('hidden');
  composerPinBtn.classList.remove('on');
  composerArchiveBtn.classList.remove('on');
}
composerPinBtn.addEventListener('click', () => { draft.pinned = !draft.pinned; composerPinBtn.classList.toggle('on', draft.pinned); });
composerArchiveBtn.addEventListener('click', () => { draft.archived = !draft.archived; composerArchiveBtn.classList.toggle('on', draft.archived); });
document.getElementById('composerLabelBtn').addEventListener('click', (e) => openLabelPopover(e.currentTarget, 'composer'));

function expandComposer() { composerActions.classList.remove('hidden'); }
composerTitle.addEventListener('focus', expandComposer);
composerBody.addEventListener('focus', expandComposer);
composerBody.addEventListener('input', () => { composerBody.style.height = 'auto'; composerBody.style.height = composerBody.scrollHeight + 'px'; });

document.getElementById('composerChecklistBtn').addEventListener('click', () => {
  if (draft.type === 'checklist') {
    // Toggle back to a plain text note, carrying item text over as lines.
    draft.type = 'text';
    composerBody.value = draft.items.map((i) => i.text).filter((t) => t.trim()).join('\n');
    composerBody.style.height = 'auto';
    composerBody.style.height = composerBody.scrollHeight + 'px';
    composerChecklist.classList.add('hidden');
    composerBody.classList.remove('hidden');
    draft.items = [];
    return;
  }
  draft.type = 'checklist';
  // Carry over anything already typed as one item per non-empty line.
  const lines = composerBody.value.split('\n').map((l) => l.trim()).filter((l) => l.length);
  draft.items = (lines.length ? lines : ['']).map((t) => ({ id: uid(), text: t, checked: false }));
  composerBody.classList.add('hidden');
  composerChecklist.classList.remove('hidden');
  renderComposerChecklist();
});

function renderComposerChecklist() {
  composerChecklist.innerHTML = '';
  draft.items.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'editor-checklist-row' + (item.checked ? ' checked' : '');
    row.innerHTML = `<button class="chk-toggle" data-idx="${idx}"></button><textarea rows="1" placeholder="List item">${escapeHtml(item.text)}</textarea>`;
    const input = row.querySelector('textarea');
    input.addEventListener('input', () => { item.text = input.value; autoGrowRow(input); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        draft.items.splice(idx + 1, 0, { id: uid(), text: '', checked: false });
        renderComposerChecklist();
        setTimeout(() => {
          const inputs = composerChecklist.querySelectorAll('textarea');
          if (inputs[idx + 1]) inputs[idx + 1].focus();
        }, 0);
      } else if (e.key === 'Backspace' && input.value === '' && draft.items.length > 1) {
        e.preventDefault();
        draft.items.splice(idx, 1);
        renderComposerChecklist();
        setTimeout(() => {
          const inputs = composerChecklist.querySelectorAll('textarea');
          const focusIdx = Math.max(0, idx - 1);
          if (inputs[focusIdx]) inputs[focusIdx].focus();
        }, 0);
      }
    });
    row.querySelector('.chk-toggle').addEventListener('click', () => { item.checked = !item.checked; renderComposerChecklist(); });
    composerChecklist.appendChild(row);
    autoGrowRow(input);   // now attached, so scrollHeight is meaningful
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'text-btn add-item-btn';
  addBtn.textContent = '+ Add item';
  addBtn.addEventListener('click', () => { draft.items.push({ id: uid(), text: '', checked: false }); renderComposerChecklist(); });
  composerChecklist.appendChild(addBtn);
}

document.getElementById('composerColorBtn').addEventListener('click', (e) => {
  openColorPopover(e.currentTarget, 'composer');
});

function commitComposer() {
  if (draft.type === 'checklist') {
    createNote({ type: 'checklist', title: composerTitle.value, items: draft.items, color: draft.color, pinned: draft.pinned, labels: draft.labels, archived: draft.archived });
  } else {
    createNote({ type: 'text', title: composerTitle.value, body: composerBody.value, color: draft.color, pinned: draft.pinned, labels: draft.labels, archived: draft.archived });
  }
  resetComposer();
  render();
}
document.getElementById('composerCloseBtn').addEventListener('click', commitComposer);
// Clicking outside the open composer commits it, like Keep does.
//
// Decided from the event's dispatch path rather than from where the clicked
// node is *now*. Handlers inside the composer rebuild their lists — "+ Add
// item" and the checkbox toggles call renderComposerChecklist(), the label
// popover calls renderLabelPopoverList() — which detaches the very element
// that was clicked. By the time this listener runs, composer.contains(target)
// and target.closest('.popover') both say "outside" for a click that plainly
// happened inside, so the composer committed itself and closed mid-edit.
// composedPath() is fixed when the event is dispatched and survives that.
document.addEventListener('click', (e) => {
  if (composerActions.classList.contains('hidden')) return;

  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  if (path.length) {
    for (const node of path) {
      if (node === composer) return;
      if (node.nodeType === 1 && node.classList && node.classList.contains('popover')) return;
    }
  } else {
    if (composer.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.popover')) return;
  }
  commitComposer();
});

/* ================= Editor ================= */
const editorOverlay = document.getElementById('editorOverlay');
const editorScrim = document.getElementById('editorScrim');
const editor = document.getElementById('editor');
const editorTitle = document.getElementById('editorTitle');
const editorBody = document.getElementById('editorBody');
const editorChecklist = document.getElementById('editorChecklist');
const addChecklistItemBtn = document.getElementById('addChecklistItemBtn');
const editorLabels = document.getElementById('editorLabels');
const editorPinBtn = document.getElementById('editorPinBtn');
const editorArchiveBtn = document.getElementById('editorArchiveBtn');
let editingId = null;
let checklistSortable = null;

// Checklist rows are textareas, not single-line inputs: an <input> cannot wrap,
// so any item longer than the row was clipped with no way to read or edit the
// rest of it. Keep them looking like one line until they need more.
function autoGrowRow(el) {
  el.style.height = 'auto';
  // scrollHeight is 0 while the row is still detached from the document, and
  // committing that collapses the field to nothing. Only trust a real
  // measurement; the caller re-runs this once the row is in the DOM.
  if (el.scrollHeight > 0) el.style.height = el.scrollHeight + 'px';
}

// After undo/redo the open note may have changed underneath us — or vanished,
// if the step being undone was its creation. Update the fields in place rather
// than reopening, so the reader does not lose their scroll position.
function refreshEditorFromData() {
  if (!editingId) return;
  const n = getNote(editingId);
  if (!n || n.trashed) {
    editorOverlay.classList.add('hidden');
    lockBackgroundScroll(false);
    editingId = null;
    return;
  }
  editorTitle.value = n.title || '';
  editor.style.background = n.color && n.color !== 'default' ? `var(--c-${n.color})` : 'var(--surface)';
  editorPinBtn.classList.toggle('on', !!n.pinned);
  editorArchiveBtn.classList.toggle('on', !!n.archived);
  if (n.type === 'checklist') {
    editorBody.classList.add('hidden');
    editorChecklist.classList.remove('hidden');
    addChecklistItemBtn.classList.remove('hidden');
    renderEditorChecklist(n);
    editorChecklist.querySelectorAll('textarea').forEach(autoGrowRow);
  } else {
    editorBody.classList.remove('hidden');
    editorChecklist.classList.add('hidden');
    addChecklistItemBtn.classList.add('hidden');
    editorBody.value = n.body || '';
    autoGrowEditorBody();
  }
  renderEditorLabels(n);
}

function autoGrowEditorBody() {
  editorBody.style.height = 'auto';
  editorBody.style.height = editorBody.scrollHeight + 'px';
}
editorBody.addEventListener('input', autoGrowEditorBody);

// Sizing the overlay from visualViewport was tried and removed. It reports
// transient values while the iOS keyboard animates, and one of those would
// stick: the overlay collapsed to a couple of hundred pixels with the note
// grid showing through underneath, and its scroll area was too short to
// scroll. The stylesheet uses 100dvh instead, which tracks the browser chrome
// without any of that. dvh does not shrink for the keyboard, so a focused
// field near the bottom can still sit behind it — that is the known trade and
// it is far better than a broken overlay.

// With the editor open the page behind it must not scroll at all — otherwise a
// swipe moves the grid, and the note's top ends up somewhere unreachable.
function lockBackgroundScroll(on) {
  document.documentElement.classList.toggle('editor-open', on);
  document.body.classList.toggle('editor-open', on);
}

function openEditor(id) {
  const n = getNote(id);
  if (!n) return;
  editingId = id;
  editorTitle.value = n.title || '';
  editor.style.background = n.color && n.color !== 'default' ? `var(--c-${n.color})` : 'var(--surface)';
  editorPinBtn.classList.toggle('on', !!n.pinned);
  editorArchiveBtn.classList.toggle('on', !!n.archived);

  if (n.type === 'checklist') {
    editorBody.classList.add('hidden');
    editorChecklist.classList.remove('hidden');
    addChecklistItemBtn.classList.remove('hidden');
    renderEditorChecklist(n);
  } else {
    editorBody.classList.remove('hidden');
    editorChecklist.classList.add('hidden');
    addChecklistItemBtn.classList.add('hidden');
    editorBody.value = n.body || '';
  }
  renderEditorLabels(n);
  editorOverlay.classList.remove('hidden');
  lockBackgroundScroll(true);
  editor.scrollTop = 0;   // always begin at the note's title
  // The rows above were built while the overlay was still display:none, where
  // scrollHeight reads 0 and a wrapped item would stay clipped to one line.
  // Now that it has a real size, measure them properly.
  editorChecklist.querySelectorAll('textarea').forEach(autoGrowRow);
  if (n.type === 'text') requestAnimationFrame(autoGrowEditorBody);
  setTimeout(() => (n.title ? editorBody.focus() : editorTitle.focus()), 30);
}

function renderEditorChecklist(n) {
  editorChecklist.innerHTML = '';
  (n.items || []).forEach((item) => {
    const row = document.createElement('div');
    row.className = 'editor-checklist-row' + (item.checked ? ' checked' : '');
    row.dataset.id = item.id;
    row.innerHTML = `
      <svg class="row-drag" viewBox="0 0 24 24"><path d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01"/></svg>
      <button class="chk-toggle"></button>
      <textarea rows="1" placeholder="List item">${escapeHtml(item.text)}</textarea>
      <button class="row-remove"><svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
    `;
    row.querySelector('.chk-toggle').addEventListener('click', () => {
      toggleChecklistItem(n, item.id); touch(n); saveLocal(); renderEditorChecklist(n); render();
    });
    const input = row.querySelector('textarea');
    input.addEventListener('input', () => {
      item.text = input.value; autoGrowRow(input); touch(n); saveLocal();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const idx = n.items.findIndex((i) => i.id === item.id);
        const newItem = { id: uid(), text: '', checked: false };
        n.items.splice(idx + 1, 0, newItem);
        touch(n); saveLocal(); renderEditorChecklist(n); render();
        setTimeout(() => {
          const row2 = editorChecklist.querySelector(`[data-id="${newItem.id}"] textarea`);
          if (row2) row2.focus();
        }, 0);
      } else if (e.key === 'Backspace' && input.value === '') {
        e.preventDefault();
        removeChecklistItem(n, item.id);
        touch(n); saveLocal(); renderEditorChecklist(n); render();
      }
    });
    row.querySelector('.row-remove').addEventListener('click', () => {
      removeChecklistItem(n, item.id); touch(n); saveLocal(); renderEditorChecklist(n); render();
    });
    editorChecklist.appendChild(row);
    autoGrowRow(input);   // now attached, so scrollHeight is meaningful
  });
  if (checklistSortable) checklistSortable.destroy();
  checklistSortable = new Sortable(editorChecklist, {
    handle: '.row-drag', animation: 150,
    onEnd: () => {
      const ids = Array.from(editorChecklist.children).map((el) => el.dataset.id);
      n.items.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      touch(n); saveLocal();
    },
  });
}
addChecklistItemBtn.addEventListener('click', () => {
  const n = getNote(editingId);
  if (!n) return;
  addChecklistItem(n, '');
  touch(n); saveLocal(); renderEditorChecklist(n);
  setTimeout(() => {
    const inputs = editorChecklist.querySelectorAll('input');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }, 0);
});

function renderEditorLabels(n) {
  editorLabels.innerHTML = (n.labels || []).map((id) => {
    const l = DATA.labels.find((x) => x.id === id);
    if (!l) return '';
    return `<span class="editor-label-chip" data-id="${id}">${escapeHtml(l.name)}<button data-remove="${id}"><svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button></span>`;
  }).join('');
  editorLabels.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => { toggleNoteLabel(n.id, btn.dataset.remove); renderEditorLabels(getNote(n.id)); render(); });
  });
}

const commitEditorText = debounce(() => {
  const n = getNote(editingId);
  if (!n) return;
  if (n.type === 'text') { n.title = editorTitle.value; n.body = editorBody.value; }
  else { n.title = editorTitle.value; }
  touch(n); saveLocal(); render();
}, 300);
editorTitle.addEventListener('input', commitEditorText);
editorBody.addEventListener('input', commitEditorText);

function closeEditor() {
  commitEditorText();
  const n = getNote(editingId);
  if (n && n.type === 'text' && !n.title.trim() && !n.body.trim()) deleteForever(n.id);
  else if (n && n.type === 'checklist' && !n.title.trim() && !(n.items || []).some((i) => i.text.trim())) deleteForever(n.id);
  editorOverlay.classList.add('hidden');
  lockBackgroundScroll(false);
  editingId = null;
  render();
}
document.getElementById('editorCloseBtn').addEventListener('click', closeEditor);
editorScrim.addEventListener('click', closeEditor);

document.getElementById('editorUndoBtn').addEventListener('click', undo);
document.getElementById('editorRedoBtn').addEventListener('click', redo);
// The usual keyboard shortcuts, ignored while typing in a field so they do not
// fight the browser's own per-field undo.
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  e.preventDefault();
  if (e.shiftKey) redo(); else undo();
});

editorPinBtn.addEventListener('click', () => { togglePin(editingId); editorPinBtn.classList.toggle('on'); });
editorArchiveBtn.addEventListener('click', () => { archiveNote(editingId); closeEditor(); });
document.getElementById('editorColorBtn').addEventListener('click', (e) => openColorPopover(e.currentTarget, editingId));
document.getElementById('editorLabelBtn').addEventListener('click', (e) => openLabelPopover(e.currentTarget, editingId));
document.getElementById('editorMoreBtn').addEventListener('click', (e) => openMorePopover(e.currentTarget, editingId));

/* ================= Popovers ================= */
// align:'right' lines the popover's right edge up with the anchor's, so it
// opens back across the thing it belongs to instead of trailing away from it.
// Anything anchored to a control at the right-hand end of a row wants this;
// left alignment there leaves the menu sitting diagonally off the item.
function positionPopover(pop, anchor, align) {
  const r = anchor.getBoundingClientRect();
  pop.classList.remove('hidden');
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = Math.min(align === 'right' ? r.right - pw : r.left, window.innerWidth - pw - 12);
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = r.top - ph - 6;
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = Math.max(8, top) + 'px';
}
function hideAllPopovers() {
  document.querySelectorAll('.popover').forEach((p) => p.classList.add('hidden'));
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.popover') && !e.target.closest('[data-act]') && !e.target.closest('.popover-trigger')) {
    hideAllPopovers();
  }
});

const colorPopover = document.getElementById('colorPopover');
const colorGrid = document.getElementById('colorGrid');
let colorTarget = null;
colorGrid.innerHTML = COLORS.map((c) => `<button class="color-swatch" data-key="${c.key}" style="background:${c.key === 'default' ? 'var(--surface)' : `var(--c-${c.key})`}" title="${c.label}"></button>`).join('');
colorGrid.querySelectorAll('.color-swatch').forEach((sw) => {
  sw.addEventListener('click', () => {
    const key = sw.dataset.key;
    if (colorTarget === 'composer') { draft.color = key; composer.style.background = key === 'default' ? 'var(--surface)' : `var(--c-${key})`; }
    else if (colorTarget) {
      setColor(colorTarget, key);
      if (editingId === colorTarget) editor.style.background = key === 'default' ? 'var(--surface)' : `var(--c-${key})`;
    }
    hideAllPopovers();
  });
});
function openColorPopover(anchor, targetId) {
  hideAllPopovers();
  colorTarget = targetId;
  positionPopover(colorPopover, anchor);
}

const morePopover = document.getElementById('morePopover');
const moreConvertBtn = document.getElementById('moreConvertBtn');
let moreTarget = null;
function openMorePopover(anchor, targetId) {
  hideAllPopovers();
  moreTarget = targetId;
  const n = getNote(targetId);
  if (n) moreConvertBtn.textContent = n.type === 'checklist' ? 'Convert to text note' : 'Convert to checklist';
  positionPopover(morePopover, anchor);
}
moreConvertBtn.addEventListener('click', () => {
  hideAllPopovers();
  if (!moreTarget) return;
  convertNoteType(moreTarget);
  render();
  if (editingId === moreTarget) openEditor(moreTarget); // refresh editor fields to match new type
});
document.getElementById('moreDeleteBtn').addEventListener('click', () => {
  hideAllPopovers();
  if (!moreTarget) return;
  trashNote(moreTarget);
  if (editingId === moreTarget) { editorOverlay.classList.add('hidden'); editingId = null; }
});
document.getElementById('moreCopyBtn').addEventListener('click', () => {
  hideAllPopovers();
  const n = getNote(moreTarget);
  if (!n) return;
  const copy = JSON.parse(JSON.stringify(n));
  copy.id = uid(); copy.pinned = false; copy.order = nextOrder(); copy.createdAt = Date.now(); copy.updatedAt = Date.now();
  if (copy.items) copy.items = copy.items.map((i) => ({ ...i, id: uid() }));
  DATA.notes.unshift(copy);
  saveLocal(); render();
});

const labelPopover = document.getElementById('labelPopover');
const labelPopoverList = document.getElementById('labelPopoverList');
const labelPopoverInput = document.getElementById('labelPopoverInput');
let labelTarget = null;
function openLabelPopover(anchor, targetId) {
  hideAllPopovers();
  labelTarget = targetId;
  renderLabelPopoverList();
  positionPopover(labelPopover, anchor);
}
function currentLabelSet() {
  if (labelTarget === 'composer') return draft.labels;
  const n = getNote(labelTarget);
  return n ? (n.labels || []) : [];
}
function toggleLabelOnTarget(labelId) {
  if (labelTarget === 'composer') {
    const i = draft.labels.indexOf(labelId);
    if (i >= 0) draft.labels.splice(i, 1); else draft.labels.push(labelId);
  } else {
    toggleNoteLabel(labelTarget, labelId);
  }
}
function renderLabelPopoverList() {
  const current = currentLabelSet();
  labelPopoverList.innerHTML = DATA.labels.map((l) => {
    const checked = current.includes(l.id);
    return `<div class="label-popover-row ${checked ? 'checked' : ''}" data-id="${l.id}"><span class="chk"></span><span>${escapeHtml(l.name)}</span></div>`;
  }).join('') || '<div style="padding:10px;color:var(--text-dim);font-size:13px;">No labels yet</div>';
  labelPopoverList.querySelectorAll('.label-popover-row').forEach((row) => {
    row.addEventListener('click', () => {
      toggleLabelOnTarget(row.dataset.id);
      renderLabelPopoverList();
      if (editingId === labelTarget) renderEditorLabels(getNote(labelTarget));
      render();
    });
  });
}
document.getElementById('labelPopoverAddBtn').addEventListener('click', addLabelFromPopover);
labelPopoverInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addLabelFromPopover(); });
function addLabelFromPopover() {
  const name = labelPopoverInput.value.trim();
  if (!name) return;
  const label = addLabel(name);
  labelPopoverInput.value = '';
  if (labelTarget) toggleLabelOnTarget(label.id);
  renderLabelPopoverList();
  if (editingId === labelTarget) renderEditorLabels(getNote(labelTarget));
  render();
}

/* ================= Theme ================= */
// Dark unless you have explicitly chosen otherwise with the toggle.
//
// Deliberately a NEW storage key. The previous code called applyTheme() on
// every load and persisted the result — including the automatic default — so
// every existing install already holds a value under 'nk_theme' that is
// indistinguishable from a deliberate choice. Reading that key would pin those
// installs to whatever the OS happened to say the first time the app was ever
// opened, and changing the default here would silently do nothing on exactly
// the devices that matter. The old key is left untouched so rolling this build
// back restores the previous behaviour intact.
const THEME_KEY = 'nk_theme_v2';
const DEFAULT_THEME = 'dark';

const themeBtn = document.getElementById('themeBtn');
// `remember` is only true for an explicit toggle — never for the default.
function applyTheme(t, remember) {
  document.documentElement.setAttribute('data-theme', t);
  if (remember) localStorage.setItem(THEME_KEY, t);
}
themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(cur, true);
});

/* ================= Sync UI ================= */
const syncBtn = document.getElementById('syncBtn');
const syncIcon = document.getElementById('syncIcon');
function setSyncSpinning(on) { syncIcon.style.animation = on ? 'spin .8s linear infinite' : 'none'; }
function setSyncStatus(status) { syncBtn.title = status === 'ok' ? 'Synced with Nextcloud' : 'Offline — changes saved locally'; syncBtn.style.color = status === 'ok' ? '' : 'var(--danger)'; }
syncBtn.addEventListener('click', () => pullFromServer(true));
const styleTag = document.createElement('style');
styleTag.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
document.head.appendChild(styleTag);

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add('hidden'), 3500);
}

/* ================= Init ================= */
let SHELL_STATUS = null;
let SW_ERROR = null;

// Tap the build badge for this. There is no devtools on a phone, and every
// interesting offline failure (worker never registered, registered but not
// controlling, controlling but over an empty cache, blocked by a proxy header)
// looks identical from the outside: "it doesn't open". This prints the
// difference in one screenshottable panel.
async function buildDiagnostics() {
  const L = [];
  const yn = (v) => (v ? 'yes' : 'NO');
  L.push('build       ' + BUILD_ID);
  L.push('stylesheet  ' + (CSS_BUILD || 'unknown') + (cssMismatch() ? '   <-- MISMATCH' : ''));
  L.push('origin      ' + window.location.origin);
  L.push('secure ctx  ' + yn(window.isSecureContext));
  L.push('online      ' + yn(navigator.onLine));
  L.push('standalone  ' + yn(window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true));
  L.push('protocol    ' + window.location.protocol);
  // Which browser/OS this is narrows "no service worker" a lot: private
  // browsing, an old WebKit and a certificate error all present the same way.
  L.push('agent       ' + navigator.userAgent);

  if (!('serviceWorker' in navigator)) {
    L.push('worker      UNAVAILABLE — untrusted TLS cert or private browsing');
  } else {
    L.push('controller  ' + yn(navigator.serviceWorker.controller));
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) L.push('registration NONE');
      else {
        L.push('scope       ' + reg.scope);
        L.push('states      installing=' + yn(reg.installing) + ' waiting=' + yn(reg.waiting) + ' active=' + yn(reg.active));
      }
    } catch (e) { L.push('registration lookup failed: ' + e.message); }
  }
  if (SW_ERROR) L.push('register err ' + SW_ERROR);

  try {
    const keys = await caches.keys();
    L.push('caches      ' + (keys.join(', ') || 'NONE'));
  } catch (e) { L.push('caches      unavailable: ' + e.message); }

  if (SHELL_STATUS) {
    L.push('shell       ' + SHELL_STATUS.have + '/' + SHELL_STATUS.total);
    if (SHELL_STATUS.missing.length) L.push('missing     ' + SHELL_STATUS.missing.join(' '));
  } else {
    L.push('shell       no answer from worker');
  }

  try {
    const d = await NKDB.get('data');
    L.push('notes cached ' + (((d || {}).notes) || []).length);
  } catch (e) { L.push('notes cached read failed: ' + e.message); }

  return L.join('\n');
}

function toggleDiagnostics() {
  let panel = document.getElementById('diagPanel');
  if (panel) { panel.remove(); return; }
  panel = document.createElement('pre');
  panel.id = 'diagPanel';
  panel.className = 'diag-panel';
  panel.textContent = 'collecting…';
  panel.addEventListener('click', () => panel.remove());
  document.body.appendChild(panel);
  buildDiagnostics().then((t) => { panel.textContent = t + '\n\n(tap to close)'; });
}

// Shown at the bottom of the sidebar — behind the drawer on mobile, out of the
// way on desktop. Kept rather than deleted because the build number is the only
// thing that proves a deploy actually landed, and it is the way into the
// diagnostics panel.
// Debug mode is off for everyone by default, and sticky per device once turned
// on: visit <app-url>/#debug to enable, /#debug-off to disable. The hash is
// stripped afterwards so it does not linger in the PWA's start URL. The build
// number also always goes to the console, so it is readable even with the
// stamp hidden.
const DEBUG_KEY = 'nk_debug';
function debugModeEnabled() {
  try {
    const h = (window.location.hash || '').toLowerCase();
    if (h === '#debug') localStorage.setItem(DEBUG_KEY, '1');
    else if (h === '#debug-off') localStorage.removeItem(DEBUG_KEY);
    if (h === '#debug' || h === '#debug-off') {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    return localStorage.getItem(DEBUG_KEY) === '1';
  } catch (e) {
    return false; // private mode with storage denied: just stay hidden
  }
}

function updateBuildStamp() {
  const badge = document.getElementById('buildStamp');
  if (!badge) return;
  badge.classList.toggle('visible', debugModeEnabled());
  // Just the build number. It is the one thing worth reading at a glance —
  // proof that a deploy landed — and it is the only reason this line exists.
  // Worker state and shell counts moved into the diagnostics panel behind a
  // tap: useful when something is wrong, jargon the rest of the time. The
  // case that must not be missed, offline being impossible at all, already
  // announces itself in a banner.
  badge.textContent = 'Build ' + BUILD_ID;
}

// Ask the worker to top up the shell cache and tell us what it holds.
function checkShellCache() {
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!sw) return;
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => {
    SHELL_STATUS = e.data;
    if (e.data && e.data.missing && e.data.missing.length) {
      console.warn('[nk] shell cache incomplete, missing:', e.data.missing);
    }
  };
  try { sw.postMessage({ type: 'shell-check' }, [ch.port2]); } catch (e) { /* ignore */ }
}

// The failure modes the app cannot fix for itself. In both of these the browser
// refuses to give us a service worker, so offline can never work no matter what
// the code does — say why, loudly, instead of leaving it as three small words
// in the corner badge.
function offlineBlocker() {
  if (!window.isSecureContext) return 'insecure';
  // An https:// origin that still has no navigator.serviceWorker is almost
  // always a certificate the browser does not trust: service workers are
  // disabled on any origin with a TLS error, and clicking through the warning
  // does not re-enable them. (Private browsing is the other cause.)
  if (!('serviceWorker' in navigator)) {
    return window.location.protocol === 'https:' ? 'untrusted-cert' : 'no-sw';
  }
  return null;
}

function warnIfOfflineImpossible() {
  const why = offlineBlocker();
  if (!why) return;
  const origin = escapeHtml(window.location.origin);
  const msg = {
    insecure: 'Offline mode is unavailable: this app was opened over an insecure connection ('
      + origin + '), and browsers only allow offline caching on HTTPS. Open your HTTPS address '
      + 'instead, then re-add it to your home screen.',
    'untrusted-cert': 'Offline mode is unavailable: the browser is not exposing service workers on '
      + origin + '. That almost always means the TLS certificate is not trusted — browsers disable '
      + 'service workers on any origin with a certificate warning, and continuing past the warning '
      + 'does not re-enable them. Install a certificate your device trusts for this hostname (or '
      + 'check you are not in a private browsing window).',
    'no-sw': 'Offline mode is unavailable: this browser does not support service workers.',
  }[why];
  const bar = document.createElement('div');
  bar.className = 'insecure-banner';
  bar.textContent = msg;
  document.body.appendChild(bar);
}

// Registered before anything else, and deliberately independent of everything
// else. This used to sit at the end of init(), which meant a single throw
// anywhere above it — a DOM id that moved between a deploy's index.html and its
// app.js, a bad cached note, one unguarded lookup — silently cost the app its
// service worker, and with it the cache and the ability to open away from home.
// Nothing on screen said so, and the app looked fine until you were somewhere
// with no route to the server. Touches no DOM and no network, so there is
// nothing here for the rest of the app to break.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    navigator.serviceWorker.register('/sw.js')
      // Swallowing this was hiding the most useful sentence available: a proxy
      // CSP, a bad MIME type on sw.js or a scope violation all land here.
      .catch((e) => { SW_ERROR = (e && e.message) || String(e); });
    navigator.serviceWorker.addEventListener('controllerchange', checkShellCache);
    // "pending" resolves to "offline-ready" shortly after first install
    setTimeout(checkShellCache, 3000);
    checkShellCache();
  } catch (e) {
    SW_ERROR = (e && e.message) || String(e);
  }
}

async function init() {
  registerServiceWorker();

  updateBuildStamp();
  applyTheme(localStorage.getItem(THEME_KEY) || DEFAULT_THEME, false);
  resetComposer();

  try {
    const cachedData = await NKDB.get('data');
    const cachedVersion = await NKDB.get('version');
    const cachedDirty = await NKDB.get('dirty');
    if (cachedData) DATA = cachedData;
    if (cachedVersion) SERVER_VERSION = cachedVersion;
    // Restore it BEFORE the first pull, or that pull discards whatever went
    // unsynced last session.
    DIRTY = cachedDirty === true;
  } catch (e) {
    console.warn('Local cache read failed, starting fresh from Nextcloud:', e);
  }
  purgeOldTrash();
  BASELINE = serialize();   // first edit undoes back to what we launched with
  render();

  // Cosmetic wiring — isolated so it can never take anything else down.
  try {
    warnIfOfflineImpossible();
    const stamp = document.getElementById('buildStamp');
    if (stamp) stamp.addEventListener('click', toggleDiagnostics);
  } catch (e) {
    console.warn('Non-fatal UI wiring failed:', e);
  }

  // These must be wired up BEFORE the first network round-trip: off the home
  // network the server is unreachable and those requests hang until they time
  // out, and anything awaited after them would not happen for that whole
  // window.
  setInterval(() => { if (document.visibilityState === 'visible') pullFromServer(false); }, 20000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pullFromServer(false); });
  window.addEventListener('online', () => pullFromServer(false));

  await pingServer();
  await pullFromServer(true);
}
init();
