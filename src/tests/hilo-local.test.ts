import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { formatContextBundle } from '../core/context.js';
import { createHiloMcpServer } from '../core/mcp.js';
import { SqliteHiloStorage } from '../storage/sqlite.js';
import { exportToDirectory, importFromDirectory, importFromEngram } from '../sync/git-sync.js';
import { pullFromCloud, pushToCloud, loginWithOAuth, ensureValidToken } from '../sync/cloud-sync.js';
import { applyMcpConfig, detectMcpTargets } from '../setup/setup.js';
import { buildTuiItems, renderTuiFrame } from '../tui/tui.js';

test('SqliteHiloStorage: memories, FTS5 search, skills, docs, history and context bundle', () => {
  const storage = new SqliteHiloStorage(':memory:');
  try {
    storage.saveMemory({
      name: 'preferencia-idioma',
      type: 'feedback',
      summary: 'Responder siempre en castellano rioplatense',
      content: 'Usar voseo y tono directo.',
      pinned: true,
    });
    storage.saveMemory({
      name: 'arq-base',
      type: 'project',
      tema: 'hilo',
      summary: 'Motor SQLite + FTS5 local',
      content: 'Usa node:sqlite integrado en Node 24.',
    });
    storage.saveSkill({
      name: 'deploy-seguro',
      description: 'Pasos de verificación antes de deploy',
      content: '1. Correr tests\n2. Verificar migraciones',
    });
    storage.saveDoc({
      path: 'docs/arquitectura.md',
      title: 'Arquitectura Local',
      tema: 'hilo',
      content: 'Detalle de tablas y FTS5.',
    });
    storage.logHistory({
      title: 'Lanzamiento v0.1',
      summary: 'Primera versión open source local',
      tags: ['release', 'oss'],
      tema: 'hilo',
    });

    const found = storage.searchMemories({ q: 'SQLite' });
    assert.equal(found.length, 1);
    assert.equal(found[0].name, 'arq-base');

    const docs = storage.searchDocs({ q: 'tablas' });
    assert.equal(docs.length, 1);
    assert.equal(docs[0].path, 'docs/arquitectura.md');

    const hist = storage.searchHistory({ q: 'open source' });
    assert.equal(hist.length, 1);
    assert.deepEqual(hist[0].tags, ['release', 'oss']);

    const bundle = storage.loadContext('hilo');
    assert.equal(bundle.userAndFeedback.length, 1);
    assert.equal(bundle.indexedMemories.length, 1);
    assert.equal(bundle.skills.length, 1);
    assert.equal(bundle.historyCount, 1);

    const formatted = formatContextBundle(bundle, 'hilo');
    assert.match(formatted, /preferencia-idioma/);
    assert.match(formatted, /deploy-seguro/);
  } finally {
    storage.close();
  }
});

test('Profile isolation keeps memories separated', () => {
  const storage = new SqliteHiloStorage(':memory:');
  try {
    storage.saveMemory({
      name: 'secreto-personal',
      type: 'user',
      summary: 'Nota personal',
      content: 'Solo perfil default',
    });
    storage.upsertProfile({ id: 'trabajo', name: 'Trabajo' });
    storage.setActiveProfileId('trabajo');

    assert.equal(storage.listMemories({}).length, 0);
    storage.saveMemory({
      name: 'regla-trabajo',
      type: 'feedback',
      summary: 'Regla de trabajo',
      content: 'Solo perfil trabajo',
    });

    assert.equal(storage.listMemories({}).length, 1);
    storage.setActiveProfileId('default');
    assert.equal(storage.getMemory('regla-trabajo'), null);
    assert.ok(storage.getMemory('secreto-personal'));
  } finally {
    storage.close();
  }
});

