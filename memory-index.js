#!/usr/bin/env node
/**
 * memory-index.js — SQLite FTS5 full-text index over the shared AI Memory store.
 *
 * Adopted from SwiftMaestro's MemorySearchEngine (Sources/Memory/MemorySearchEngine.swift)
 * so users WITHOUT SwiftMaestro installed still get sub-millisecond ranked full-text
 * search over `~/.ai-context/memory`.
 *
 * The Markdown/JSON files under the memory store remain the source of truth. This
 * module keeps a DERIVED SQLite index (memory_files + memory_fts FTS5 with triggers)
 * that turns a full-store scan into a fast FTS query. It is purely a performance
 * cache: if better-sqlite3 is missing or the index fails to build, every public
 * method degrades gracefully so the server can fall back to the file-walking scan.
 *
 * Schema mirrors SwiftMaestro exactly:
 *   - memory_meta    (key TEXT PK, value TEXT)   — stores the FTS schema version
 *   - memory_files   (path TEXT PK, kind, mtime, size, content) STRICT
 *   - memory_fts     FTS5 virtual table, external-content on memory_files, kept in
 *                    sync by AFTER INSERT/DELETE/UPDATE triggers
 *
 * First full build reads every file (can take a while on big stores), so it runs on
 * a worker thread off the request path (mirroring Swift's detached utility task).
 * Searches read the last committed index — with WAL mode a search never blocks a
 * reindex in progress.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { isMainThread, Worker, parentPort, workerData } from "worker_threads";

/** Bump when the schema/triggers change so a stale index is rebuilt, not misread. */
const FTS_SCHEMA_VERSION = "2"; // external-content FTS + triggers

/** Skip files larger than this (avoid indexing huge/binary content). */
const MAX_FILE_SIZE = 2_000_000;

// ---------------------------------------------------------------------------
// Path resolution (no hardcoded usernames — resolve from os.homedir()/env)
// ---------------------------------------------------------------------------

function memoryRoot() {
  const override = process.env.AI_MEMORY_ROOT;
  const root = override
    ? path.resolve(override)
    : path.join(os.homedir(), ".ai-context", "memory");
  // Resolve symlinks (e.g. ~/.ai-context/memory -> iCloud Drive): a directory
  // walker does not cross a symlink used as its start URL and would silently
  // return zero files, and relative-path math stays consistent after resolution.
  return fs.realpathSync(root);
}

function indexDBPath() {
  return process.env.AI_MEMORY_INDEX
    ? path.resolve(process.env.AI_MEMORY_INDEX)
    : path.join(os.homedir(), ".ai-context", "memory-index.sqlite");
}

/** Known secret values to strip from content before indexing (optional).
 *  Sources, in order: AI_MEMORY_REDACT env (comma-separated) and, if present,
 *  `~/.ai-context/redact.txt` (one value per line). Returns a function. */
function loadRedactor() {
  const values = [];
  try {
    const envList = process.env.AI_MEMORY_REDACT || "";
    for (const v of envList.split(",")) {
      const t = v.trim();
      if (t) values.push(t);
    }
  } catch {}
  try {
    const f = path.join(os.homedir(), ".ai-context", "redact.txt");
    if (fs.existsSync(f)) {
      const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
      for (const l of lines) {
        const t = l.trim();
        if (t && !t.startsWith("#")) values.push(t);
      }
    }
  } catch {}
  const patterns = values
    .filter((v) => v.length >= 4)
    .map((v) => ({ re: new RegExp(escapeRegExp(v), "gi"), mask: "[redacted]" }));
  return (content) => {
    let out = content;
    for (const p of patterns) out = out.replace(p.re, p.mask);
    return out;
  };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Schema setup
// ---------------------------------------------------------------------------

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS memory_files (
      path TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      mtime REAL NOT NULL,
      size INTEGER NOT NULL,
      content TEXT NOT NULL
    ) STRICT;
  `);

  const row = db
    .prepare("SELECT value AS v FROM memory_meta WHERE key = ?")
    .get("fts-schema-version");
  const storedVersion = row ? row.v : null;
  const needsRecreate = storedVersion !== FTS_SCHEMA_VERSION;

  if (needsRecreate) {
    db.exec(`
      DROP TABLE IF EXISTS memory_fts;
      DROP TRIGGER IF EXISTS memory_fts_ai;
      DROP TRIGGER IF EXISTS memory_fts_ad;
      DROP TRIGGER IF EXISTS memory_fts_au;
    `);
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      path UNINDEXED,
      content,
      content = 'memory_files',
      content_rowid = 'rowid',
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory_files BEGIN
      INSERT INTO memory_fts(rowid, path, content)
      VALUES (new.rowid, new.path, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory_files BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, path, content)
      VALUES ('delete', old.rowid, old.path, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory_files BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, path, content)
      VALUES ('delete', old.rowid, old.path, old.content);
      INSERT INTO memory_fts(rowid, path, content)
      VALUES (new.rowid, new.path, new.content);
    END;
  `);
  db.prepare(
    "INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run("fts-schema-version", FTS_SCHEMA_VERSION);

  // Rebuild the FTS index from current memory_files (no-op first time).
  if (needsRecreate) db.exec("INSERT INTO memory_fts(memory_fts) VALUES ('rebuild')");
}

