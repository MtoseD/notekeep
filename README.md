# NoteKeep

A self-hosted, Google Keep–style notes app. Pin notes, color them, turn them
into checklists, archive/trash them, drag-reorder them in a masonry grid —
and it's all yours: no Google account, no telemetry, no third-party servers.
Your notes live in **your own Nextcloud** as a plain JSON file.

## How it works

```
Your phone/laptop  ──HTTPS──►  NoteKeep server (small Node app)  ──WebDAV──►  Your Nextcloud
     (PWA, installable)              runs on your home server           (stores NoteKeep/data.json)
```

- The **frontend** is a Progressive Web App (installable on iOS, Android,
  Windows, macOS, Linux — add it to your home screen / dock like a native app).
  It caches everything locally (IndexedDB) so it works offline and loads instantly.
- The **backend** is a tiny Node/Express server. It holds your Nextcloud
  app-password once, server-side, and proxies note reads/writes to a WebDAV
  folder. This avoids Nextcloud's CORS restrictions and means no device ever
  stores your Nextcloud credentials.
- All your devices point at this one NoteKeep server's URL. Edit on your
  phone, it's on your laptop within ~20 seconds (or instantly if you tap the
  sync icon).

## 1. Get a Nextcloud app password

In Nextcloud: **Settings → Security → Devices & sessions → Create new app
password**. Copy it — you won't see it again.

## 2. Configure

```bash
cd notekeep
cp .env.example .env
```

Edit `.env`:

```
NEXTCLOUD_URL=https://cloud.yourdomain.com
NEXTCLOUD_USERNAME=yourname
NEXTCLOUD_APP_PASSWORD=xxxxx-xxxxx-xxxxx-xxxxx-xxxxx
NOTES_FOLDER=NoteKeep
PORT=3077
APP_TOKEN=
```

`NOTES_FOLDER` is created automatically in your Nextcloud if it doesn't exist.

`APP_TOKEN` is optional. If you expose NoteKeep beyond your home network
(see below), set it to a long random string — the app will then ask each
device for that token once and remember it. On a trusted LAN-only setup you
can leave it blank.

## 3. Run it

```bash
npm install
npm start
```

Visit `http://<your-server-ip>:3077` from any device on your network.

**Keep it running permanently** with a process manager, e.g.:

```bash
npm install -g pm2
pm2 start server.js --name notekeep
pm2 save
pm2 startup
```

Or with Docker — a minimal `Dockerfile` you can add:

```Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3077
CMD ["node", "server.js"]
```

## 4. Install it on your devices

Open the NoteKeep URL in a browser, then:
- **iOS Safari**: Share → Add to Home Screen
- **Android Chrome**: menu → Install app
- **macOS/Windows/Linux (Chrome/Edge)**: address bar → install icon
- **Firefox**: works as a regular tab; installable support varies by platform

Each install talks to the same NoteKeep server, so every device sees the
same notes.

## 5. Access from outside your home network (optional)

If you already have Nextcloud reachable over the internet (via a reverse
proxy like nginx/Caddy or something like Tailscale/WireGuard), put NoteKeep
behind the same reverse proxy on its own subdomain, e.g. `notes.yourdomain.com`,
proxying to `localhost:3077`. Use HTTPS (Let's Encrypt) and set `APP_TOKEN`
in that case, since the app is then reachable from the open internet.
Tailscale is the easiest option if you don't want to expose anything publicly
at all — install it on your server and your devices, and use the Tailscale
hostname instead of a public domain.

## Data format

Everything lives in one file: `<NOTES_FOLDER>/data.json` in your Nextcloud,
plain JSON, human-readable, easy to back up (Nextcloud already versions and
backs it up like any other file) or inspect/migrate later:

```json
{
  "notes": [
    {
      "id": "...", "type": "text | checklist", "title": "...", "body": "...",
      "items": [{ "id": "...", "text": "...", "checked": false }],
      "color": "default | coral | peach | ...", "pinned": false,
      "archived": false, "trashed": false, "labels": ["labelId"],
      "order": 10, "createdAt": 0, "updatedAt": 0
    }
  ],
  "labels": [{ "id": "...", "name": "..." }]
}
```

## Notes on sync behavior

- Local edits save instantly to the device (IndexedDB) and are pushed to
  Nextcloud ~1.2 seconds after you stop typing.
  device.
- The app pulls fresh data every 20 seconds while open, plus immediately on
  opening, on reconnecting to the network, and when you tap the sync icon.
- If two devices edit while offline from each other, NoteKeep merges by
  note: whichever copy of a given note was edited most recently wins, rather
  than one whole device's changes overwriting the other's.
- Trash is auto-purged after 7 days, same as Google Keep.

## What's intentionally not included

- No reminders/notifications, no image attachments, no collaborators —
  kept this scoped to what you asked for. The data format above is simple
  enough to extend later if you want any of that.

## Trying it locally first

Even without Nextcloud, you can sanity-check the UI: point `.env` at any
WebDAV server you have (or skip real sync and just poke around — the app
will show "offline" but stays fully usable, since everything also lives in
local IndexedDB).
