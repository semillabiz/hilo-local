import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { MEMORY_TYPES, type HiloStorage, type MemoryType } from '../core/types.js';

export interface SyncCounts {
  memories: number;
  skills: number;
  docs: number;
}

function safeFileSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9._/-]/g, '_');
}

function serializeFrontmatter(meta: Record<string, string | boolean | null | undefined>, body: string): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'boolean') {
      lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push('---', '', body);
  return lines.join('\n');
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith('---\n')) {
    return { meta: {}, body: raw };
  }
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) {
    return { meta: {}, body: raw };
  }
  const header = raw.slice(4, end);
  const body = raw.slice(end + 5).replace(/^\n+/, '');
  const meta: Record<string, string> = {};
  for (const line of header.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      try {
        val = String(JSON.parse(val));
      } catch {
        val = val.slice(1, -1);
      }
    }
    meta[key] = val;
  }
  return { meta, body };
}

function walkMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...walkMarkdownFiles(full));
    } else if (entry.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Exports active profile memories, skills, and docs to a Git-friendly directory (.hilo/).
 */
export function exportToDirectory(storage: HiloStorage, targetDir = '.hilo'): SyncCounts {
  const memDir = join(targetDir, 'memories');
  const skillDir = join(targetDir, 'skills');
  const docDir = join(targetDir, 'docs');
  mkdirSync(memDir, { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(docDir, { recursive: true });

  const memories = storage.listMemories({ limit: 100 });
  for (const m of memories) {
    const filePath = join(memDir, m.type, `${safeFileSegment(m.name)}.md`);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      serializeFrontmatter(
        {
          name: m.name,
          type: m.type,
          tema: m.tema,
          summary: m.summary,
          pinned: m.pinned,
        },
        m.content,
      ),
      'utf8',
    );
  }

  const skills = storage.listSkills();
  for (const sMeta of skills) {
    const skill = storage.getSkill(sMeta.name);
    if (!skill) continue;
    const filePath = join(skillDir, safeFileSegment(skill.name), 'SKILL.md');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      serializeFrontmatter({ name: skill.name, description: skill.description }, skill.content),
      'utf8',
    );
  }

  const docs = storage.listDocs();
  for (const dMeta of docs) {
    const doc = storage.getDoc(dMeta.path);
    if (!doc) continue;
    const rel = safeFileSegment(doc.path).replace(/^\/+/, '');
    const filePath = join(docDir, rel.endsWith('.md') ? rel : `${rel}.md`);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      serializeFrontmatter({ path: doc.path, title: doc.title, tema: doc.tema }, doc.content),
      'utf8',
    );
  }

  return { memories: memories.length, skills: skills.length, docs: docs.length };
}

/**
 * Imports memories, skills, and docs from a .hilo/ directory into SQLite storage.
 */
export function importFromDirectory(storage: HiloStorage, sourceDir = '.hilo'): SyncCounts {
  let memories = 0;
  let skills = 0;
  let docs = 0;

  const memDir = join(sourceDir, 'memories');
  for (const file of walkMarkdownFiles(memDir)) {
    const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'));
    const type = MEMORY_TYPES.includes(meta.type as MemoryType) ? (meta.type as MemoryType) : 'project';
    const name = meta.name || relative(memDir, file).replace(/\.md$/, '');
    storage.saveMemory({
      name,
      type,
      tema: meta.tema || null,
      summary: meta.summary || body.split('\n')[0]?.slice(0, 120) || name,
      content: body,
      pinned: meta.pinned === 'true',
    });
    memories++;
  }

  const skillDir = join(sourceDir, 'skills');
  for (const file of walkMarkdownFiles(skillDir)) {
    const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'));
    const name = meta.name || relative(skillDir, dirname(file));
    storage.saveSkill({
      name,
      description: meta.description || name,
      content: body,
    });
    skills++;
  }

  const docDir = join(sourceDir, 'docs');
  for (const file of walkMarkdownFiles(docDir)) {
    const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'));
    const path = meta.path || relative(docDir, file);
    storage.saveDoc({
      path,
      title: meta.title || path,
      tema: meta.tema || null,
      content: body,
    });
    docs++;
  }

  return { memories, skills, docs };
}

/**
 * Imports observations from an existing Engram SQLite database (~/.engram/engram.db).
 */
export function importFromEngram(
  storage: HiloStorage,
  engramDbPath = join(homedir(), '.engram', 'engram.db'),
): number {
  if (!existsSync(engramDbPath)) {
    throw new Error(`No se encontró la base de Engram en "${engramDbPath}".`);
  }
  const engramDb = new DatabaseSync(engramDbPath, { readOnly: true });
  try {
    const tables = engramDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    if (!tables.some((t) => t.name === 'observations')) {
      throw new Error('La base de datos no tiene tabla "observations" de Engram.');
    }
    const rows = engramDb
      .prepare('SELECT id, title, content, type, project FROM observations ORDER BY created_at ASC')
      .all() as {
      id: number | string;
      title?: string | null;
      content?: string | null;
      type?: string | null;
      project?: string | null;
    }[];

    let imported = 0;
    for (const row of rows) {
      const content = (row.content ?? '').trim();
      if (!content) continue;
      const title = (row.title ?? `engram-${row.id}`).trim();
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);
      const type: MemoryType =
        row.type === 'decision' || row.type === 'architecture'
          ? 'project'
          : row.type === 'preference'
            ? 'feedback'
            : 'project';

      storage.saveMemory({
        name: `engram/${slug || row.id}`,
        type,
        tema: row.project || 'engram-import',
        summary: title.slice(0, 140),
        content,
      });
      imported++;
    }
    return imported;
  } finally {
    engramDb.close();
  }
}
