'use strict';

// Restore notes from markdown backups in BACKUP_DIR into MongoDB.
// Upserts by date, so it's safe to re-run. Existing notes are overwritten
// only for the dates present in the backup folder.
// Run: docker compose exec app npm run restore

const fs = require('fs/promises');
const path = require('path');
const { MongoClient, ObjectId, Binary } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'daily_notes';
const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Parse the small frontmatter block backup.js writes. Returns { meta, body }.
function parse(text) {
  const meta = {};
  let body = text;
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 4);
    if (end !== -1) {
      const block = text.slice(4, end);
      body = text.slice(end + 4).replace(/^\n/, '');
      for (const line of block.split('\n')) {
        const i = line.indexOf(':');
        if (i === -1) continue;
        meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
    }
  }
  return { meta, body };
}

async function main() {
  const files = (await fs.readdir(BACKUP_DIR)).filter((f) => f.endsWith('.md'));
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  let restored = 0;
  try {
    const notes = client.db(DB_NAME).collection('notes');
    for (const file of files) {
      const date = path.basename(file, '.md');
      if (!DATE_RE.test(date)) {
        console.warn(`skipping ${file}: name is not a YYYY-MM-DD date`);
        continue;
      }
      const text = await fs.readFile(path.join(BACKUP_DIR, file), 'utf8');
      const { meta, body } = parse(text);
      const doc = {
        date,
        content: body.replace(/\n$/, ''),
        archived: meta.archived === 'true',
        updatedAt: meta.updatedAt ? new Date(meta.updatedAt) : new Date(),
      };
      const setOnInsert = { createdAt: meta.createdAt ? new Date(meta.createdAt) : new Date() };
      await notes.updateOne({ date }, { $set: doc, $setOnInsert: setOnInsert }, { upsert: true });
      restored++;
    }

    // Restore reference-note folders (references/folders.json) before the notes,
    // so the folder ids referenced in each note's frontmatter already exist.
    const folders = client.db(DB_NAME).collection('folders');
    let folderRestored = 0;
    try {
      const raw = await fs.readFile(path.join(BACKUP_DIR, 'references', 'folders.json'), 'utf8');
      for (const f of JSON.parse(raw)) {
        if (!f || !f.id) continue;
        await folders.updateOne(
          { id: f.id },
          { $set: { name: f.name || f.id }, $setOnInsert: { createdAt: f.createdAt ? new Date(f.createdAt) : new Date() } },
          { upsert: true },
        );
        folderRestored++;
      }
    } catch {
      // no folders.json — nothing to restore
    }

    // Restore reference notes from the references/ subfolder, upsert by slug.
    const references = client.db(DB_NAME).collection('references');
    const refDir = path.join(BACKUP_DIR, 'references');
    let refFiles = [];
    try {
      refFiles = (await fs.readdir(refDir)).filter((f) => f.endsWith('.md'));
    } catch {
      // no references folder — nothing to restore
    }
    let refRestored = 0;
    for (const file of refFiles) {
      const text = await fs.readFile(path.join(refDir, file), 'utf8');
      const { meta, body } = parse(text);
      const slug = meta.slug || path.basename(file, '.md');
      const doc = {
        slug,
        title: meta.title || slug,
        content: body.replace(/\n$/, ''),
        updatedAt: meta.updatedAt ? new Date(meta.updatedAt) : new Date(),
      };
      if (meta.folder) doc.folder = meta.folder;
      const setOnInsert = { createdAt: meta.createdAt ? new Date(meta.createdAt) : new Date() };
      await references.updateOne({ slug }, { $set: doc, $setOnInsert: setOnInsert }, { upsert: true });
      refRestored++;
    }

    // Restore uploaded images from images/index.json + the binary files, upsert
    // by their original _id so note links (/api/images/<id>) keep working.
    const imgDir = path.join(BACKUP_DIR, 'images');
    let imgIndex = [];
    try {
      imgIndex = JSON.parse(await fs.readFile(path.join(imgDir, 'index.json'), 'utf8'));
    } catch {
      // no images/index.json — nothing to restore
    }
    let imgRestored = 0;
    if (Array.isArray(imgIndex) && imgIndex.length) {
      const imagesCol = client.db(DB_NAME).collection('images');
      for (const e of imgIndex) {
        let _id;
        try { _id = new ObjectId(e.id); } catch { console.warn(`skipping image ${e.id}: bad id`); continue; }
        let buf;
        try { buf = await fs.readFile(path.join(imgDir, e.file)); } catch { console.warn(`skipping image ${e.id}: missing ${e.file}`); continue; }
        const doc = {
          contentType: e.contentType || 'application/octet-stream',
          size: e.size != null ? e.size : buf.length,
          filename: e.filename || e.file,
          data: new Binary(buf),
          createdAt: e.createdAt ? new Date(e.createdAt) : new Date(),
        };
        await imagesCol.updateOne({ _id }, { $set: doc }, { upsert: true });
        imgRestored++;
      }
    }

    // Restore the task/todo list from tasks.json, upsert by original _id.
    let taskIndex = [];
    try {
      taskIndex = JSON.parse(await fs.readFile(path.join(BACKUP_DIR, 'tasks.json'), 'utf8'));
    } catch {
      // no tasks.json — nothing to restore
    }
    let taskRestored = 0;
    if (Array.isArray(taskIndex) && taskIndex.length) {
      const tasksCol = client.db(DB_NAME).collection('tasks');
      for (const t of taskIndex) {
        let _id;
        try { _id = new ObjectId(t.id); } catch { console.warn(`skipping task ${t.id}: bad id`); continue; }
        const doc = {
          text: t.text || '',
          done: t.done === true,
          dueDate: t.dueDate || null,
          category: t.category === 'work' ? 'work' : 'personal',
          order: typeof t.order === 'number' ? t.order : new Date(t.createdAt || Date.now()).getTime(),
          updatedAt: t.updatedAt ? new Date(t.updatedAt) : new Date(),
        };
        const setOnInsert = { createdAt: t.createdAt ? new Date(t.createdAt) : new Date() };
        await tasksCol.updateOne({ _id }, { $set: doc, $setOnInsert: setOnInsert }, { upsert: true });
        taskRestored++;
      }
    }

    console.log(`Restored ${restored} note(s), ${refRestored} reference(s), ${folderRestored} folder(s), ${imgRestored} image(s), and ${taskRestored} task(s) from ${BACKUP_DIR}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('restore failed:', err);
  process.exit(1);
});