test('Git-friendly Markdown export & import roundtrip + Engram migration + MCP server init', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hilo-local-test-'));
  const src = new SqliteHiloStorage(':memory:');
  const dst = new SqliteHiloStorage(':memory:');
  try {
    src.saveMemory({
      name: 'decision/api',
      type: 'project',
      tema: 'backend',
      summary: 'Usar MCP stdio',
      content: 'Transporte estándar para agentes locales.',
    });
    src.saveSkill({
      name: 'revisar-pr',
      description: 'Checklist de PR',
      content: 'Revisar tests y tipos.',
    });
    src.saveDoc({
      path: 'guia/inicio.md',
      title: 'Guía de inicio',
      tema: 'backend',
      content: 'Ejecutar hilo mcp.',
    });

    const syncDir = join(dir, '.hilo');
    const exported = exportToDirectory(src, syncDir);
    assert.deepEqual(exported, { memories: 1, skills: 1, docs: 1 });

    const imported = importFromDirectory(dst, syncDir);
    assert.deepEqual(imported, { memories: 1, skills: 1, docs: 1 });
    assert.equal(dst.getMemory('decision/api')?.tema, 'backend');
    assert.equal(dst.getSkill('revisar-pr')?.description, 'Checklist de PR');
    assert.equal(dst.getDoc('guia/inicio.md')?.title, 'Guía de inicio');

    // Simulate an Engram SQLite DB and import from it
    const engramPath = join(dir, 'engram.db');
    const engramDb = new DatabaseSync(engramPath);
    engramDb.exec(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY,
        title TEXT,
        content TEXT,
        type TEXT,
        project TEXT,
        created_at TEXT
      );
      INSERT INTO observations (title, content, type, project, created_at)
      VALUES ('Usar WAL en SQLite', 'Mejora concurrencia de lectura', 'decision', 'core', '2026-11-01T00:00:00Z');
    `);
    engramDb.close();

    const migratedCount = importFromEngram(dst, engramPath);
    assert.equal(migratedCount, 1);
    assert.ok(dst.getMemory('engram/usar-wal-en-sqlite'));

    const mcp = createHiloMcpServer(dst);
    assert.ok(mcp);
  } finally {
    src.close();
    dst.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Cloud sync push & pull against /api/sync contract', async () => {
  let storedPayload: { core_instructions?: string; docs?: unknown[]; skills?: unknown[] } = {};

  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-token');
    if (req.method === 'POST' && req.url === '/api/sync') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        storedPayload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            created: storedPayload.docs?.length ?? 0,
            updated: 0,
            unchanged: 0,
            deleted: 0,
            skills: storedPayload.skills?.length ?? 0,
            rejected: [],
          }),
        );
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/sync?full=1') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          profile: 'lautaro',
          core_instructions: storedPayload.core_instructions ?? '',
          docs: storedPayload.docs ?? [],
          skills: [
            {
              name: 'cloud-skill',
              description: 'Skill bajada de la nube',
              content: '---\nname: "cloud-skill"\ndescription: "Skill bajada de la nube"\n---\n\nContenido cloud',
            },
          ],
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  const localA = new SqliteHiloStorage(':memory:');
  const localB = new SqliteHiloStorage(':memory:');
  try {
    localA.upsertProfile({ id: 'default', name: 'Personal', instructions: 'Regla global cloud' });
    localA.saveMemory({
      name: 'cloud-mem',
      type: 'feedback',
      tema: 'hilo',
      summary: 'Preferencia sincronizada',
      content: 'Detalle de preferencia.',
      pinned: true,
    });
    localA.saveDoc({
      path: 'specs/sync.md',
      title: 'Spec Sync',
      tema: 'hilo',
      content: 'Protocolo /api/sync',
    });

    const pushRes = await pushToCloud(localA, { origin, token: 'test-token' });
    assert.equal(pushRes.created, 2);

    const pullRes = await pullFromCloud(localB, { origin, token: 'test-token' });
    assert.equal(pullRes.memories, 1);
    assert.equal(pullRes.docs, 1);
    assert.equal(pullRes.skills, 1);

    assert.equal(localB.getMemory('cloud-mem')?.summary, 'Preferencia sincronizada');
    assert.equal(localB.getDoc('specs/sync.md')?.title, 'Spec Sync');
    assert.equal(localB.getSkill('cloud-skill')?.description, 'Skill bajada de la nube');
    assert.equal(localB.loadContext().profile.instructions, 'Regla global cloud');
  } finally {
    localA.close();
    localB.close();
    server.closeAllConnections();
    server.close();
  }
});

test('OAuth PKCE loopback login and refresh_token renewal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hilo-oauth-test-'));
  const prevConfigPath = process.env.HILO_CLOUD_CONFIG_PATH;
  process.env.HILO_CLOUD_CONFIG_PATH = join(dir, 'cloud.json');

  let refreshCount = 0;
  const oauthServer = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/oauth/register') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ client_id: 'cli_test_123' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/oauth/token') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const grant = params.get('grant_type');
        if (grant === 'authorization_code') {
          assert.equal(params.get('client_id'), 'cli_test_123');
          assert.equal(params.get('code'), 'auth_code_ok');
          assert.ok(params.get('code_verifier'));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'tok_initial',
              refresh_token: 'ref_initial',
              expires_in: 3600,
              scope: 'write',
            }),
          );
          return;
        }
        if (grant === 'refresh_token') {
          refreshCount++;
          assert.equal(params.get('refresh_token'), 'ref_initial');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'tok_refreshed',
              refresh_token: 'ref_next',
              expires_in: 3600,
              scope: 'write',
            }),
          );
          return;
        }
      });
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => oauthServer.listen(0, '127.0.0.1', resolve));
  const addr = oauthServer.address();
  assert.ok(addr && typeof addr === 'object');
  const origin = `http://127.0.0.1:${addr.port}`;

  try {
    const config = await loginWithOAuth({
      origin,
      noOpen: true,
      onAuthorizeUrl: (urlStr) => {
        const u = new URL(urlStr);
        const redirectUri = u.searchParams.get('redirect_uri')!;
        const state = u.searchParams.get('state')!;
        void fetch(`${redirectUri}?code=auth_code_ok&state=${encodeURIComponent(state)}`);
      },
    });

    assert.equal(config.token, 'tok_initial');
    assert.equal(config.refreshToken, 'ref_initial');
    assert.equal(config.clientId, 'cli_test_123');

    const renewed = await ensureValidToken({ ...config, expiresAt: Date.now() - 10_000 });
    assert.equal(refreshCount, 1);
    assert.equal(renewed.token, 'tok_refreshed');
    assert.equal(renewed.refreshToken, 'ref_next');
  } finally {
    if (prevConfigPath === undefined) delete process.env.HILO_CLOUD_CONFIG_PATH;
    else process.env.HILO_CLOUD_CONFIG_PATH = prevConfigPath;
    oauthServer.closeAllConnections();
    oauthServer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Setup wizard detects MCP clients and injects hilo-local without clobbering existing servers', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'hilo-setup-test-'));
  try {
    mkdirSync(join(fakeHome, '.cursor'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'npx', args: ['other'] } } }, null, 2),
      'utf8',
    );

    const targets = detectMcpTargets(fakeHome);
    const cursor = targets.find((t) => t.id === 'cursor');
    assert.ok(cursor && cursor.detected);

    const res1 = applyMcpConfig(cursor);
    assert.equal(res1.status, 'configured');

    const updated = JSON.parse(readFileSync(cursor.configPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    assert.ok(updated.mcpServers.other);
    assert.deepEqual(updated.mcpServers['hilo-local'], { command: 'hilo', args: ['mcp'] });

    const res2 = applyMcpConfig(cursor);
    assert.equal(res2.status, 'already-configured');
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('TUI builds items across tabs and renders split-pane frame', () => {
  const storage = new SqliteHiloStorage(':memory:');
  try {
    storage.saveMemory({
      name: 'tui-mem',
      type: 'project',
      tema: 'ui',
      summary: 'Resumen TUI',
      content: 'Contenido detallado en TUI.',
    });
    storage.saveSkill({
      name: 'tui-skill',
      description: 'Skill de prueba',
      content: 'Pasos de la skill.',
    });

    const memItems = buildTuiItems(storage, 'memories', 'Resumen');
    assert.equal(memItems.length, 1);
    assert.equal(memItems[0].title, 'tui-mem');

    const skillItems = buildTuiItems(storage, 'skills', '');
    assert.equal(skillItems.length, 1);

    const frame = renderTuiFrame(
      storage,
      { tab: 'memories', selectedIndex: 0, searchMode: false, query: '', statusMessage: '' },
      90,
      20,
    );
    assert.match(frame, /Hilo Local/);
    assert.match(frame, /tui-mem/);
    assert.match(frame, /Contenido detallado en TUI/);
  } finally {
    storage.close();
  }
});
