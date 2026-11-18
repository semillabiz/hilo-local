import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatContextBundle } from './context.js';
import { MEMORY_TYPES, type HiloStorage } from './types.js';
import { loadCloudConfig, pullFromCloud, pushToCloud } from '../sync/cloud-sync.js';

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Registers Hilo's core local-first MCP tools against any HiloStorage adapter.
 */
export function createHiloMcpServer(storage: HiloStorage, version = '0.1.0'): McpServer {
  const server = new McpServer({
    name: 'hilo-local',
    version,
  });

  server.tool(
    'contexto_cargar',
    'Carga el contexto del perfil activo: instrucciones, memorias user y feedback completas, índice del resto, temas y skills.',
    {
      tema: z.string().optional().describe('Ámbito o proyecto en kebab-case para priorizar sus memorias.'),
    },
    async ({ tema }) => {
      const bundle = storage.loadContext(tema);
      return textResult(formatContextBundle(bundle, tema));
    },
  );

  server.tool(
    'memoria_buscar',
    'Busca memorias por texto completo (FTS5), tipo, tema o fecha. Devuelve extractos; usar memoria_obtener para el contenido completo.',
    {
      q: z.string().optional(),
      type: z.enum(MEMORY_TYPES).optional(),
      tema: z.string().optional(),
      since: z.string().optional().describe('Fecha ISO YYYY-MM-DD'),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (args) => {
      const rows = storage.searchMemories(args);
      if (rows.length === 0) return textResult('No se encontraron memorias.');
      const text = rows
        .map((m) => `### ${m.name} · ${m.type}${m.tema ? ` · ${m.tema}` : ''} · ${m.updatedAt.slice(0, 10)}\n${m.summary}\n→ memoria_obtener("${m.name}")`)
        .join('\n\n');
      return textResult(text);
    },
  );

  server.tool(
    'memoria_obtener',
    'Obtiene el contenido completo de una memoria por su nombre.',
    { name: z.string() },
    async ({ name }) => {
      const m = storage.getMemory(name);
      if (!m) return textResult(`Memoria "${name}" no encontrada.`);
      return textResult(`# ${m.name}\nTipo: ${m.type}${m.tema ? ` · Tema: ${m.tema}` : ''}\nResumen: ${m.summary}\n\n${m.content}`);
    },
  );

  server.tool(
    'memoria_listar',
    'Lista memorias del perfil activo con filtros opcionales.',
    {
      type: z.enum(MEMORY_TYPES).optional(),
      tema: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async (args) => {
      const rows = storage.listMemories(args);
      if (rows.length === 0) return textResult('Sin memorias registradas.');
      return textResult(rows.map((m) => `- **${m.name}** (${m.type}${m.tema ? `, ${m.tema}` : ''}) — ${m.summary}`).join('\n'));
    },
  );

  server.tool(
    'memoria_guardar',
    'Crea o actualiza una memoria persistente en el perfil activo.',
    {
      name: z.string().describe('Identificador en kebab-case (ej. "proyecto/decision-db")'),
      type: z.enum(MEMORY_TYPES),
      tema: z.string().optional().nullable(),
      summary: z.string().describe('Resumen corto en una línea'),
      content: z.string().describe('Contenido completo en Markdown'),
      pinned: z.boolean().optional(),
    },
    async (args) => {
      const saved = storage.saveMemory(args);
      return textResult(`Memoria guardada: "${saved.name}" (${saved.type}) en perfil "${saved.profileId}".`);
    },
  );

  server.tool(
    'memoria_borrar',
    'Elimina una memoria del perfil activo.',
    { name: z.string() },
    async ({ name }) => {
      const ok = storage.deleteMemory(name);
      return textResult(ok ? `Memoria "${name}" eliminada.` : `Memoria "${name}" no encontrada.`);
    },
  );

  server.tool('skill_listar', 'Lista las skills disponibles en el perfil activo.', {}, async () => {
    const skills = storage.listSkills();
    if (skills.length === 0) return textResult('No hay skills guardadas.');
    return textResult(skills.map((s) => `- **${s.name}** — ${s.description}`).join('\n'));
  });

  server.tool(
    'skill_obtener',
    'Lee el contenido completo de una skill.',
    { name: z.string() },
    async ({ name }) => {
      const s = storage.getSkill(name);
      if (!s) return textResult(`Skill "${name}" no encontrada.`);
      return textResult(`# ${s.name}\n_${s.description}_\n\n${s.content}`);
    },
  );

  server.tool(
    'skill_guardar',
    'Crea o actualiza una skill reutilizable.',
    {
      name: z.string(),
      description: z.string(),
      content: z.string(),
    },
    async (args) => {
      const saved = storage.saveSkill(args);
      return textResult(`Skill guardada: "${saved.name}".`);
    },
  );

  server.tool(
    'skill_borrar',
    'Elimina una skill del perfil activo.',
    { name: z.string() },
    async ({ name }) => {
      const ok = storage.deleteSkill(name);
      return textResult(ok ? `Skill "${name}" eliminada.` : `Skill "${name}" no encontrada.`);
    },
  );

  server.tool(
    'doc_buscar',
    'Busca documentos técnicos por texto o tema.',
    {
      q: z.string().optional(),
      tema: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (args) => {
      const docs = storage.searchDocs(args);
      if (docs.length === 0) return textResult('No se encontraron documentos.');
      return textResult(docs.map((d) => `- **${d.path}** — ${d.title}${d.tema ? ` [${d.tema}]` : ''}`).join('\n'));
    },
  );

  server.tool(
    'doc_listar',
    'Lista documentos del perfil activo.',
    { tema: z.string().optional() },
    async ({ tema }) => {
      const docs = storage.listDocs(tema);
      if (docs.length === 0) return textResult('No hay documentos.');
      return textResult(docs.map((d) => `- **${d.path}** — ${d.title}${d.tema ? ` [${d.tema}]` : ''}`).join('\n'));
    },
  );

  server.tool(
    'doc_obtener',
    'Lee un documento completo por su path.',
    { path: z.string() },
    async ({ path }) => {
      const doc = storage.getDoc(path);
      if (!doc) return textResult(`Documento "${path}" no encontrado.`);
      return textResult(`# ${doc.title}\nPath: ${doc.path}\n\n${doc.content}`);
    },
  );

  server.tool(
    'doc_guardar',
    'Crea o actualiza un documento técnico.',
    {
      path: z.string(),
      title: z.string(),
      tema: z.string().optional().nullable(),
      content: z.string(),
    },
    async (args) => {
      const saved = storage.saveDoc(args);
      return textResult(`Documento guardado: "${saved.path}".`);
    },
  );

  server.tool(
    'doc_borrar',
    'Elimina un documento por su path.',
    { path: z.string() },
    async ({ path }) => {
      const ok = storage.deleteDoc(path);
      return textResult(ok ? `Documento "${path}" eliminado.` : `Documento "${path}" no encontrado.`);
    },
  );

  server.tool(
    'historial_buscar',
    'Busca en la bitácora histórica de decisiones y eventos.',
    {
      q: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (args) => {
      const entries = storage.searchHistory(args);
      if (entries.length === 0) return textResult('Sin entradas en el historial.');
      return textResult(
        entries
          .map((e) => `- **${e.createdAt.slice(0, 10)} · ${e.title}**${e.tags.length ? ` [${e.tags.join(', ')}]` : ''}\n  ${e.summary}`)
          .join('\n'),
      );
    },
  );

  server.tool(
    'historial_registrar',
    'Registra una decisión o evento en el historial.',
    {
      title: z.string(),
      summary: z.string(),
      tags: z.array(z.string()).optional(),
      tema: z.string().optional().nullable(),
    },
    async (args) => {
      const entry = storage.logHistory(args);
      return textResult(`Registrado en historial: "${entry.title}" (${entry.createdAt.slice(0, 10)}).`);
    },
  );

  server.tool('perfil_listar', 'Lista los perfiles locales aislados.', {}, async () => {
    const active = storage.getActiveProfileId();
    const profiles = storage.listProfiles();
    return textResult(
      profiles.map((p) => `- ${p.id === active ? '**[activo]** ' : ''}**${p.id}** (${p.name})${p.description ? ` — ${p.description}` : ''}`).join('\n'),
    );
  });

  server.tool(
    'perfil_cambiar',
    'Cambia el perfil local activo (aislamiento de contextos).',
    {
      profileId: z.string(),
      name: z.string().optional().describe('Nombre si el perfil es nuevo'),
    },
    async ({ profileId, name }) => {
      const exists = storage.listProfiles().some((p) => p.id === profileId);
      if (!exists) {
        storage.upsertProfile({ id: profileId, name: name ?? profileId });
      }
      const active = storage.setActiveProfileId(profileId);
      return textResult(`Perfil activo cambiado a "${active.id}" (${active.name}).`);
    },
  );

  server.tool(
    'nube_sincronizar',
    'Sincroniza el perfil local con una cuenta de Hilo Cloud (hilomemory.app) si hay credenciales configuradas.',
    {
      direction: z.enum(['push', 'pull', 'both']).default('both'),
      prune: z.boolean().optional().describe('Si true en push, elimina en la nube lo que no esté en local.'),
    },
    async ({ direction, prune }) => {
      const config = loadCloudConfig();
      if (!config) {
        return textResult('No hay sesión en la nube configurada. Ejecutá: hilo cloud login --token <tu-token>');
      }
      const parts: string[] = [];
      if (direction === 'pull' || direction === 'both') {
        const pulled = await pullFromCloud(storage, config);
        parts.push(`Descargado (${pulled.profile}): ${pulled.memories} memorias, ${pulled.docs} docs, ${pulled.skills} skills.`);
      }
      if (direction === 'push' || direction === 'both') {
        const pushed = await pushToCloud(storage, config, { prune });
        parts.push(
          `Subido a ${config.origin}: ${pushed.created} creados, ${pushed.updated} actualizados, ${pushed.unchanged} sin cambios, ${pushed.skills} skills.`,
        );
      }
      return textResult(parts.join('\n'));
    },
  );

  return server;
}
