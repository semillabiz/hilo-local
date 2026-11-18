import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { MEMORY_TYPES, type HiloStorage, type MemoryType } from '../core/types.js';

export const DEFAULT_CLOUD_ORIGIN = 'https://hilomemory.app';

export interface CloudConfig {
  origin: string;
  token: string;
  refreshToken?: string;
  clientId?: string;
  expiresAt?: number;
  scope?: string;
}

export interface CloudPushResult {
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  skills: number;
  rejected: { path: string; error: string }[];
}

export interface CloudPullResult {
  profile: string;
  memories: number;
  docs: number;
  skills: number;
}

export function cloudConfigPath(): string {
  return process.env.HILO_CLOUD_CONFIG_PATH || join(homedir(), '.hilo', 'cloud.json');
}

export function normalizeCloudOrigin(input = DEFAULT_CLOUD_ORIGIN): string {
  const url = new URL(/^https?:\/\//.test(input) ? input : `https://${input}`);
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !isLocal) {
    throw new Error('Solo se permite https (o http en localhost).');
  }
  return url.origin;
}

export function loadCloudConfig(): CloudConfig | null {
  if (process.env.HILO_CLOUD_TOKEN) {
    return {
      origin: normalizeCloudOrigin(process.env.HILO_CLOUD_ORIGIN || DEFAULT_CLOUD_ORIGIN),
      token: process.env.HILO_CLOUD_TOKEN,
    };
  }
  const file = cloudConfigPath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CloudConfig>;
    if (!parsed.token || !parsed.origin) return null;
    return {
      origin: parsed.origin.replace(/\/+$/, ''),
      token: parsed.token,
      refreshToken: parsed.refreshToken,
      clientId: parsed.clientId,
      expiresAt: parsed.expiresAt,
      scope: parsed.scope,
    };
  } catch {
    return null;
  }
}

export function saveCloudConfig(config: CloudConfig): void {
  const file = cloudConfigPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ ...config, origin: config.origin.replace(/\/+$/, '') }, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  );
}

export function clearCloudConfig(): boolean {
  const file = cloudConfigPath();
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* URL is printed to console */
  }
}

