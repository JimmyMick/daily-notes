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

// Export all notes to BACKUP_DIR. Returns the number of notes written.
async function runBackup({ mongoUri = MONGO_URI, dbName = DB_NAME, backupDir = BACKUP_DIR } = {}) {
  const client = new MongoClient(mongoUri);
  await client.connect();
  try {
    const notes = client.db(dbName).collection('notes');
    const docs = await notes.find({}).sort({ date: 1 }).toArray();
    await fs.mkdir(backupDir, { recursive: true });
    for (const doc of docs) {
      const file = path.join(backupDir, `${doc.date}.md`);
      await fs.writeFile(file, frontmatter(doc) + (doc.content || '') + '\n', 'utf8');
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
