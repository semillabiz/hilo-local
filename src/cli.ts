#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { formatContextBundle } from './core/context.js';
import { createHiloMcpServer } from './core/mcp.js';
import { MEMORY_TYPES, type MemoryType } from './core/types.js';
import { SqliteHiloStorage } from './storage/sqlite.js';
import { exportToDirectory, importFromDirectory, importFromEngram } from './sync/git-sync.js';
import {
  DEFAULT_CLOUD_ORIGIN,
  clearCloudConfig,
  loadCloudConfig,
  loginWithOAuth,
  pullFromCloud,
  pushToCloud,
  saveCloudConfig,
} from './sync/cloud-sync.js';
import { runSetupWizard } from './setup/setup.js';
import { runTui } from './tui/tui.js';

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function printHelp(): void {
  console.log(`hilo-local — Memoria persistente, skills y docs local-first (MCP + SQLite FTS5 + Git)

Uso:
  hilo tui                                 Abre la interfaz interactiva en terminal (TUI)
  hilo setup [--all] [--dry-run]           Configura el MCP en Claude Code, Cursor, Antigravity, etc.
  hilo mcp                                 Inicia el servidor MCP por stdio
  hilo context [--tema <tema>]             Muestra el contexto cargado del perfil activo
  hilo save <nombre> --type <tipo> --summary <resumen> --content <texto> [--tema <tema>]
  hilo search <consulta> [--type <tipo>] [--tema <tema>]
  hilo get <nombre>                        Muestra una memoria completa
  hilo profile list                        Lista los perfiles locales
  hilo profile use <id> [--name <nombre>]  Cambia o crea el perfil activo
  hilo export [dir]                        Exporta memorias/skills/docs a Markdown (default: .hilo)
  hilo import [dir]                        Importa desde Markdown a SQLite (default: .hilo)
  hilo import-engram [dbPath]              Importa observaciones desde ~/.engram/engram.db
  hilo cloud login [--origin <url>] [--manual] [--no-open]   Inicia sesión con OAuth en navegador (o --token <token>)
  hilo cloud status                        Muestra la conexión cloud configurada
  hilo cloud logout                        Elimina las credenciales locales
  hilo cloud pull                          Descarga memorias, docs y skills desde Hilo Cloud
  hilo cloud push [--prune]                Sube el perfil local a Hilo Cloud
  hilo cloud sync [--prune]                Sincroniza en ambas direcciones (pull + push)

Nube:
  ¿Querés usar tus memorias desde el celular, la web, Tapiz o en equipo?
  Conectate a https://hilomemory.app`);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'setup') {
    const { flags } = parseFlags(rest);
    await runSetupWizard({ all: flags.all === true, dryRun: flags['dry-run'] === true });
    return;
  }

  const storage = new SqliteHiloStorage();

  if (command === 'tui') {
    try {
      await runTui(storage);
    } finally {
      storage.close();
    }
    return;
  }

  if (command === 'mcp') {
    const server = createHiloMcpServer(storage);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  try {
    const { positional, flags } = parseFlags(rest);

    if (command === 'context') {
      const tema = typeof flags.tema === 'string' ? flags.tema : positional[0];
      const bundle = storage.loadContext(tema);
      console.log(formatContextBundle(bundle, tema));
      return;
    }

    if (command === 'save') {
      const name = positional[0];
      const type = flags.type as MemoryType;
      const summary = typeof flags.summary === 'string' ? flags.summary : '';
      const content = typeof flags.content === 'string' ? flags.content : summary;
      const tema = typeof flags.tema === 'string' ? flags.tema : null;
      if (!name || !MEMORY_TYPES.includes(type) || !summary) {
        console.error('Uso: hilo save <nombre> --type <user|feedback|project|reference> --summary <resumen> [--content <texto>] [--tema <tema>]');
        process.exitCode = 1;
        return;
      }
      const saved = storage.saveMemory({ name, type, tema, summary, content, pinned: flags.pinned === true });
      console.log(`Guardada "${saved.name}" (${saved.type}) en perfil "${saved.profileId}".`);
      return;
    }

    if (command === 'search') {
      const q = positional.join(' ');
      const type = typeof flags.type === 'string' ? (flags.type as MemoryType) : undefined;
      const tema = typeof flags.tema === 'string' ? flags.tema : undefined;
      const rows = storage.searchMemories({ q: q || undefined, type, tema });
      if (rows.length === 0) {
        console.log('Sin resultados.');
        return;
      }
      for (const m of rows) {
        console.log(`- [${m.type}] ${m.name}${m.tema ? ` (${m.tema})` : ''}: ${m.summary}`);
      }
      return;
    }

    if (command === 'get') {
      const name = positional[0];
      if (!name) {
        console.error('Uso: hilo get <nombre>');
        process.exitCode = 1;
        return;
      }
      const m = storage.getMemory(name);
      if (!m) {
        console.error(`Memoria "${name}" no encontrada.`);
        process.exitCode = 1;
        return;
      }
      console.log(`# ${m.name} (${m.type})\n${m.summary}\n\n${m.content}`);
      return;
    }

    if (command === 'profile') {
      const sub = positional[0];
      if (sub === 'list') {
        const active = storage.getActiveProfileId();
        for (const p of storage.listProfiles()) {
          console.log(`${p.id === active ? '*' : ' '} ${p.id} — ${p.name}`);
        }
        return;
      }
      if (sub === 'use' && positional[1]) {
        const id = positional[1];
        const exists = storage.listProfiles().some((p) => p.id === id);
        if (!exists) {
          storage.upsertProfile({ id, name: typeof flags.name === 'string' ? flags.name : id });
        }
        const active = storage.setActiveProfileId(id);
        console.log(`Perfil activo: ${active.id} (${active.name})`);
        return;
      }
      console.error('Uso: hilo profile list | hilo profile use <id>');
      process.exitCode = 1;
      return;
    }

    if (command === 'export') {
      const dir = positional[0] || '.hilo';
      const counts = exportToDirectory(storage, dir);
      console.log(`Exportado a ${dir}: ${counts.memories} memorias, ${counts.skills} skills, ${counts.docs} docs.`);
      return;
    }

    if (command === 'import') {
      const dir = positional[0] || '.hilo';
      const counts = importFromDirectory(storage, dir);
      console.log(`Importado desde ${dir}: ${counts.memories} memorias, ${counts.skills} skills, ${counts.docs} docs.`);
      return;
    }

    if (command === 'import-engram') {
      const count = importFromEngram(storage, positional[0]);
      console.log(`Importadas ${count} memorias desde Engram.`);
      return;
    }

    if (command === 'cloud') {
      const sub = positional[0];
      if (sub === 'login') {
        const token = typeof flags.token === 'string' ? flags.token : '';
        const origin = typeof flags.origin === 'string' ? flags.origin : DEFAULT_CLOUD_ORIGIN;
        if (token) {
          saveCloudConfig({ origin, token });
          console.log(`Sesión cloud guardada para ${origin}.`);
          return;
        }
        const cfg = await loginWithOAuth({
          origin,
          scope: flags.scope === 'read' ? 'read' : 'write',
          manual: flags.manual === true,
          noOpen: flags['no-open'] === true,
        });
        console.log(`Sesión OAuth iniciada en ${cfg.origin} (${cfg.scope ?? 'write'}).`);
        return;
      }
      if (sub === 'status') {
        const cfg = loadCloudConfig();
        console.log(cfg ? `Conectado a ${cfg.origin}` : 'Sin conexión cloud configurada.');
        return;
      }
      if (sub === 'logout') {
        const removed = clearCloudConfig();
        console.log(removed ? 'Credenciales cloud eliminadas.' : 'No había credenciales guardadas.');
        return;
      }

      const cfg = loadCloudConfig();
      if (!cfg) {
        console.error('No hay sesión cloud configurada. Ejecutá: hilo cloud login --token <token>');
        process.exitCode = 1;
        return;
      }

      if (sub === 'pull' || sub === 'sync') {
        const pulled = await pullFromCloud(storage, cfg);
        console.log(
          `Descargado (${pulled.profile}): ${pulled.memories} memorias, ${pulled.docs} docs, ${pulled.skills} skills.`,
        );
      }
      if (sub === 'push' || sub === 'sync') {
        const pushed = await pushToCloud(storage, cfg, { prune: flags.prune === true });
        console.log(
          `Subido a ${cfg.origin}: ${pushed.created} creados, ${pushed.updated} actualizados, ${pushed.unchanged} sin cambios, ${pushed.skills} skills.`,
        );
        if (pushed.rejected.length > 0) {
          console.warn('Rechazados:', pushed.rejected);
        }
      }
      if (!['pull', 'push', 'sync'].includes(sub ?? '')) {
        console.error('Uso: hilo cloud <login|status|logout|pull|push|sync>');
        process.exitCode = 1;
      }
      return;
    }

    console.error(`Comando desconocido: "${command}". Usá "hilo --help".`);
    process.exitCode = 1;
  } finally {
    storage.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
