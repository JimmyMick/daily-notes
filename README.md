# Daily Notes 📓

A small, self-hosted app for keeping **one markdown note per day** in the browser, backed by **MongoDB**.

- **Backend:** Node + Express
- **Editor:** EasyMDE (markdown with live preview), vanilla JS — no frontend build step
- **Store:** MongoDB (one document per day, full-text search via a text index)

## Features

- One document per day, keyed by `YYYY-MM-DD`
- **Jump to any date** with the date picker
- **Search** across all note content (MongoDB text index)
- Autosave as you type (debounced)
- A sidebar list of every day that has a note

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

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/notes` | List all dates that have a note (newest first) |
| `GET` | `/api/notes/:date` | Fetch a day's note (empty if none yet) |
| `PUT` | `/api/notes/:date` | Create/update a day's note (`{ "content": "…" }`) |
| `GET` | `/api/search?q=…` | Full-text search, returns date + snippet |

## Config

| Env var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | App port |
| `MONGO_URI` | `mongodb://localhost:27017` | Compose sets this to `mongodb://mongo:27017` |
| `DB_NAME` | `daily_notes` | Database name |
