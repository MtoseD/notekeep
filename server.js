// NoteKeep server
// Serves the PWA frontend and proxies note data to a Nextcloud WebDAV folder.
// All Nextcloud credentials stay on the server — the browser never talks to
// Nextcloud directly, which sidesteps CORS entirely and keeps the app
// password off every device.

require('dotenv').config();
const express = require('express');
const { createClient } = require('webdav');
const path = require('path');

const PORT = process.env.PORT || 3077;
const NC_URL = process.env.NEXTCLOUD_URL;
const NC_USER = process.env.NEXTCLOUD_USERNAME;
const NC_PASS = process.env.NEXTCLOUD_APP_PASSWORD;
const NOTES_DIR = (process.env.NOTES_FOLDER || 'NoteKeep').replace(/^\/+|\/+$/g, '');
const DATA_FILE = `${NOTES_DIR}/data.json`;
// Optional shared secret so randoms on your network can't read/write your notes.
const APP_TOKEN = process.env.APP_TOKEN || '';

if (!NC_URL || !NC_USER || !NC_PASS) {
  console.error('Missing Nextcloud config. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const webdavBase = NC_URL.replace(/\/+$/, '') + '/remote.php/dav/files/' + encodeURIComponent(NC_USER);
const client = createClient(webdavBase, { username: NC_USER, password: NC_PASS });

const app = express();
app.use(express.json({ limit: '10mb' }));

// --- simple auth gate (optional, only active if APP_TOKEN is set) ---
// Scoped to /api/* only: the app shell (HTML/JS/CSS/icons) must stay
// reachable without the token, since the browser's own navigation and the
// service worker's precache requests can't attach custom headers. The
// token protects your notes data at the API layer, which is what matters.
app.use('/api', (req, res, next) => {
  if (!APP_TOKEN) return next();
  if (req.path === '/ping') return next();
  const header = req.get('x-app-token');
  if (header === APP_TOKEN) return next();
  res.status(401).json({ error: 'unauthorized' });
});

app.get('/api/ping', (req, res) => res.json({ ok: true, tokenRequired: !!APP_TOKEN }));

async function ensureRemoteDir() {
  const exists = await client.exists('/' + NOTES_DIR);
  if (!exists) await client.createDirectory('/' + NOTES_DIR, { recursive: true });
}

const EMPTY_DATA = { notes: [], labels: [], updatedAt: 0 };

// GET current data + a version stamp (etag/last-modified) the client can
// compare against before pushing changes, to avoid clobbering another
// device's fresher save.
app.get('/api/data', async (req, res) => {
  try {
    await ensureRemoteDir();
    const exists = await client.exists('/' + DATA_FILE);
    if (!exists) {
      return res.json({ data: EMPTY_DATA, version: null });
    }
    const stat = await client.stat('/' + DATA_FILE);
    const content = await client.getFileContents('/' + DATA_FILE, { format: 'text' });
    let data;
    try {
      data = JSON.parse(content);
    } catch (e) {
      data = EMPTY_DATA;
    }
    const version = (stat.etag || stat.lastmod || String(stat.size)) + '';
    res.json({ data, version });
  } catch (err) {
    console.error('GET /api/data failed:', err.message);
    res.status(502).json({ error: 'nextcloud_unreachable', detail: err.message });
  }
});

// PUT full data blob. Client sends the version it started editing from;
// if the remote has moved on, we tell it instead of silently overwriting.
app.put('/api/data', async (req, res) => {
  const { data, baseVersion, force } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'invalid_payload' });
  }
  try {
    await ensureRemoteDir();
    const exists = await client.exists('/' + DATA_FILE);
    if (exists && !force) {
      const stat = await client.stat('/' + DATA_FILE);
      const currentVersion = (stat.etag || stat.lastmod || String(stat.size)) + '';
      if (baseVersion && currentVersion !== baseVersion) {
        const remoteContent = await client.getFileContents('/' + DATA_FILE, { format: 'text' });
        let remoteData;
        try { remoteData = JSON.parse(remoteContent); } catch (e) { remoteData = EMPTY_DATA; }
        return res.status(409).json({ error: 'conflict', remote: remoteData, version: currentVersion });
      }
    }
    const payload = JSON.stringify({ ...data, updatedAt: Date.now() }, null, 2);
    await client.putFileContents('/' + DATA_FILE, payload, { overwrite: true });
    const stat = await client.stat('/' + DATA_FILE);
    const version = (stat.etag || stat.lastmod || String(stat.size)) + '';
    res.json({ ok: true, version });
  } catch (err) {
    console.error('PUT /api/data failed:', err.message);
    res.status(502).json({ error: 'nextcloud_unreachable', detail: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`NoteKeep running on http://localhost:${PORT}`);
  console.log(`Nextcloud folder: ${NOTES_DIR}  (as user ${NC_USER})`);
  if (APP_TOKEN) console.log('App token protection: ON');
});
