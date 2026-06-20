'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');
const { MongoClient, ObjectId, Binary } = require('mongodb');
const { runBackup } = require('./backup');
const email = require('./email');
const news = require('./news');
const scores = require('./scores');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'daily_notes';
// Ollama runs on the host; from inside the container reach it via host.docker.internal.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct';
// Instruction sent to the model before the note content (the note is appended
// after a "---" separator). Override with SUMMARY_PROMPT in the environment.
const SUMMARY_PROMPT = process.env.SUMMARY_PROMPT ||
  'Summarize the following daily notes into a few concise bullet points. ' +
  'Capture key tasks, decisions, and takeaways. Use markdown bullets. ' +
  'Do not add anything that is not in the notes.';
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
let images; // uploaded images (binary) collection handle
let tasks; // task/todo list collection handle
let lastBackupAt = null; // when the last backup ran (Date), surfaced in settings

// Image uploads: accept common image types, hold in memory, cap the size.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});
// Runtime settings, seeded from env, overridable via the Settings panel.
let settings = {
  backupSchedule: BACKUP_SCHEDULE, // 'on' | 'off'
  backupHour: BACKUP_HOUR, // 0-23
  defaultModel: OLLAMA_MODEL,
  emailTo: process.env.GMAIL_USER || '', // default recipient for "Email note"
  newsCount: parseInt(process.env.NEWS_COUNT || '3', 10) || 3, // headlines per source in the ticker
  newsSources: news.DEFAULT_SOURCES, // [{ name, url }] feeds for the ticker
  showTickers: true, // show the news/scores ticker bar
};

// Validate/normalize a user-supplied news-source list. Each entry needs an
// http(s) URL; the name is optional (news.js derives one from the feed/host).
function cleanNewsSources(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const s of input.slice(0, news.MAX_SOURCES)) {
    const url = typeof s.url === 'string' ? s.url.trim() : '';
    if (!/^https?:\/\/\S+$/i.test(url)) return null;
    out.push({ name: typeof s.name === 'string' ? s.name.trim() : '', url });
  }
  return out;
}

// Loose email check — enough to catch typos, not RFC-perfect.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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

// Read current runtime settings (plus the last backup time, for display).
app.get('/api/settings', (req, res) => res.json({ ...settings, lastBackupAt }));

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
    if (typeof req.body.emailTo === 'string') {
      const v = req.body.emailTo.trim();
      if (v && !EMAIL_RE.test(v)) return res.status(400).json({ error: 'emailTo must be a valid email' });
      next_.emailTo = v;
    }
    if (req.body.newsCount !== undefined) {
      const c = parseInt(req.body.newsCount, 10);
      if (Number.isNaN(c) || c < 1 || c > 20) return res.status(400).json({ error: 'newsCount must be 1-20' });
      next_.newsCount = c;
    }
    if (req.body.newsSources !== undefined) {
      const sources = cleanNewsSources(req.body.newsSources);
      if (!sources) return res.status(400).json({ error: 'each news source needs a valid http(s) URL' });
      next_.newsSources = sources;
    }
    if (req.body.showTickers !== undefined) next_.showTickers = !!req.body.showTickers;
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
    res.json({ ok: true, count, lastBackupAt });
  } catch (err) {
    next(err);
  }
});

// Latest headlines for the bottom ticker, limited to settings.newsCount per
// source. Served from a short-lived in-memory cache (see news.js).
app.get('/api/news', async (req, res) => {
  try {
    const data = await news.getHeadlines(settings.newsCount, settings.newsSources);
    res.json(data);
  } catch (err) {
    console.error('[news] route failed:', err.message);
    res.json({ items: [], fetchedAt: 0 });
  }
});

// Upload an image (from the editor's button, paste, or drag-and-drop). Stores
// the binary in Mongo and returns a URL to embed as markdown. The field name is
// "image"; multer rejects non-images via fileFilter (req.file is then absent).
app.post('/api/images', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no image file (must be an image type under 10 MB)' });
    const doc = {
      contentType: req.file.mimetype,
      size: req.file.size,
      filename: req.file.originalname || 'image',
      data: new Binary(req.file.buffer),
      createdAt: new Date(),
    };
    const { insertedId } = await images.insertOne(doc);
    res.status(201).json({ url: `/api/images/${insertedId}` });
  } catch (err) {
    next(err);
  }
});

// Collect the uploaded images a note references (by /api/images/<id>), so the
// emailer can inline them. Returns { id: { contentType, buffer } }.
async function collectNoteImages(markdown) {
  const ids = new Set();
  const re = /\/api\/images\/([0-9a-fA-F]{24})/g;
  let m;
  while ((m = re.exec(markdown || ''))) ids.add(m[1]);
  const map = {};
  for (const id of ids) {
    try {
      const doc = await images.findOne({ _id: new ObjectId(id) });
      if (doc && doc.data) map[id] = { contentType: doc.contentType, buffer: doc.data.buffer };
    } catch { /* skip bad id */ }
  }
  return map;
}

