'use strict';

const path = require('path');
const express = require('express');
const { MongoClient } = require('mongodb');
const { runBackup } = require('./backup');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'daily_notes';
// Ollama runs on the host; from inside the container reach it via host.docker.internal.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct';
// Scheduled daily backup. Disable with BACKUP_SCHEDULE=off; set the hour (0-23
// local time) with BACKUP_HOUR (default 2am).
const BACKUP_SCHEDULE = (process.env.BACKUP_SCHEDULE || 'on').toLowerCase();
const BACKUP_HOUR = Math.min(23, Math.max(0, parseInt(process.env.BACKUP_HOUR || '2', 10) || 0));

// Matches YYYY-MM-DD. One document per day, keyed by this string.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let notes; // collection handle, set on startup
let references; // reference-notes collection handle (named, not dated)
let settingsCol; // settings collection handle
// Runtime settings, seeded from env, overridable via the Settings panel.
let settings = {
  backupSchedule: BACKUP_SCHEDULE, // 'on' | 'off'
  backupHour: BACKUP_HOUR, // 0-23
  defaultModel: OLLAMA_MODEL,
};

// List dates that have a note (newest first) — powers the date sidebar.
// ?archived=true lists archived notes instead of active ones.
app.get('/api/notes', async (req, res, next) => {
  try {
    const wantArchived = req.query.archived === 'true';
    const filter = wantArchived ? { archived: true } : { archived: { $ne: true } };
    const docs = await notes
      .find(filter, { projection: { _id: 0, date: 1, updatedAt: 1, archived: 1 } })
      .sort({ date: -1 })
      .toArray();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// Full-text search across note content. Archived notes are excluded.
app.get('/api/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const docs = await notes
      .find(
        { $text: { $search: q }, archived: { $ne: true } },
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

// Read current runtime settings.
app.get('/api/settings', (req, res) => res.json(settings));

// Update runtime settings (schedule, hour, default model). Persists + applies.
app.put('/api/settings', async (req, res, next) => {
  try {
    const next_ = { ...settings };
    if (req.body.backupSchedule === 'on' || req.body.backupSchedule === 'off') {
      next_.backupSchedule = req.body.backupSchedule;
    }
    if (req.body.backupHour !== undefined) {
      const h = parseInt(req.body.backupHour, 10);
      if (Number.isNaN(h) || h < 0 || h > 23) return res.status(400).json({ error: 'backupHour must be 0-23' });
      next_.backupHour = h;
    }
    if (typeof req.body.defaultModel === 'string' && req.body.defaultModel.trim()) {
      next_.defaultModel = req.body.defaultModel.trim();
    }
    settings = next_;
    await settingsCol.updateOne({ _id: 'app' }, { $set: settings }, { upsert: true });
    rescheduleBackup(); // apply schedule changes immediately
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

// Trigger a backup on demand (also used by the scheduled job).
app.post('/api/backup', async (req, res, next) => {
  try {
    const count = await performBackup();
    res.json({ ok: true, count });
  } catch (err) {
    next(err);
  }
});

// List models available from the local Ollama install (for the UI dropdown).
app.get('/api/models', async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!r.ok) return res.json({ models: [], default: OLLAMA_MODEL });
    const data = await r.json();
    const models = (data.models || []).map((m) => m.name).sort();
    res.json({ models, default: settings.defaultModel });
  } catch (err) {
    // Ollama unreachable — return just the default so the UI still works.
    res.json({ models: [], default: settings.defaultModel });
  }
});

// Summarize note content via local Ollama, streaming tokens to the client.
// Body: { content, model? }. Streams plain-text tokens as they arrive.
app.post('/api/summarize', async (req, res, next) => {
  const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
  const model = (req.body.model || settings.defaultModel).trim();
  if (!content) return res.status(400).json({ error: 'nothing to summarize' });

  const prompt =
    'Summarize the following daily notes into a few concise bullet points. ' +
    'Capture key tasks, decisions, and takeaways. Use markdown bullets. ' +
    'Do not add anything that is not in the notes.\n\n---\n' + content;

  let r;
  try {
    r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: true }),
    });
  } catch (err) {
    if (err.cause && err.cause.code === 'ECONNREFUSED') {
      return res.status(502).json({ error: `Cannot reach Ollama at ${OLLAMA_URL}` });
    }
    return next(err);
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    return res.status(502).json({ error: `Ollama error (${r.status})`, detail });
  }

  // Committed to streaming. Forward each NDJSON line's `response` token.
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Model', model);
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  let buffer = '';
  const decoder = new TextDecoder();
  try {
    for await (const chunk of r.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.response) res.write(obj.response);
          if (obj.done) return res.end();
        } catch {
          // partial/non-JSON line; ignore
        }
      }
    }
    res.end();
  } catch (err) {
    // Stream broke mid-flight — close the response; client shows what it has.
    res.end();
  }
});