function kindFor(relativePath) {
  const top = relativePath.split("/")[0] || "";
  if (["conversations", "context", "knowledge", "skills"].includes(top)) return top;
  const ext = path.extname(relativePath).slice(1);
  return ext || "text";
}

// ---------------------------------------------------------------------------
// FTS query helpers (mirror SwiftMaestro MemorySearchEngine)
// ---------------------------------------------------------------------------

/** Escape user input so it can be used as an FTS5 MATCH query. */
function ftsSafe(query) {
  return query
    .split(/\s+/)
    .filter((p) => p.length > 0)
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join(" ");
}

/** Extract a snippet around the first case-insensitive occurrence of `needle`. */
function snippetAround(content, needle, width = 160) {
  const collapsed = String(content).replace(/\n/g, " ");
  const lower = collapsed.toLowerCase();
  const idx = lower.indexOf(needle.toLowerCase());
  if (idx < 0) return collapsed.slice(0, width);
  const start = Math.max(0, idx - 40);
  return collapsed.slice(start, start + width).trim();
}

// ---------------------------------------------------------------------------
// Incremental reindex
// ---------------------------------------------------------------------------

/** Walk the store and upsert/remove rows by comparing mtime+size. */
function reindexSync({ db, root, redactor, maxFileSize = MAX_FILE_SIZE }) {
  const fm = fs;
  const current = new Set();
  const batch = [];

  function walk(dir) {
    let entries;
    try {
      entries = fm.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue; // hidden files / .DS_Store
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (e.isSymbolicLink()) continue; // avoid scanning through symlinks
      if (!e.isFile()) continue;
      const rel = path.relative(root, full);
      if (!rel || rel.startsWith(".")) continue;
      if (path.extname(rel).toLowerCase() === ".dat") continue;

      let st;
      try {
        st = fm.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > maxFileSize) continue;
      let content;
      try {
        content = fm.readFileSync(full, "utf8");
      } catch {
        continue; // unreadable file — skip rather than abort the whole pass
      }

      current.add(rel);
      batch.push({
        path: rel,
        kind: kindFor(rel),
        mtime: st.mtimeMs / 1000,
        size: st.size,
        content: redactor(content),
      });
    }
  }

  walk(root);

  const store = db.transaction(() => {
    // Remove rows whose files no longer exist.
    const existing = db.prepare("SELECT path FROM memory_files").all().map((r) => r.path);
    const stale = existing.filter((p) => !current.has(p));
    const del = db.prepare("DELETE FROM memory_files WHERE path = ?");
    for (const p of stale) del.run(p);

    // Upsert changed files.
    const upsert = db.prepare(`
      INSERT INTO memory_files (path, kind, mtime, size, content)
      VALUES (@path, @kind, @mtime, @size, @content)
      ON CONFLICT(path) DO UPDATE SET
        kind = excluded.kind,
        mtime = excluded.mtime,
        size = excluded.size,
        content = excluded.content
    `);
    const same = db.prepare(
      "SELECT 1 FROM memory_files WHERE path = ? AND mtime = ? AND size = ?"
    );
    for (const b of batch) {
      if (same.get(b.path, b.mtime, b.size)) continue;
      upsert.run(b);
    }
  });
  store();

  return { indexed: batch.length, current: current.size };
}

// ---------------------------------------------------------------------------
// Worker thread — runs the first (potentially slow) full reindex off the
// main thread so the MCP server's event loop never stalls on a big store.
// ---------------------------------------------------------------------------

if (!isMainThread) {
  // Worker entry point: build the index for the requested root/path (passed via
  // workerData), then notify the main thread.
  try {
    const { default: Database } = await import("better-sqlite3");
    const wRoot = workerData?.memoryRoot || memoryRoot();
    const wIndex = workerData?.indexPath || indexDBPath();
    fs.mkdirSync(path.dirname(wIndex), { recursive: true });
    const db = new Database(wIndex, { timeout: 30_000 });
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    createSchema(db);
    const result = reindexSync({ db, root: wRoot, redactor: loadRedactor() });
    const count = db.prepare("SELECT COUNT(*) AS c FROM memory_files").get().c;
    db.close();
    parentPort.postMessage({ ok: true, result, count });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err && err.message || err) });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create the memory index. Returns a Promise resolving to an object with
 * `search`, `indexedCount`, `ensureWarm`, `reindexSync`, and `refreshIfStale`;
 * or `null` if better-sqlite3 is unavailable or the index cannot be opened
 * (callers fall back to file-walk).
 */