// Serve an uploaded image by id.
app.get('/api/images/:id', async (req, res, next) => {
  try {
    let _id;
    try { _id = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: 'bad image id' }); }
    const doc = await images.findOne({ _id });
    if (!doc) return res.status(404).json({ error: 'no such image' });
    res.setHeader('Content-Type', doc.contentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // ids are stable
    res.send(doc.data.buffer);
  } catch (err) {
    next(err);
  }
});

// Multer errors (e.g. file too large) arrive as a special error type — surface
// a clean message instead of the generic 500 handler.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'image exceeds the 10 MB limit' : err.message;
    return res.status(400).json({ error: msg });
  }
  next(err);
});

// Latest sports scores for the second ticker line (live/final/today's games),
// served from a short-lived in-memory cache (see scores.js).
app.get('/api/scores', async (req, res) => {
  try {
    const data = await scores.getScores();
    res.json(data);
  } catch (err) {
    console.error('[scores] route failed:', err.message);
    res.json({ games: [], fetchedAt: 0 });
  }
});

// Whether email is configured (Gmail user + App Password present) plus the
// default recipient, so the UI can prefill and warn when it's not set up.
app.get('/api/email/status', (req, res) => {
  res.json({ configured: email.isConfigured(), from: email.from || null, defaultTo: settings.emailTo || '' });
});

