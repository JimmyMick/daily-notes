# Daily Notes 📓

A small, self-hosted app for keeping **one markdown note per day** in the browser, backed by **MongoDB**.

- **Backend:** Node + Express
- **Editor:** EasyMDE (markdown with live preview), vanilla JS — no frontend build step
- **Store:** MongoDB (one document per day, full-text search via a text index)

## Features

- One document per day, keyed by `YYYY-MM-DD`
- **Jump to any date** with the date picker
- **Search** across all note content (MongoDB text index)
- **Summarize** a note with a local **Ollama** model (✨ button)
- Autosave as you type (debounced)
- A sidebar list of every day that has a note

## Summarize with Ollama

The ✨ Summarize button sends the current note to a local [Ollama](https://ollama.com)
model and shows a bullet-point summary. Ollama runs on the **host**; the container
reaches it via `host.docker.internal` (wired up in `docker-compose.yml`).

Default model is `qwen2.5:7b-instruct` — a good speed/quality balance for notes.
Pull it once with `ollama pull qwen2.5:7b-instruct`. Swap models with the
`OLLAMA_MODEL` env var (e.g. a larger model for deeper summaries).

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
| `POST` | `/api/summarize` | Summarize content via Ollama (`{ "content": "…", "model"?: "…" }`) |

## Config

| Env var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | App port |
| `MONGO_URI` | `mongodb://localhost:27017` | Compose sets this to `mongodb://mongo:27017` |
| `DB_NAME` | `daily_notes` | Database name |
| `OLLAMA_URL` | `http://localhost:11434` | Compose sets this to `http://host.docker.internal:11434` |
| `OLLAMA_MODEL` | `qwen2.5:7b-instruct` | Default summarization model |