async function tokenRequest(
  origin: string,
  body: Record<string, string>,
): Promise<{
  ok: boolean;
  data: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
}> {
  const res = await fetch(`${origin}/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  return { ok: res.ok, data };
}

/**
 * Ensures the access token is valid, refreshing via OAuth refresh_token if needed.
 */
export async function ensureValidToken(config: CloudConfig): Promise<CloudConfig> {
  if (!config.refreshToken || !config.clientId || !config.expiresAt) {
    return config;
  }
  if (config.expiresAt - 60_000 > Date.now()) {
    return config;
  }
  const refreshed = await tokenRequest(config.origin, {
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: config.refreshToken,
  });
  if (!refreshed.ok || !refreshed.data.access_token) {
    throw new Error('La sesión cloud venció. Volvé a ejecutar: hilo cloud login');
  }
  const updated: CloudConfig = {
    origin: config.origin,
    token: refreshed.data.access_token,
    refreshToken: refreshed.data.refresh_token ?? config.refreshToken,
    clientId: config.clientId,
    expiresAt: Date.now() + (refreshed.data.expires_in ?? 3600) * 1000,
    scope: refreshed.data.scope ?? config.scope,
  };
  saveCloudConfig(updated);
  return updated;
}

export interface OAuthLoginOptions {
  origin?: string;
  scope?: 'read' | 'write';
  manual?: boolean;
  noOpen?: boolean;
  onAuthorizeUrl?: (url: string) => void;
  askManualCode?: () => Promise<string>;
}

/**
 * Performs OAuth 2.0 Dynamic Client Registration + PKCE (S256) login against Hilo Cloud.
 */
export async function loginWithOAuth(options: OAuthLoginOptions = {}): Promise<CloudConfig> {
  const origin = normalizeCloudOrigin(options.origin || DEFAULT_CLOUD_ORIGIN);
  const manual = options.manual === true;
  const scope = options.scope === 'read' ? 'read' : 'write';

  const state = randomBytes(16).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  let server: ReturnType<typeof createServer> | null = null;
  let callbackPromise: Promise<URLSearchParams> | null = null;
  let redirectUri = `${origin}/oauth/code`;

  if (!manual) {
    let resolveCb!: (params: URLSearchParams) => void;
    callbackPromise = new Promise((resolve) => {
      resolveCb = resolve;
    });
    server = createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      if (u.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>Hilo</title><body style="font-family:system-ui;padding:3rem"><h2>Listo</h2><p>Ya podés volver a la terminal.</p>',
      );
      resolveCb(u.searchParams);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr !== 'object') {
      throw new Error('No se pudo abrir el servidor local de callback.');
    }
    redirectUri = `http://127.0.0.1:${addr.port}/callback`;
  }

  try {
    const regRes = await fetch(`${origin}/api/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: `hilo-local CLI (${hostname()})`,
        redirect_uris: [redirectUri],
      }),
    });
    if (!regRes.ok) {
      throw new Error(`No se pudo registrar el cliente OAuth (${regRes.status}).`);
    }
    const { client_id } = (await regRes.json()) as { client_id: string };

    const authUrl = new URL(`${origin}/oauth/authorize`);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      resource: `${origin}/api/mcp`,
      scope,
    })) {
      authUrl.searchParams.set(k, v);
    }

    let code: string;
    if (manual) {
      if (options.onAuthorizeUrl) {
        options.onAuthorizeUrl(authUrl.toString());
      } else {
        console.log(`Abrí este link en cualquier navegador:\n\n  ${authUrl.toString()}\n`);
      }
      if (options.askManualCode) {
        code = (await options.askManualCode()).trim();
      } else {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          code = (await rl.question('Pegá el código acá: ')).trim();
        } finally {
          rl.close();
        }
      }
      if (!code) throw new Error('No ingresaste ningún código.');
    } else {
      if (options.onAuthorizeUrl) {
        options.onAuthorizeUrl(authUrl.toString());
      } else {
        console.log(`Abrí este link para iniciar sesión en Hilo:\n\n  ${authUrl.toString()}\n`);
      }
      if (!options.noOpen) {
        openBrowser(authUrl.toString());
      }
      const params = await Promise.race([
        callbackPromise!,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Se agotó el tiempo (5 min) esperando el login.')), 5 * 60_000),
        ),
      ]);
      const err = params.get('error');
      if (err) {
        throw new Error(err === 'access_denied' ? 'Autorización cancelada.' : `Error OAuth: ${err}`);
      }
      if (params.get('state') !== state) {
        throw new Error('State inválido en respuesta OAuth. Abortado por seguridad.');
      }
      const returnedCode = params.get('code');
      if (!returnedCode) {
        throw new Error('No se recibió el código de autorización.');
      }
      code = returnedCode;
    }

    const tok = await tokenRequest(origin, {
      grant_type: 'authorization_code',
      client_id,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    if (!tok.ok || !tok.data.access_token) {
      throw new Error(`No se pudo canjear el código: ${tok.data.error_description || tok.data.error || 'error'}`);
    }

    const config: CloudConfig = {
      origin,
      token: tok.data.access_token,
      refreshToken: tok.data.refresh_token,
      clientId: client_id,
      expiresAt: Date.now() + (tok.data.expires_in ?? 3600) * 1000,
      scope: tok.data.scope ?? scope,
    };
    saveCloudConfig(config);
    return config;
  } finally {
    server?.close();
  }
}

/**
 * Guides the user through creating a seed-phrase (12-word) account on Hilo Web
 * and immediately links this local terminal via OAuth 2.0 PKCE.
 */
export async function registerWithHiloWeb(options: OAuthLoginOptions = {}): Promise<CloudConfig> {
  const origin = normalizeCloudOrigin(options.origin || DEFAULT_CLOUD_ORIGIN);
  const registerUrl = `${origin}/registro`;

  if (options.onAuthorizeUrl) {
    options.onAuthorizeUrl(registerUrl);
  } else {
    console.log(`1. Creá tu cuenta con frase semilla de 12 palabras en Hilo Web:\n\n   ${registerUrl}\n`);
    console.log('   Guardá tus 12 palabras y activá el segundo factor para habilitar conexiones.\n');
    if (!options.noOpen) {
      openBrowser(registerUrl);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await rl.question('2. Cuando hayas creado tu cuenta, presioná Enter para vincular esta terminal por OAuth...');
    } finally {
      rl.close();
    }
  }

  return loginWithOAuth(options);
}

function serializeSkillMarkdown(name: string, description: string, content: string): string {
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${content}`;
}

function parseSkillMarkdown(raw: string): { name?: string; description?: string; content: string } {
  if (!raw.startsWith('---\n')) return { content: raw };
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return { content: raw };
  const header = raw.slice(4, end);
  const content = raw.slice(end + 5).replace(/^\n+/, '');
  let name: string | undefined;
  let description: string | undefined;
  for (const line of header.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) {
      try {
        v = String(JSON.parse(v));
      } catch {
        v = v.slice(1, -1);
      }
    }
    if (k === 'name') name = v;
    if (k === 'description') description = v;
  }
  return { name, description, content };
}

/**
 * Pushes local memories, docs, skills, and profile instructions to Hilo Cloud (/api/sync).
 */
export async function pushToCloud(
  storage: HiloStorage,
  rawConfig: CloudConfig,
  options: { prune?: boolean } = {},
): Promise<CloudPushResult> {
  const config = await ensureValidToken(rawConfig);
  const bundle = storage.loadContext();
  const memories = storage.listMemories({ limit: 100 });
  const docsMeta = storage.listDocs();

  const payloadDocs = [
    ...memories.map((m) => ({
      path: `memories/${m.name}.md`,
      kind: 'memory',
      memory_type: m.type,
      tema: m.tema,
      title: m.name,
      description: m.summary,
      content: m.content,
      pinned: m.pinned,
    })),
    ...docsMeta
      .map((meta) => storage.getDoc(meta.path))
      .filter((d): d is NonNullable<typeof d> => d !== null)
      .map((d) => ({
        path: d.path,
        kind: 'doc',
        tema: d.tema,
        title: d.title,
        content: d.content,
      })),
  ];

  const payloadSkills = storage
    .listSkills()
    .map((meta) => storage.getSkill(meta.name))
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .map((s) => ({
      path: `${s.name}/SKILL.md`,
      content: serializeSkillMarkdown(s.name, s.description, s.content),
    }));

  const res = await fetch(`${config.origin}/api/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({
      core_instructions: bundle.profile.instructions ?? undefined,
      docs: payloadDocs,
      skills: payloadSkills,
      prune: options.prune === true,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Error al subir a la nube (${res.status}): ${errText || res.statusText}`);
  }

  return (await res.json()) as CloudPushResult;
}

