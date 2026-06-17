'use strict';

// Export every note to a markdown file (one per day) under BACKUP_DIR.
// Each file carries a small frontmatter block so restore.js can round-trip it.
// Run: docker compose exec app npm run backup

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

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  try {
    const notes = client.db(DB_NAME).collection('notes');
    const docs = await notes.find({}).sort({ date: 1 }).toArray();
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    for (const doc of docs) {
      const file = path.join(BACKUP_DIR, `${doc.date}.md`);
      await fs.writeFile(file, frontmatter(doc) + (doc.content || '') + '\n', 'utf8');
    }
    console.log(`Backed up ${docs.length} note(s) to ${BACKUP_DIR}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('backup failed:', err);
  process.exit(1);
});
