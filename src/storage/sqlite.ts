import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  ContextBundle,
  Doc,
  HiloStorage,
  HistoryEntry,
  ListMemoriesInput,
  LogHistoryInput,
  Memory,
  MemoryType,
  Profile,
  SaveDocInput,
  SaveMemoryInput,
  SaveSkillInput,
  SearchDocsInput,
  SearchHistoryInput,
  SearchMemoriesInput,
  Skill,
  TemaCount,
} from '../core/types.js';

export function defaultDbPath(): string {
  return process.env.HILO_DB_PATH || join(homedir(), '.hilo', 'hilo.db');
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Escapes user search input into safe FTS5 prefix/token terms.
 */
function toFtsQuery(raw: string): string | null {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/["'()*.:^~/-]/g, ' ').trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

interface RawMemoryRow {
  id: string;
  profile_id: string;
  name: string;
  type: MemoryType;
  tema: string | null;
  summary: string;
  content: string;
  pinned: number;
  created_at: string;
  updated_at: string;
}

function mapMemory(row: RawMemoryRow): Memory {
  return {
    id: row.id,
    profileId: row.profile_id,
    name: row.name,
    type: row.type,
    tema: row.tema,
    summary: row.summary,
    content: row.content,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface RawProfileRow {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  created_at: string;
  updated_at: string;
}

function mapProfile(row: RawProfileRow): Profile {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface RawSkillRow {
  id: string;
  profile_id: string;
  name: string;
  description: string;
  content: string;
  created_at: string;
  updated_at: string;
}

function mapSkill(row: RawSkillRow): Skill {
  return {
    id: row.id,
    profileId: row.profile_id,
    name: row.name,
    description: row.description,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface RawDocRow {
  id: string;
  profile_id: string;
  path: string;
  title: string;
  tema: string | null;
  content: string;
  created_at: string;
  updated_at: string;
}

function mapDoc(row: RawDocRow): Doc {
  return {
    id: row.id,
    profileId: row.profile_id,
    path: row.path,
    title: row.title,
    tema: row.tema,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface RawHistoryRow {
  id: string;
  profile_id: string;
  title: string;
  summary: string;
  tags: string;
  tema: string | null;
  created_at: string;
}

function mapHistory(row: RawHistoryRow): HistoryEntry {
  return {
    id: row.id,
    profileId: row.profile_id,
    title: row.title,
    summary: row.summary,
    tags: JSON.parse(row.tags || '[]') as string[],
    tema: row.tema,
    createdAt: row.created_at,
  };
}

/**
 * Local-first SQLite + FTS5 implementation of HiloStorage using Node's built-in node:sqlite.
 */
export class SqliteHiloStorage implements HiloStorage {
  readonly db: DatabaseSync;

  constructor(dbPath = defaultDbPath()) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
    this.ensureDefaultProfile();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        instructions TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('user', 'feedback', 'project', 'reference')),
        tema TEXT,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(profile_id, name)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        name,
        tema,
        summary,
        content,
        content='memories',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, name, tema, summary, content)
        VALUES (new.rowid, new.name, COALESCE(new.tema, ''), new.summary, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, name, tema, summary, content)
        VALUES ('delete', old.rowid, old.name, COALESCE(old.tema, ''), old.summary, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, name, tema, summary, content)
        VALUES ('delete', old.rowid, old.name, COALESCE(old.tema, ''), old.summary, old.content);
        INSERT INTO memories_fts(rowid, name, tema, summary, content)
        VALUES (new.rowid, new.name, COALESCE(new.tema, ''), new.summary, new.content);
      END;

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(profile_id, name)
      );

      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        tema TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(profile_id, path)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        path,
        title,
        tema,
        content,
        content='docs',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
        INSERT INTO docs_fts(rowid, path, title, tema, content)
        VALUES (new.rowid, new.path, new.title, COALESCE(new.tema, ''), new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, path, title, tema, content)
        VALUES ('delete', old.rowid, old.path, old.title, COALESCE(old.tema, ''), old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, path, title, tema, content)
        VALUES ('delete', old.rowid, old.path, old.title, COALESCE(old.tema, ''), old.content);
        INSERT INTO docs_fts(rowid, path, title, tema, content)
        VALUES (new.rowid, new.path, new.title, COALESCE(new.tema, ''), new.content);
      END;

      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        tema TEXT,
        created_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
        title,
        summary,
        tags,
        content='history',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history BEGIN
        INSERT INTO history_fts(rowid, title, summary, tags)
        VALUES (new.rowid, new.title, new.summary, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS history_ad AFTER DELETE ON history BEGIN
        INSERT INTO history_fts(history_fts, rowid, title, summary, tags)
        VALUES ('delete', old.rowid, old.title, old.summary, old.tags);
      END;
    `);
  }

  private ensureDefaultProfile(): void {
    const existing = this.db.prepare('SELECT id FROM profiles WHERE id = ?').get('default') as { id: string } | undefined;
    if (!existing) {
      const now = nowIso();
      this.db
        .prepare('INSERT INTO profiles (id, name, description, instructions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('default', 'Personal', 'Perfil local por defecto', null, now, now);
    }
    const active = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('active_profile_id') as { value: string } | undefined;
    if (!active) {
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('active_profile_id', 'default');
    }
  }

  getActiveProfileId(): string {
    if (process.env.HILO_PROFILE) return process.env.HILO_PROFILE;
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('active_profile_id') as { value: string } | undefined;
    return row?.value ?? 'default';
  }

  setActiveProfileId(profileId: string): Profile {
    const row = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId) as RawProfileRow | undefined;
    if (!row) {
      throw new Error(`Perfil "${profileId}" no existe.`);
    }
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('active_profile_id', profileId);
    return mapProfile(row);
  }

  listProfiles(): Profile[] {
    const rows = this.db.prepare('SELECT * FROM profiles ORDER BY created_at ASC').all() as unknown as RawProfileRow[];
    return rows.map(mapProfile);
  }

  upsertProfile(input: { id: string; name: string; description?: string | null; instructions?: string | null }): Profile {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO profiles (id, name, description, instructions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = COALESCE(excluded.description, profiles.description),
           instructions = COALESCE(excluded.instructions, profiles.instructions),
           updated_at = excluded.updated_at`,
      )
      .run(input.id, input.name, input.description ?? null, input.instructions ?? null, now, now);
    const row = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(input.id) as unknown as RawProfileRow;
    return mapProfile(row);
  }

  loadContext(tema?: string): ContextBundle {
    const profileId = this.getActiveProfileId();
    let profileRow = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId) as RawProfileRow | undefined;
    if (!profileRow) {
      profileRow = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get('default') as unknown as RawProfileRow;
    }

    const userAndFeedback = (
      this.db
        .prepare(
          `SELECT * FROM memories
           WHERE profile_id = ? AND type IN ('user', 'feedback')
           ORDER BY pinned DESC, updated_at DESC`,
        )
        .all(profileRow.id) as unknown as RawMemoryRow[]
    ).map(mapMemory);

    const indexedQuery = tema
      ? `SELECT * FROM memories
         WHERE profile_id = ? AND type IN ('project', 'reference') AND tema = ?
         ORDER BY pinned DESC, updated_at DESC LIMIT 40`
      : `SELECT * FROM memories
         WHERE profile_id = ? AND type IN ('project', 'reference')
         ORDER BY pinned DESC, updated_at DESC LIMIT 40`;

    const indexedMemories = (
      (tema
        ? this.db.prepare(indexedQuery).all(profileRow.id, tema)
        : this.db.prepare(indexedQuery).all(profileRow.id)) as unknown as RawMemoryRow[]
    ).map(mapMemory);

    const temas = this.db
      .prepare(
        `SELECT tema, COUNT(*) as count FROM memories
         WHERE profile_id = ? AND tema IS NOT NULL AND tema != ''
         GROUP BY tema ORDER BY count DESC`,
      )
      .all(profileRow.id) as unknown as TemaCount[];

    const skills = this.db
      .prepare('SELECT name, description FROM skills WHERE profile_id = ? ORDER BY name ASC')
      .all(profileRow.id) as unknown as Pick<Skill, 'name' | 'description'>[];

    const histRow = this.db
      .prepare('SELECT COUNT(*) as count FROM history WHERE profile_id = ?')
      .get(profileRow.id) as unknown as { count: number };

    return {
      profile: mapProfile(profileRow),
      userAndFeedback,
      indexedMemories,
      temas,
      skills,
      historyCount: histRow.count,
    };
  }

  searchMemories(input: SearchMemoriesInput): Memory[] {
    const profileId = this.getActiveProfileId();
    const limit = Math.min(input.limit ?? 10, 50);
    const fts = input.q ? toFtsQuery(input.q) : null;

    const conditions = ['m.profile_id = ?'];
    const params: (string | number)[] = [profileId];

    if (input.type) {
      conditions.push('m.type = ?');
      params.push(input.type);
    }
    if (input.tema) {
      conditions.push('m.tema = ?');
      params.push(input.tema);
    }
    if (input.since) {
      conditions.push('m.updated_at >= ?');
      params.push(input.since);
    }

    if (fts) {
      const sql = `
        SELECT m.* FROM memories m
        JOIN memories_fts f ON m.rowid = f.rowid
        WHERE memories_fts MATCH ? AND ${conditions.join(' AND ')}
        ORDER BY bm25(memories_fts), m.updated_at DESC
        LIMIT ?
      `;
      return (this.db.prepare(sql).all(fts, ...params, limit) as unknown as RawMemoryRow[]).map(mapMemory);
    }

    const sql = `
      SELECT m.* FROM memories m
      WHERE ${conditions.join(' AND ')}
      ORDER BY m.pinned DESC, m.updated_at DESC
      LIMIT ?
    `;
    return (this.db.prepare(sql).all(...params, limit) as unknown as RawMemoryRow[]).map(mapMemory);
  }

  getMemory(name: string): Memory | null {
    const profileId = this.getActiveProfileId();
    const row = this.db
      .prepare('SELECT * FROM memories WHERE profile_id = ? AND name = ?')
      .get(profileId, name) as RawMemoryRow | undefined;
    return row ? mapMemory(row) : null;
  }

  listMemories(input: ListMemoriesInput): Memory[] {
    const profileId = this.getActiveProfileId();
    const limit = Math.min(input.limit ?? 20, 100);
    const offset = input.offset ?? 0;
    const conditions = ['profile_id = ?'];
    const params: (string | number)[] = [profileId];

    if (input.type) {
      conditions.push('type = ?');
      params.push(input.type);
    }
    if (input.tema) {
      conditions.push('tema = ?');
      params.push(input.tema);
    }

    const sql = `SELECT * FROM memories WHERE ${conditions.join(' AND ')} ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`;
    return (this.db.prepare(sql).all(...params, limit, offset) as unknown as RawMemoryRow[]).map(mapMemory);
  }

  saveMemory(input: SaveMemoryInput): Memory {
    const profileId = this.getActiveProfileId();
    const now = nowIso();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO memories (id, profile_id, name, type, tema, summary, content, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, name) DO UPDATE SET
           type = excluded.type,
           tema = excluded.tema,
           summary = excluded.summary,
           content = excluded.content,
           pinned = COALESCE(?, memories.pinned),
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        profileId,
        input.name,
        input.type,
        input.tema ?? null,
        input.summary,
        input.content,
        input.pinned ? 1 : 0,
        now,
        now,
        input.pinned === undefined ? null : input.pinned ? 1 : 0,
      );
    const row = this.db
      .prepare('SELECT * FROM memories WHERE profile_id = ? AND name = ?')
      .get(profileId, input.name) as unknown as RawMemoryRow;
    return mapMemory(row);
  }

  deleteMemory(name: string): boolean {
    const profileId = this.getActiveProfileId();
    const res = this.db.prepare('DELETE FROM memories WHERE profile_id = ? AND name = ?').run(profileId, name);
    return res.changes > 0;
  }

  listSkills(): Pick<Skill, 'name' | 'description' | 'updatedAt'>[] {
    const profileId = this.getActiveProfileId();
    const rows = this.db
      .prepare('SELECT name, description, updated_at FROM skills WHERE profile_id = ? ORDER BY name ASC')
      .all(profileId) as unknown as { name: string; description: string; updated_at: string }[];
    return rows.map((r) => ({ name: r.name, description: r.description, updatedAt: r.updated_at }));
  }

  getSkill(name: string): Skill | null {
    const profileId = this.getActiveProfileId();
    const row = this.db
      .prepare('SELECT * FROM skills WHERE profile_id = ? AND name = ?')
      .get(profileId, name) as RawSkillRow | undefined;
    return row ? mapSkill(row) : null;
  }

  saveSkill(input: SaveSkillInput): Skill {
    const profileId = this.getActiveProfileId();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO skills (id, profile_id, name, description, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, name) DO UPDATE SET
           description = excluded.description,
           content = excluded.content,
           updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), profileId, input.name, input.description, input.content, now, now);
    const row = this.db
      .prepare('SELECT * FROM skills WHERE profile_id = ? AND name = ?')
      .get(profileId, input.name) as unknown as RawSkillRow;
    return mapSkill(row);
  }

  deleteSkill(name: string): boolean {
    const profileId = this.getActiveProfileId();
    const res = this.db.prepare('DELETE FROM skills WHERE profile_id = ? AND name = ?').run(profileId, name);
    return res.changes > 0;
  }

  searchDocs(input: SearchDocsInput): Doc[] {
    const profileId = this.getActiveProfileId();
    const limit = Math.min(input.limit ?? 15, 50);
    const fts = input.q ? toFtsQuery(input.q) : null;
    const conditions = ['d.profile_id = ?'];
    const params: (string | number)[] = [profileId];

    if (input.tema) {
      conditions.push('d.tema = ?');
      params.push(input.tema);
    }

    if (fts) {
      const sql = `
        SELECT d.* FROM docs d
        JOIN docs_fts f ON d.rowid = f.rowid
        WHERE docs_fts MATCH ? AND ${conditions.join(' AND ')}
        ORDER BY bm25(docs_fts), d.updated_at DESC
        LIMIT ?
      `;
      return (this.db.prepare(sql).all(fts, ...params, limit) as unknown as RawDocRow[]).map(mapDoc);
    }

    const sql = `SELECT d.* FROM docs d WHERE ${conditions.join(' AND ')} ORDER BY d.updated_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...params, limit) as unknown as RawDocRow[]).map(mapDoc);
  }

  listDocs(tema?: string): Pick<Doc, 'path' | 'title' | 'tema' | 'updatedAt'>[] {
    const profileId = this.getActiveProfileId();
    const rows = (
      tema
        ? this.db
            .prepare('SELECT path, title, tema, updated_at FROM docs WHERE profile_id = ? AND tema = ? ORDER BY path ASC')
            .all(profileId, tema)
        : this.db
            .prepare('SELECT path, title, tema, updated_at FROM docs WHERE profile_id = ? ORDER BY path ASC')
            .all(profileId)
    ) as unknown as { path: string; title: string; tema: string | null; updated_at: string }[];
    return rows.map((r) => ({ path: r.path, title: r.title, tema: r.tema, updatedAt: r.updated_at }));
  }

  getDoc(path: string): Doc | null {
    const profileId = this.getActiveProfileId();
    const row = this.db
      .prepare('SELECT * FROM docs WHERE profile_id = ? AND path = ?')
      .get(profileId, path) as RawDocRow | undefined;
    return row ? mapDoc(row) : null;
  }

  saveDoc(input: SaveDocInput): Doc {
    const profileId = this.getActiveProfileId();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO docs (id, profile_id, path, title, tema, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, path) DO UPDATE SET
           title = excluded.title,
           tema = excluded.tema,
           content = excluded.content,
           updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), profileId, input.path, input.title, input.tema ?? null, input.content, now, now);
    const row = this.db
      .prepare('SELECT * FROM docs WHERE profile_id = ? AND path = ?')
      .get(profileId, input.path) as unknown as RawDocRow;
    return mapDoc(row);
  }

  deleteDoc(path: string): boolean {
    const profileId = this.getActiveProfileId();
    const res = this.db.prepare('DELETE FROM docs WHERE profile_id = ? AND path = ?').run(profileId, path);
    return res.changes > 0;
  }

  searchHistory(input: SearchHistoryInput): HistoryEntry[] {
    const profileId = this.getActiveProfileId();
    const limit = Math.min(input.limit ?? 20, 50);
    const fts = input.q ? toFtsQuery(input.q) : null;
    const conditions = ['h.profile_id = ?'];
    const params: (string | number)[] = [profileId];

    if (input.since) {
      conditions.push('h.created_at >= ?');
      params.push(input.since);
    }
    if (input.until) {
      conditions.push('h.created_at <= ?');
      params.push(input.until);
    }
    if (input.tag) {
      conditions.push('h.tags LIKE ?');
      params.push(`%"${input.tag}"%`);
    }

    if (fts) {
      const sql = `
        SELECT h.* FROM history h
        JOIN history_fts f ON h.rowid = f.rowid
        WHERE history_fts MATCH ? AND ${conditions.join(' AND ')}
        ORDER BY h.created_at DESC
        LIMIT ?
      `;
      return (this.db.prepare(sql).all(fts, ...params, limit) as unknown as RawHistoryRow[]).map(mapHistory);
    }

    const sql = `SELECT h.* FROM history h WHERE ${conditions.join(' AND ')} ORDER BY h.created_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...params, limit) as unknown as RawHistoryRow[]).map(mapHistory);
  }

  logHistory(input: LogHistoryInput): HistoryEntry {
    const profileId = this.getActiveProfileId();
    const now = nowIso();
    const id = randomUUID();
    const tagsJson = JSON.stringify(input.tags ?? []);
    this.db
      .prepare('INSERT INTO history (id, profile_id, title, summary, tags, tema, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, profileId, input.title, input.summary, tagsJson, input.tema ?? null, now);
    const row = this.db.prepare('SELECT * FROM history WHERE id = ?').get(id) as unknown as RawHistoryRow;
    return mapHistory(row);
  }
}