// Email a note (daily or reference) via Gmail. Body: { kind, id, to }.
//   kind 'daily'     -> id is a YYYY-MM-DD date
//   kind 'reference' -> id is a reference slug
app.post('/api/email', async (req, res, next) => {
  try {
    if (!email.isConfigured()) {
      return res.status(503).json({
        error: 'Email is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD, then restart.',
      });
    }
    const { kind, id } = req.body;
    const to = typeof req.body.to === 'string' ? req.body.to.trim() : '';
    // Allow a comma-separated list; validate each address.
    const recipients = to.split(',').map((s) => s.trim()).filter(Boolean);
    if (!recipients.length || !recipients.every((r) => EMAIL_RE.test(r))) {
      return res.status(400).json({ error: 'a valid recipient is required' });
    }

    let subject, markdown;
    if (kind === 'daily') {
      if (!DATE_RE.test(id)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      const doc = await notes.findOne({ date: id });
      if (!doc || !doc.content || !doc.content.trim()) return res.status(400).json({ error: 'note is empty' });
      subject = `Daily note — ${id}`;
      markdown = doc.content;
    } else if (kind === 'reference') {
      const doc = await references.findOne({ slug: id });
      if (!doc) return res.status(404).json({ error: 'no such reference' });
      if (!doc.content || !doc.content.trim()) return res.status(400).json({ error: 'note is empty' });
      subject = `Reference note — ${doc.title}`;
      markdown = doc.content;
    } else {
      return res.status(400).json({ error: 'kind must be "daily" or "reference"' });
    }

    try {
      const noteImages = await collectNoteImages(markdown);
      await email.sendNoteEmail({ to: recipients.join(', '), subject, markdown, images: noteImages });
    } catch (err) {
      // Surface SMTP/auth failures clearly instead of the generic 500 handler.
      return res.status(502).json({ error: 'send failed', detail: err.message });
    }
    res.json({ ok: true, to: recipients.join(', ') });
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

  const prompt = `${SUMMARY_PROMPT}\n\n---\n${content}`;

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

// --- tasks / todo list ----------------------------------------------------
// A single global checklist shown in the right panel. Open tasks first, then
// completed; within each group, oldest first.

// Normalize an optional due date. Returns null (no due date), a YYYY-MM-DD
// string, or undefined if the input is present but invalid. The regex only
// checks the shape, so also confirm it's a real calendar date (rejects e.g.
// 2026-13-99 and 2026-02-30, which the regex alone would pass).
function parseDue(v) {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !DATE_RE.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return undefined;
  return v;
}

// Task category. Returns a valid category or undefined if invalid.
const TASK_CATEGORIES = ['work', 'personal'];
function parseCategory(v) {
  return TASK_CATEGORIES.includes(v) ? v : undefined;
}

app.get('/api/tasks', async (req, res, next) => {
  try {
    const docs = await tasks
      .find({}, { projection: { text: 1, done: 1, createdAt: 1, dueDate: 1, category: 1, order: 1 } })
      .sort({ done: 1, order: 1, createdAt: 1 })
      .toArray();
    res.json(docs.map((d) => ({
      id: d._id.toString(), text: d.text, done: !!d.done, createdAt: d.createdAt,
      dueDate: d.dueDate || null, category: d.category || 'personal', // default for legacy rows
    })));
  } catch (err) {
    next(err);
  }
});

app.post('/api/tasks', async (req, res, next) => {
  try {
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'text is required' });
    const dueDate = req.body.dueDate === undefined ? null : parseDue(req.body.dueDate);
    if (dueDate === undefined) return res.status(400).json({ error: 'dueDate must be YYYY-MM-DD' });
    const category = req.body.category === undefined ? 'personal' : parseCategory(req.body.category);
    if (category === undefined) return res.status(400).json({ error: 'category must be work or personal' });
    const now = new Date();
    // New tasks sort to the bottom of the open list (a large order); manual
    // reordering overwrites these with compact 0..n indices.
    const order = now.getTime();
    const { insertedId } = await tasks.insertOne({ text, done: false, dueDate, category, order, createdAt: now, updatedAt: now });
    res.status(201).json({ id: insertedId.toString(), text, done: false, dueDate, category, order, createdAt: now });
  } catch (err) {
    next(err);
  }
});

// Persist a manual order. Body: { ids: [...] } — the full desired order.
// Each task's `order` becomes its index. Defined before the :id route so
// "reorder" isn't captured as a task id.
app.patch('/api/tasks/reorder', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : null;
    if (!ids) return res.status(400).json({ error: 'ids array is required' });
    const ops = [];
    ids.forEach((id, i) => {
      let _id;
      try { _id = new ObjectId(id); } catch { return; } // skip bad ids
      ops.push({ updateOne: { filter: { _id }, update: { $set: { order: i, updatedAt: new Date() } } } });
    });
    if (ops.length) await tasks.bulkWrite(ops);
    res.json({ ok: true, count: ops.length });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/tasks/:id', async (req, res, next) => {
  try {
    let _id;
    try { _id = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: 'bad task id' }); }
    const set = { updatedAt: new Date() };
    if (typeof req.body.done === 'boolean') set.done = req.body.done;
    if (typeof req.body.text === 'string' && req.body.text.trim()) set.text = req.body.text.trim();
    if ('dueDate' in req.body) {
      const dueDate = parseDue(req.body.dueDate);
      if (dueDate === undefined) return res.status(400).json({ error: 'dueDate must be YYYY-MM-DD' });
      set.dueDate = dueDate; // null clears it
    }
    if ('category' in req.body) {
      const category = parseCategory(req.body.category);
      if (category === undefined) return res.status(400).json({ error: 'category must be work or personal' });
      set.category = category;
    }
    const result = await tasks.updateOne({ _id }, { $set: set });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'no such task' });
    res.json({ id: req.params.id, ...set });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/tasks/:id', async (req, res, next) => {
  try {
    let _id;
    try { _id = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: 'bad task id' }); }
    const result = await tasks.deleteOne({ _id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'no such task' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Clear all completed tasks at once.
app.delete('/api/tasks', async (req, res, next) => {
  try {
    const result = await tasks.deleteMany({ done: true });
    res.json({ ok: true, deleted: result.deletedCount });
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
  images = db.collection('images'); // uploaded image binaries, served by _id
  tasks = db.collection('tasks'); // global todo list
  await tasks.createIndex({ done: 1, order: 1, createdAt: 1 });
  await backfillTaskOrder();
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
  lastBackupAt = new Date();
  await settingsCol.updateOne({ _id: 'app' }, { $set: { lastBackupAt } }, { upsert: true });
  return n;
}

// Give any tasks created before manual ordering an `order` (by creation time),
// so they sort sensibly until the user drags them.
async function backfillTaskOrder() {
  const legacy = await tasks.find({ order: { $exists: false } }).sort({ createdAt: 1 }).toArray();
  if (!legacy.length) return;
  const ops = legacy.map((d) => ({
    updateOne: { filter: { _id: d._id }, update: { $set: { order: new Date(d.createdAt || Date.now()).getTime() } } },
  }));
  await tasks.bulkWrite(ops);
  console.log(`[tasks] backfilled order for ${ops.length} legacy task(s)`);
}

// Load persisted settings (seeded from env on first run).
async function loadSettings() {
  const doc = await settingsCol.findOne({ _id: 'app' });
  if (doc && doc.lastBackupAt) lastBackupAt = new Date(doc.lastBackupAt);
  if (doc) {
    settings = {
      backupSchedule: doc.backupSchedule,
      backupHour: doc.backupHour,
      defaultModel: doc.defaultModel,
      emailTo: doc.emailTo || settings.emailTo || '',
      newsCount: doc.newsCount || settings.newsCount || 3,
      newsSources: Array.isArray(doc.newsSources) && doc.newsSources.length ? doc.newsSources : news.DEFAULT_SOURCES,
      showTickers: doc.showTickers !== false,
    };
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
