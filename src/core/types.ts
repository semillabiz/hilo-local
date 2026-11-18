export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface Profile {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Memory {
  id: string;
  profileId: string;
  name: string;
  type: MemoryType;
  tema: string | null;
  summary: string;
  content: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SaveMemoryInput {
  name: string;
  type: MemoryType;
  tema?: string | null;
  summary: string;
  content: string;
  pinned?: boolean;
}

export interface SearchMemoriesInput {
  q?: string;
  type?: MemoryType;
  tema?: string;
  since?: string;
  limit?: number;
}

export interface ListMemoriesInput {
  type?: MemoryType;
  tema?: string;
  limit?: number;
  offset?: number;
}

export interface Skill {
  id: string;
  profileId: string;
  name: string;
  description: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveSkillInput {
  name: string;
  description: string;
  content: string;
}

export interface Doc {
  id: string;
  profileId: string;
  path: string;
  title: string;
  tema: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveDocInput {
  path: string;
  title: string;
  tema?: string | null;
  content: string;
}

export interface SearchDocsInput {
  q?: string;
  tema?: string;
  limit?: number;
}

export interface HistoryEntry {
  id: string;
  profileId: string;
  title: string;
  summary: string;
  tags: string[];
  tema: string | null;
  createdAt: string;
}

export interface LogHistoryInput {
  title: string;
  summary: string;
  tags?: string[];
  tema?: string | null;
}

export interface SearchHistoryInput {
  q?: string;
  since?: string;
  until?: string;
  tag?: string;
  limit?: number;
}

export interface TemaCount {
  tema: string;
  count: number;
}

export interface ContextBundle {
  profile: Profile;
  userAndFeedback: Memory[];
  indexedMemories: Memory[];
  temas: TemaCount[];
  skills: Pick<Skill, 'name' | 'description'>[];
  historyCount: number;
}

/**
 * Storage adapter contract shared between local SQLite (@hilomemory/local)
 * and cloud Postgres (hilomemory.app).
 */
export interface HiloStorage {
  getActiveProfileId(): string;
  setActiveProfileId(profileId: string): Profile;
  listProfiles(): Profile[];
  upsertProfile(input: { id: string; name: string; description?: string | null; instructions?: string | null }): Profile;

  loadContext(tema?: string): ContextBundle;

  searchMemories(input: SearchMemoriesInput): Memory[];
  getMemory(name: string): Memory | null;
  listMemories(input: ListMemoriesInput): Memory[];
  saveMemory(input: SaveMemoryInput): Memory;
  deleteMemory(name: string): boolean;

  listSkills(): Pick<Skill, 'name' | 'description' | 'updatedAt'>[];
  getSkill(name: string): Skill | null;
  saveSkill(input: SaveSkillInput): Skill;
  deleteSkill(name: string): boolean;

  searchDocs(input: SearchDocsInput): Doc[];
  listDocs(tema?: string): Pick<Doc, 'path' | 'title' | 'tema' | 'updatedAt'>[];
  getDoc(path: string): Doc | null;
  saveDoc(input: SaveDocInput): Doc;
  deleteDoc(path: string): boolean;

  searchHistory(input: SearchHistoryInput): HistoryEntry[];
  logHistory(input: LogHistoryInput): HistoryEntry;
}
