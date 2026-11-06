#!/bin/bash
set -euo pipefail

# ==============================================================================
# CrossPoint Sync Library Auto-Indexer
# ------------------------------------------------------------------------------
# Automatically scans BookOrbit (or a media library) and populates crosspoint.db
# with filename MD5 hashes, titles, and authors.
#
# Resolves the issue where CrossInk / KOReader sends hash-only PUT /syncs/progress
# requests without metadata, enabling instant matching against Readwise Reader.
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${CROSSPOINT_DATA_DIR:-/mnt/user/appdata/crosspoint-sync/data}"
DUMP_FILE="${DATA_DIR}/bookorbit_dump.tsv"
CONTAINER_NAME="${CROSSPOINT_CONTAINER:-crosspoint-sync}"
DB_CONTAINER="${BOOKORBIT_DB_CONTAINER:-bookorbit-db}"
DB_USER="${BOOKORBIT_DB_USER:-bookorbit}"
DB_NAME="${BOOKORBIT_DB_NAME:-bookorbit}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting BookOrbit -> CrossPoint Sync auto-indexer..."

# 1. Extract all content books from BookOrbit PostgreSQL
# Format: absolute_path \t title \t author \t format
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -F$'\t' -c "
SELECT 
  bf.absolute_path,
  COALESCE(NULLIF(bm.title, ''), regexp_replace(bf.absolute_path, '^.*/(.*)\\.[^.]+$', '\\1')),
  COALESCE(b.primary_author_sort_name, ''),
  bf.format
FROM book_files bf
JOIN books b ON b.id = bf.book_id
LEFT JOIN book_metadata bm ON bm.book_id = b.id
WHERE bf.format IN ('epub', 'pdf', 'mobi', 'azw3', 'cbz', 'cbr')
  AND bf.role = 'content';
" > "$DUMP_FILE"

COUNT=$(wc -l < "$DUMP_FILE")
echo "Found $COUNT content books in BookOrbit."

# 2. Process dump inside crosspoint-sync container and insert into SQLite crosspoint.db
docker exec "$CONTAINER_NAME" node --input-type=module -e '
import { openDatabase } from "/app/dist/db/db.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const db = openDatabase("/data/crosspoint.db");
const raw = fs.readFileSync("/data/bookorbit_dump.tsv", "utf8");
const lines = raw.split("\n").filter(Boolean);

// Ensure library_books lookup table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS library_books (
    hash TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    format TEXT,
    updated_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_library_books_filename ON library_books(filename);
`);

const stmtDoc = db.prepare(`
  INSERT INTO documents (user_id, document, title, author, filename, updated_at)
  VALUES (1, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, document) DO UPDATE SET
    title = COALESCE(documents.title, excluded.title),
    author = COALESCE(documents.author, excluded.author),
    filename = COALESCE(documents.filename, excluded.filename)
`);

const stmtLib = db.prepare(`
  INSERT INTO library_books (hash, filename, title, author, format, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(hash) DO UPDATE SET
    title = excluded.title,
    author = excluded.author,
    filename = excluded.filename,
    format = excluded.format,
    updated_at = excluded.updated_at
`);

const now = Math.floor(Date.now() / 1000);
let inserted = 0;

for (const line of lines) {
  const parts = line.split("\t");
  if (parts.length < 4) continue;
  const [absPath, title, author, format] = parts;
  const filename = path.basename(absPath);
  if (!filename) continue;

  const hash = crypto.createHash("md5").update(filename).digest("hex");
  stmtLib.run(hash, filename, title, author || "", format, now);
  stmtDoc.run(hash, title, author || "", filename, now);
  inserted++;
}

console.log(`Successfully indexed ${inserted} books into crosspoint.db!`);
'

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Indexing complete."
