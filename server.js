'use strict';

const path = require('path');
const express = require('express');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'daily_notes';
// Ollama runs on the host; from inside the container reach it via host.docker.internal.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct';

// Matches YYYY-MM-DD. One document per day, keyed by this string.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let notes; // collection handle, set on startup

// List all dates that have a note (newest first) — powers the date sidebar.
app.get('/api/notes', async (req, res, next) => {
  try {
    const docs = await notes
      .find({}, { projection: { _id: 0, date: 1, updatedAt: 1 } })
      .sort({ date: -1 })
      .toArray();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// Full-text search across note content.
app.get('/api/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const docs = await notes
      .find(
        { $text: { $search: q } },
        { projection: { _id: 0, date: 1, content: 1, score: { $meta: 'textScore' } } }
      )
      .sort({ score: { $meta: 'textScore' } })
      .limit(50)
      .toArray();
    // Attach a short snippet around the first match for display.
    const results = docs.map((d) => ({
      date: d.date,
      score: d.score,
      snippet: makeSnippet(d.content, q),
    }));
    res.json(results);
  } catch (err) {
    next(err);
  }
});

// Summarize note content via local Ollama. Body: { content, model? }.
app.post('/api/summarize', async (req, res, next) => {
  try {
    const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
    const model = (req.body.model || OLLAMA_MODEL).trim();
    if (!content) return res.status(400).json({ error: 'nothing to summarize' });

    const prompt =
      'Summarize the following daily notes into a few concise bullet points. ' +
      'Capture key tasks, decisions, and takeaways. Use markdown bullets. ' +
      'Do not add anything that is not in the notes.\n\n---\n' + content;

    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return res.status(502).json({ error: `Ollama error (${r.status})`, detail });
    }
    const data = await r.json();
    res.json({ summary: (data.response || '').trim(), model });
  } catch (err) {
    if (err.cause && err.cause.code === 'ECONNREFUSED') {
      return res.status(502).json({ error: `Cannot reach Ollama at ${OLLAMA_URL}` });
    }
    next(err);
  }
});

// Fetch a single day's note. Returns empty content if none exists yet.
app.get('/api/notes/:date', async (req, res, next) => {
  try {
    const { date } = req.params;
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const doc = await notes.findOne({ date }, { projection: { _id: 0 } });
    res.json(doc || { date, content: '', updatedAt: null });
  } catch (err) {
    next(err);
  }
});

// Create or update a day's note.
app.put('/api/notes/:date', async (req, res, next) => {
  try {
    const { date } = req.params;
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const content = typeof req.body.content === 'string' ? req.body.content : '';
    const updatedAt = new Date();
    await notes.updateOne(
      { date },
      { $set: { content, updatedAt }, $setOnInsert: { date, createdAt: updatedAt } },
      { upsert: true }
    );
    res.json({ date, content, updatedAt });
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

function makeSnippet(content, q) {
  if (!content) return '';
  const term = q.replace(/[".]/g, '').split(/\s+/)[0] || '';
  const idx = term ? content.toLowerCase().indexOf(term.toLowerCase()) : -1;
  if (idx === -1) return content.slice(0, 160) + (content.length > 160 ? '…' : '');
  const start = Math.max(0, idx - 60);
  const end = Math.min(content.length, idx + 100);
  return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
}

async function start() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  notes = db.collection('notes');
  // One note per day.
  await notes.createIndex({ date: 1 }, { unique: true });
  // Full-text search over content.
  await notes.createIndex({ content: 'text' });
  app.listen(PORT, () => console.log(`daily-notes listening on :${PORT}`));
}

start().catch((err) => {
  console.error('failed to start', err);
  process.exit(1);
});
