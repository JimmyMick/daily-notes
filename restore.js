'use strict';

// Restore notes from markdown backups in BACKUP_DIR into MongoDB.
// Upserts by date, so it's safe to re-run. Existing notes are overwritten
// only for the dates present in the backup folder.
// Run: docker compose exec app npm run restore

const fs = require('fs/promises');
const path = require('path');
const { MongoClient } = require('mongodb');

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
      const setOnInsert = { createdAt: meta.createdAt ? new Date(meta.createdAt) : new Date() };
      await references.updateOne({ slug }, { $set: doc, $setOnInsert: setOnInsert }, { upsert: true });
      refRestored++;
    }

    console.log(`Restored ${restored} note(s) and ${refRestored} reference(s) from ${BACKUP_DIR}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('restore failed:', err);
  process.exit(1);
});
