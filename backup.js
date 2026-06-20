'use strict';

// Export every note to a markdown file (one per day) under BACKUP_DIR.
// Each file carries a small frontmatter block so restore.js can round-trip it.
// Usable as a CLI (npm run backup) or imported for the scheduled backup.

const fs = require('fs/promises');
const path = require('path');
const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'daily_notes';
const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';

function frontmatter(doc) {
  const lines = [
    '---',
    `date: ${doc.date}`,
    `archived: ${doc.archived === true}`,
    doc.createdAt ? `createdAt: ${new Date(doc.createdAt).toISOString()}` : null,
    doc.updatedAt ? `updatedAt: ${new Date(doc.updatedAt).toISOString()}` : null,
    '---',
    '',
  ].filter((l) => l !== null);
  return lines.join('\n');
}

// File extension for an image content type (best-effort; cosmetic only — the
// authoritative content type is preserved in images/index.json).
const IMAGE_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
};
function imageExt(contentType) {
  return IMAGE_EXT[contentType] || 'bin';
}

function refFrontmatter(doc) {
  const lines = [
    '---',
    `slug: ${doc.slug}`,
    `title: ${doc.title}`,
    doc.createdAt ? `createdAt: ${new Date(doc.createdAt).toISOString()}` : null,
    doc.updatedAt ? `updatedAt: ${new Date(doc.updatedAt).toISOString()}` : null,
    '---',
    '',
  ].filter((l) => l !== null);
  return lines.join('\n');
}

// Export all notes to BACKUP_DIR (daily notes as YYYY-MM-DD.md, reference notes
// under references/<slug>.md). Returns the number of daily notes written.
async function runBackup({ mongoUri = MONGO_URI, dbName = DB_NAME, backupDir = BACKUP_DIR } = {}) {
  const client = new MongoClient(mongoUri);
  await client.connect();
  try {
    const db = client.db(dbName);
    const notes = db.collection('notes');
    const docs = await notes.find({}).sort({ date: 1 }).toArray();
    await fs.mkdir(backupDir, { recursive: true });
    for (const doc of docs) {
      const file = path.join(backupDir, `${doc.date}.md`);
      await fs.writeFile(file, frontmatter(doc) + (doc.content || '') + '\n', 'utf8');
    }
    // Reference notes go in their own subfolder, keyed by slug.
    const refs = await db.collection('references').find({}).sort({ slug: 1 }).toArray();
    if (refs.length) {
      const refDir = path.join(backupDir, 'references');
      await fs.mkdir(refDir, { recursive: true });
      for (const doc of refs) {
        const file = path.join(refDir, `${doc.slug}.md`);
        await fs.writeFile(file, refFrontmatter(doc) + (doc.content || '') + '\n', 'utf8');
      }
    }
    // Uploaded images: write each binary under images/<id>.<ext>, plus an
    // index.json carrying the metadata (ids, content types) so restore can put
    // them back with the SAME ids — keeping the ![](/api/images/<id>) links valid.
    const imgs = await db.collection('images').find({}).sort({ createdAt: 1 }).toArray();
    if (imgs.length) {
      const imgDir = path.join(backupDir, 'images');
      await fs.mkdir(imgDir, { recursive: true });
      const index = [];
      for (const doc of imgs) {
        const id = doc._id.toString();
        const file = `${id}.${imageExt(doc.contentType)}`;
        await fs.writeFile(path.join(imgDir, file), doc.data.buffer);
        index.push({
          id,
          file,
          contentType: doc.contentType,
          filename: doc.filename,
          size: doc.size,
          createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
        });
      }
      await fs.writeFile(path.join(imgDir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
    }

    // Task/todo list: small, so a single tasks.json (keeps ids for round-trip).
    const taskDocs = await db.collection('tasks').find({}).sort({ createdAt: 1 }).toArray();
    if (taskDocs.length) {
      const tasksOut = taskDocs.map((t) => ({
        id: t._id.toString(),
        text: t.text,
        done: t.done === true,
        dueDate: t.dueDate || null,
        category: t.category || 'personal',
        createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : null,
        updatedAt: t.updatedAt ? new Date(t.updatedAt).toISOString() : null,
      }));
      await fs.writeFile(path.join(backupDir, 'tasks.json'), JSON.stringify(tasksOut, null, 2) + '\n', 'utf8');
    }

    return docs.length;
  } finally {
    await client.close();
  }
}

module.exports = { runBackup };

// Run as a CLI when invoked directly.
if (require.main === module) {
  runBackup()
    .then((n) => console.log(`Backed up ${n} note(s) to ${BACKUP_DIR}`))
    .catch((err) => {
      console.error('backup failed:', err);
      process.exit(1);
    });
}