// Fetch a single day's note. Returns empty content if none exists yet.
app.get('/api/notes/:date', async (req, res, next) => {
  try {
    const { date } = req.params;
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const doc = await notes.findOne({ date }, { projection: { _id: 0 } });
    res.json(doc || { date, content: '', updatedAt: null, archived: false });
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

// Archive / restore a day. Soft-delete: the note stays in the store but is
// hidden from the active list and search.
app.post('/api/notes/:date/archive', (req, res, next) => setArchived(req, res, next, true));
app.post('/api/notes/:date/unarchive', (req, res, next) => setArchived(req, res, next, false));

async function setArchived(req, res, next, archived) {
  try {
    const { date } = req.params;
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const update = archived
      ? { $set: { archived: true, archivedAt: new Date() } }
      : { $set: { archived: false }, $unset: { archivedAt: '' } };
    const result = await notes.updateOne({ date }, update);
    if (result.matchedCount === 0) return res.status(404).json({ error: 'no note for that date' });
    res.json({ date, archived });
  } catch (err) {
    next(err);
  }
}

// --- reference notes ------------------------------------------------------
// Named, evergreen notes that aren't tied to a date (e.g. "Wifi passwords",
// "Book list"). Keyed by an immutable slug derived from the title at creation;
// the title can be renamed freely without breaking the slug.
function slugify(s) {
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// List all reference notes (title + slug), alphabetical by title.
app.get('/api/references', async (req, res, next) => {
  try {
    const docs = await references
      .find({}, { projection: { _id: 0, slug: 1, title: 1, updatedAt: 1 } })
      .collation({ locale: 'en', strength: 1 })
      .sort({ title: 1 })
      .toArray();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// Create a new reference note from a title. Generates a unique slug.
app.post('/api/references', async (req, res, next) => {
  try {
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    if (!title) return res.status(400).json({ error: 'title is required' });
    const base = slugify(title) || 'note';
    let slug = base;
    for (let n = 2; await references.findOne({ slug }); n++) slug = `${base}-${n}`;
    const now = new Date();
    await references.insertOne({ slug, title, content: '', createdAt: now, updatedAt: now });
    res.status(201).json({ slug, title, content: '', updatedAt: now });
  } catch (err) {
    next(err);
  }
});

// Read a single reference note.
app.get('/api/references/:slug', async (req, res, next) => {
  try {
    const doc = await references.findOne({ slug: req.params.slug }, { projection: { _id: 0 } });
    if (!doc) return res.status(404).json({ error: 'no such reference' });
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

// Update a reference note's content and/or title (slug stays fixed).
app.put('/api/references/:slug', async (req, res, next) => {
  try {
    const set = { updatedAt: new Date() };
    if (typeof req.body.content === 'string') set.content = req.body.content;
    if (typeof req.body.title === 'string' && req.body.title.trim()) set.title = req.body.title.trim();
    const result = await references.updateOne({ slug: req.params.slug }, { $set: set });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'no such reference' });
    res.json({ slug: req.params.slug, ...set });
  } catch (err) {
    next(err);
  }
});

// Delete a reference note (hard delete; the UI confirms first).
app.delete('/api/references/:slug', async (req, res, next) => {
  try {
    const result = await references.deleteOne({ slug: req.params.slug });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'no such reference' });
    res.json({ ok: true });
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
  references = db.collection('references');
  // One reference per slug; text index over title + content for future search.
  await references.createIndex({ slug: 1 }, { unique: true });
  await references.createIndex({ title: 'text', content: 'text' });
  settingsCol = db.collection('settings');
  await loadSettings();
  app.listen(PORT, () => console.log(`daily-notes listening on :${PORT}`));
  rescheduleBackup();
  catchUpBackup();
}

// Run a backup if the last one is missing or >24h old. Covers the macOS case
// where the machine was asleep at the scheduled hour (in-process timers don't
// fire while the host sleeps, so the daily run can be silently missed). Skipped
// when scheduled backups are turned off.
async function catchUpBackup() {
  if (settings.backupSchedule === 'off') return;
  try {
    const doc = await settingsCol.findOne({ _id: 'app' }, { projection: { lastBackupAt: 1 } });
    const last = doc && doc.lastBackupAt ? new Date(doc.lastBackupAt).getTime() : 0;
    const age = Date.now() - last;
    if (age < 24 * 60 * 60 * 1000) return;
    const n = await performBackup();
    console.log(`[catch-up backup] last backup ${last ? Math.round(age / 3.6e6) + 'h ago' : 'never'} — wrote ${n} note(s)`);
  } catch (err) {
    console.error('[catch-up backup] failed:', err.message);
  }
}

// Run a backup and record when it happened (powers the catch-up check).
async function performBackup() {
  const n = await runBackup();
  await settingsCol.updateOne({ _id: 'app' }, { $set: { lastBackupAt: new Date() } }, { upsert: true });
  return n;
}

// Load persisted settings (seeded from env on first run).
async function loadSettings() {
  const doc = await settingsCol.findOne({ _id: 'app' });
  if (doc) {
    settings = { backupSchedule: doc.backupSchedule, backupHour: doc.backupHour, defaultModel: doc.defaultModel };
  } else {
    await settingsCol.insertOne({ _id: 'app', ...settings });
  }
}

// Schedule a backup for the next settings.backupHour, then every 24h. No cron
// dep: compute ms to the next occurrence and chain setTimeout -> setInterval.
// Safe to call repeatedly — clears any existing timers first.
let backupTimer = null;
let backupInterval = null;
function rescheduleBackup() {
  clearTimeout(backupTimer);
  clearInterval(backupInterval);
  backupTimer = backupInterval = null;
  if (settings.backupSchedule === 'off') {
    console.log('scheduled backup disabled');
    return;
  }
  const now = new Date();
  const next = new Date(now);
  next.setHours(settings.backupHour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  console.log(`scheduled daily backup at ${String(settings.backupHour).padStart(2, '0')}:00 (next in ${Math.round(delay / 3.6e6)}h)`);
  backupTimer = setTimeout(() => {
    doBackup();
    backupInterval = setInterval(doBackup, 24 * 60 * 60 * 1000);
  }, delay);
}

async function doBackup() {
  try {
    const n = await performBackup();
    console.log(`[scheduled backup] wrote ${n} note(s)`);
  } catch (err) {
    console.error('[scheduled backup] failed:', err.message);
  }
}

start().catch((err) => {
  console.error('failed to start', err);
  process.exit(1);
});