interface RemoteSyncDoc {
  path: string;
  kind?: string;
  memory_type?: string;
  tema?: string | null;
  title?: string;
  description?: string;
  content?: string;
  pinned?: boolean;
}

interface RemoteSyncSkill {
  name: string;
  description?: string;
  content?: string;
}

interface RemoteSyncResponse {
  profile?: string;
  core_instructions?: string;
  docs?: RemoteSyncDoc[];
  skills?: RemoteSyncSkill[];
}

/**
 * Pulls memories, docs, skills, and instructions from Hilo Cloud (GET /api/sync?full=1).
 */
export async function pullFromCloud(storage: HiloStorage, rawConfig: CloudConfig): Promise<CloudPullResult> {
  const config = await ensureValidToken(rawConfig);
  const res = await fetch(`${config.origin}/api/sync?full=1`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${config.token}`,
    },
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Error al descargar de la nube (${res.status}): ${errText || res.statusText}`);
  }

  const data = (await res.json()) as RemoteSyncResponse;
  const activeId = storage.getActiveProfileId();
  const current = storage.listProfiles().find((p) => p.id === activeId);

  if (typeof data.core_instructions === 'string') {
    storage.upsertProfile({
      id: activeId,
      name: current?.name ?? data.profile ?? activeId,
      instructions: data.core_instructions,
    });
  }

  let memories = 0;
  let docs = 0;
  for (const item of data.docs ?? []) {
    const content = item.content ?? '';
    const isMemory = item.kind === 'memory' || item.path.startsWith('memories/');
    if (isMemory) {
      const name = item.title || item.path.replace(/^memories\//, '').replace(/\.md$/, '');
      const memType = MEMORY_TYPES.includes(item.memory_type as MemoryType)
        ? (item.memory_type as MemoryType)
        : 'project';
      storage.saveMemory({
        name,
        type: memType,
        tema: item.tema ?? null,
        summary: item.description || content.split('\n')[0]?.slice(0, 120) || name,
        content,
        pinned: Boolean(item.pinned),
      });
      memories++;
    } else {
      storage.saveDoc({
        path: item.path,
        title: item.title || item.path,
        tema: item.tema ?? null,
        content,
      });
      docs++;
    }
  }

  let skills = 0;
  for (const sk of data.skills ?? []) {
    if (!sk.content && !sk.description) continue;
    const parsed = parseSkillMarkdown(sk.content ?? '');
    storage.saveSkill({
      name: sk.name || parsed.name || 'unnamed-skill',
      description: sk.description || parsed.description || sk.name,
      content: parsed.content,
    });
    skills++;
  }

  return {
    profile: data.profile ?? activeId,
    memories,
    docs,
    skills,
  };
}
