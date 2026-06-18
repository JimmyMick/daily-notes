# Daily Notes 📓

A small, self-hosted app for keeping **one markdown note per day** in the browser, backed by **MongoDB**.

- **Backend:** Node + Express
- **Editor:** EasyMDE (markdown with live preview, **GFM tables** via marked), vanilla JS — no frontend build step
- **Store:** MongoDB (one document per day, full-text search via a text index)

## Features

- One document per day, keyed by `YYYY-MM-DD`
- **Reference notes** — named, evergreen notes that aren't tied to a date
- **Image uploads** — paste, drag-and-drop, or upload screenshots into notes
- **Jump to any date** with the date picker
- **Search** across all note content (MongoDB text index)
- **Summarize** a note with a local **Ollama** model (✨ button)
- **Email a note** (daily or reference) via Gmail (✉ button)
- **Insert a timestamp** anchor with the 🕒 toolbar button (time-tag diary entries)
- **News ticker** — scrolling headlines from NPR, BBC, NRK, and ESPN along the bottom
- **Scores ticker** — a second line with live/final sports scores (ESPN)
- Autosave as you type (debounced)
- A sidebar list of every day that has a note

## Summarize with Ollama

The ✨ Summarize button sends the current note to a local [Ollama](https://ollama.com)
model and shows a bullet-point summary. Ollama runs on the **host**; the container
reaches it via `host.docker.internal` (wired up in `docker-compose.yml`).

Default model is `qwen2.5:7b-instruct` — a good speed/quality balance for notes.
Pull it once with `ollama pull qwen2.5:7b-instruct`. Pick any installed model
from the dropdown per summary, or change the default with `OLLAMA_MODEL`.

Summaries **stream token-by-token** as the model generates them, so larger
models stay responsive. Use **Insert into note** to append a summary under a
`## Summary` heading. (A first call on a cold model pauses while Ollama loads
it into memory, then streams.)

## Reference notes

Daily notes are one-per-day. **Reference notes** are the other kind: named,
evergreen pages that don't belong to any date — things like *Wifi passwords*,
*Book list*, or *Gift ideas*. They live in the **Reference notes** section of
the sidebar, below the daily list.

- **+ New** prompts for a title and drops you into the editor.
- They share the same markdown editor and autosave as daily notes.
- The header swaps the **🗄 Archive** button for **✎ Rename** and **🗑 Delete**
  while a reference note is open.
- **Rename** changes only the display title. Each note keeps a fixed `slug`
  (derived from its first title), so renaming never breaks its backup file or
  links to it. **Delete** is permanent and asks for confirmation first.

Reference notes are stored in their own `references` collection and are
included in [backups](#backup--restore) (under `backups/references/`). They are
not yet wired into the top search box — that searches daily notes only.

## Email a note

The ✉ **Email** button sends the note currently open — daily *or* reference —
to a recipient via **Gmail**. The markdown is **rendered to styled HTML**
(headings, lists, code, blockquotes, and **tables** — via [marked](https://marked.js.org)),
with the raw markdown included as the plain-text fallback. Tables get inline
border styles so they render even in stricter mail clients. The subject is
`Daily note — YYYY-MM-DD` or `Reference note — <title>`.

Clicking ✉ flushes any pending edit, then prompts for the recipient (prefilled
with your default — see Settings). You can enter a comma-separated list to send
to several people at once.

### Setup (one-time)

Gmail blocks plain password logins, so this uses an **App Password** over SMTP
(no OAuth flow):

1. Enable **2-Step Verification** on the Google account.
2. Create an App Password at <https://myaccount.google.com/apppasswords>.
3. Put the credentials in a `.env` file next to `docker-compose.yml` (it's
   gitignored — see `.env.example`):

   ```bash
   GMAIL_USER=you@gmail.com
   GMAIL_APP_PASSWORD=abcd efgh ijkl mnop   # spaces are fine; stripped on load
   ```

4. `docker compose up --build` (or restart) to pick up the variables.

Until both are set, the ✉ button reports that email isn't configured and sends
nothing. Mail is sent **from** `GMAIL_USER`. Set a default recipient in the
**Settings** panel (it defaults to your own address, so you can mail notes to
yourself).

## Images

You can drop images (screenshots, photos) straight into a note three ways:

- **Paste** from the clipboard (e.g. a screenshot) into the editor
- **Drag and drop** an image file onto the editor
- The **upload-image** toolbar button

Each upload is stored in MongoDB (an `images` collection) and inserted as a
markdown image — `![](/api/images/<id>)` — so it renders in the preview and the
note stays small. Limits: image types only, up to **10 MB** each. Served with a
long cache lifetime (ids are stable).

Images are included in [backups](#backup--restore) (under `backups/images/`) and
embedded inline when a note is [emailed](#email-a-note), so screenshots render in
the recipient's inbox.

## News ticker

A scrolling **headline ticker** runs along the bottom of the window. It ships
with **NPR**, **NRK** (Norwegian), and **ESPN**, but the source list is fully
editable. Each headline is clickable (opens the article in a new tab), and
hovering the ticker pauses it so you can read or click.

- Headlines refresh every 5 minutes; the server caches each feed (5-min TTL) so
  client polling doesn't hammer the sources.
- **Headlines per source** is configurable in **Settings** (1–20, default **3**).
- **News sources** is an editable list in **Settings** — one per line as
  `Name | https://feed-url` (the name is optional; a bare URL works and the name
  is derived from the feed's own title or hostname). Up to 12 sources.

### Adding your own sources

Almost any news site publishes a standard **RSS or Atom** feed, and those work
out of the box — just paste the feed URL. Examples: BBC
(`https://feeds.bbci.co.uk/news/world/rss.xml`), The Guardian
(`https://www.theguardian.com/world/rss`), Hacker News
(`https://hnrss.org/frontpage`).

The one exception is **ESPN**, whose RSS is defunct — its headlines come from
ESPN's JSON "now" news API, which `news.js` recognizes by URL. Other proprietary
JSON APIs won't parse; stick to RSS/Atom feeds for anything you add.

### Scores ticker

A second ticker line below the news shows the **latest sports scores** from
ESPN's public scoreboard API — **live games first** (with a red dot), then
finals, then today's upcoming games. It covers NFL, MLB, NBA, NHL, and the World
Cup, and refreshes every minute. Each game links to its ESPN page; hovering
pauses the line. Offseason leagues simply contribute nothing. The leagues are
defined in `scores.js` (ESPN's scoreboard is JSON, not a generic feed, so this
list isn't user-editable like the news sources).

## Run it

```bash
docker compose up --build
```

Then open **http://localhost:3000**.

Mongo data persists in the `mongo_data` Docker volume across restarts.

## Local dev (without Docker)

Needs a MongoDB on `localhost:27017` (or set `MONGO_URI`).

```bash
npm install
npm run dev        # node --watch
```

## Backup & restore

Notes export to plain **markdown files** (one per day) so your journal is
recoverable even without Mongo. The folder is mounted to the host at
`daily-notes/backups/`.

```bash
docker compose exec app npm run backup    # export all notes -> backups/YYYY-MM-DD.md
docker compose exec app npm run restore   # import backups/*.md back into Mongo (upsert)
```

Each file has a small frontmatter block (`date`, `archived`, `createdAt`,
`updatedAt`) followed by the markdown body, so restore round-trips the archived
state too. `restore` upserts by date, so it's safe to re-run and only touches
the dates present in the folder.

**Reference notes** are backed up alongside daily notes, under
`backups/references/<slug>.md` (frontmatter: `slug`, `title`, `createdAt`,
`updatedAt`). `restore` upserts them by `slug`.

**Uploaded images** are backed up under `backups/images/` — each binary as
`<id>.<ext>` plus an `index.json` carrying their ids and content types. `restore`
re-imports them upsert-by-id, so the original `![](/api/images/<id>)` links in
your notes keep resolving after a restore.

A **daily backup runs automatically** while the app is up (default 2am local).
Configure it in the **Settings** panel (⚙) or via env vars.

The markdown files are also nice to read or grep directly.

## Settings

Click **⚙** in the header for an in-app Settings panel:

- **Default summary model** — which Ollama model the ✨ button uses by default
- **Daily backup** — on/off
- **Backup time** — hour of day (local time)
- **Last backup** — when the most recent backup ran (absolute time + relative hint)
- **Back up now** — run a backup immediately
- **Email notes to** — default recipient for the ✉ button
- **Headlines per source** — how many headlines each news source contributes to the ticker (1–20)
- **News sources** — the editable feed list (`Name | URL` per line, RSS/Atom)

Settings persist in MongoDB (a `settings` collection) and the env vars below
just seed the first-run defaults. The backup *folder* is the Docker volume
mount (`./backups`), changed in `docker-compose.yml` — not in the UI, since the
container can only write to paths mounted into it.

## Data model

Collection `notes`:

```json
{
  "date": "2026-06-17",
  "content": "# Today\n\n- did things",
  "createdAt": "2026-06-17T14:00:00.000Z",
  "updatedAt": "2026-06-17T15:30:00.000Z"
}
```

- Unique index on `date` → one note per day
- Text index on `content` → search

Collection `references` (one per named, evergreen note):

```json
{
  "slug": "wifi-passwords",
  "title": "Wifi Passwords",
  "content": "# Guest network\n\n- …",
  "createdAt": "2026-06-17T14:00:00.000Z",
  "updatedAt": "2026-06-17T15:30:00.000Z"
}
```

- Unique index on `slug` → one note per slug (immutable; title is renameable)
- Text index on `title` + `content`

Collection `images` (uploaded image binaries):

```json
{
  "_id": "ObjectId",
  "contentType": "image/png",
  "size": 12345,
  "filename": "screenshot.png",
  "data": "<binary>",
  "createdAt": "2026-06-17T14:00:00.000Z"
}
```

- Served at `/api/images/<_id>`; referenced from notes as `![](/api/images/<_id>)`

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/notes` | List all dates that have a note (newest first) |
| `GET` | `/api/notes/:date` | Fetch a day's note (empty if none yet) |
| `PUT` | `/api/notes/:date` | Create/update a day's note (`{ "content": "…" }`) |
| `GET` | `/api/search?q=…` | Full-text search, returns date + snippet |
| `POST` | `/api/summarize` | Summarize content via Ollama (`{ "content": "…", "model"?: "…" }`) |
| `GET` | `/api/email/status` | Whether Gmail is configured + the default recipient |
| `POST` | `/api/email` | Email a note (`{ "kind": "daily"\|"reference", "id": "…", "to": "…" }`) |
| `GET` | `/api/news` | Latest ticker headlines (configurable sources), limited per source |
| `GET` | `/api/scores` | Latest sports scores for the scores ticker (ESPN) |
| `POST` | `/api/images` | Upload an image (multipart field `image`), returns `{ url }` |
| `GET` | `/api/images/:id` | Serve an uploaded image by id |
| `GET` | `/api/references` | List reference notes (alphabetical by title) |
| `POST` | `/api/references` | Create a reference note (`{ "title": "…" }`), returns its `slug` |
| `GET` | `/api/references/:slug` | Fetch a reference note |
| `PUT` | `/api/references/:slug` | Update content and/or title (`{ "content"?: "…", "title"?: "…" }`) |
| `DELETE` | `/api/references/:slug` | Delete a reference note (permanent) |

## Config

| Env var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | App port |
| `MONGO_URI` | `mongodb://localhost:27017` | Compose sets this to `mongodb://mongo:27017` |
| `DB_NAME` | `daily_notes` | Database name |
| `OLLAMA_URL` | `http://localhost:11434` | Compose sets this to `http://host.docker.internal:11434` |
| `OLLAMA_MODEL` | `qwen2.5:7b-instruct` | Default summarization model |
| `BACKUP_DIR` | `/backups` | Where markdown backups are written (mounted to `./backups`) |
| `BACKUP_SCHEDULE` | `on` | Seeds the daily-backup on/off default (`on`/`off`) |
| `BACKUP_HOUR` | `2` | Seeds the daily-backup hour (0–23, local time) |
| `GMAIL_USER` | _(unset)_ | Gmail address mail is sent **from**; also seeds the default recipient |
| `GMAIL_APP_PASSWORD` | _(unset)_ | Gmail [App Password](https://myaccount.google.com/apppasswords) (spaces stripped) |
| `SMTP_HOST` | `smtp.gmail.com` | SMTP host (override only for non-Gmail SMTP) |
| `SMTP_PORT` | `465` | SMTP port (`465` implicit TLS, `587` STARTTLS) |
| `NEWS_COUNT` | `3` | Seeds the headlines-per-source default for the ticker (1–20) |

Env vars seed first-run defaults; the Settings panel persists overrides in
MongoDB. The Gmail **secret** (`GMAIL_APP_PASSWORD`) lives only in env / `.env`,
never in the database or UI.