export async function createMemoryIndex({ memoryRoot: overrideRoot, indexPath } = {}) {
  let Database;
  try {
    const mod = await import("better-sqlite3");
    Database = mod.default;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[memory-index] better-sqlite3 import failed:", e && e.message);
    return null; // better-sqlite3 not installed -> graceful fallback
  }

  const root = overrideRoot ? path.resolve(overrideRoot) : memoryRoot();
  const dbPath = indexPath ? path.resolve(indexPath) : indexDBPath();
  if (!fs.existsSync(root)) return null;

  let db;
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath, { timeout: 30_000 });
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    createSchema(db);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[memory-index] db/schema error:", e && e.message);
    try { if (db) db.close(); } catch {}
    return null;
  }

  let worker = null;
  let warming = false;
  let lastRefreshAt = 0;
  const refreshCooldownMs = 60_000;
  const redactor = loadRedactor();

  function indexedCount() {
    try {
      return db.prepare("SELECT COUNT(*) AS c FROM memory_files").get().c;
    } catch {
      return 0;
    }
  }

  function useFTS() {
    try {
      return !!db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'")
        .get();
    } catch {
      return false;
    }
  }

  /**
   * Search the FTS index. Returns an array of {path, kind, snippet} ranked by
   * relevance, or `null` while the index is still cold so the caller knows to
   * fall back to the (correct, but slower) file-walking scan.
   */
  function search(query, limit = 20) {
    const trimmed = String(query || "").trim();
    if (!trimmed) return [];
    const safeQuery = ftsSafe(trimmed);
    const n = Math.max(1, Math.min(Number(limit) || 20, 200));
    try {
      if (useFTS()) {
        const rows = db
          .prepare(
            `SELECT path, content FROM memory_fts
             WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?`
          )
          .all(safeQuery, n);
        return rows.map((r) => ({
          path: r.path,
          kind: kindFor(r.path),
          snippet: snippetAround(r.content, trimmed),
        }));
      }
      const like = `%${trimmed}%`;
      const rows = db
        .prepare(
          `SELECT path, kind, content FROM memory_files
           WHERE content LIKE ? ESCAPE '\\' LIMIT ?`
        )
        .all(like, n);
      return rows.map((r) => ({
        path: r.path,
        kind: r.kind || kindFor(r.path),
        snippet: snippetAround(r.content, trimmed),
      }));
    } catch {
      return null;
    }
  }

  /** Synchronously refresh the index (incremental). Returns counts or null. */
  function reindexSyncNow() {
    try {
      const r = reindexSync({ db, root, redactor });
      lastRefreshAt = Date.now();
      return r;
    } catch {
      return null;
    }
  }

  /** Kick off a full reindex on a worker thread (first build). No-op if warm. */
  function ensureWarm() {
    if (indexedCount() > 0 || warming) return;
    warming = true;
    try {
      worker = new Worker(new URL(import.meta.url), {
        workerData: { memoryRoot: root, indexPath: dbPath },
      });
      worker.on("message", () => {
        warming = false;
        lastRefreshAt = Date.now();
        worker = null;
      });
      worker.on("error", (e) => {
        // eslint-disable-next-line no-console
        console.error("[memory-index] worker error:", e && e.message);
        warming = false;
        worker = null;
      });
    } catch {
      // Worker threads unavailable — fall back to a deferred sync reindex so
      // the current request still returns promptly.
      warming = false;
      setTimeout(() => {
        try { reindexSyncNow(); } catch {}
        lastRefreshAt = Date.now();
      }, 0);
    }
  }

  /** Cheap background refresh if the cooldown has elapsed (mirrors MemorySearchService). */
  function refreshIfStale() {
    const cold = indexedCount() === 0;
    const stale = Date.now() - lastRefreshAt > refreshCooldownMs;
    if (cold || stale) {
      if (cold) ensureWarm();
      else {
        // Incremental refresh on the main thread is lightweight (mtime+size check
        // per file, only reading changed ones) — safe to run synchronously.
        try { reindexSyncNow(); } catch {}
      }
    }
  }

  return {
    search,
    indexedCount,
    ensureWarm,
    reindexSync: reindexSyncNow,
    refreshIfStale,
    indexPath: dbPath,
    memoryRoot: root,
  };
}

// Re-export for tooling/tests.
export { memoryRoot, indexDBPath, ftsSafe, snippetAround };
