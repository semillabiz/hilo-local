import type { ContextBundle, Memory } from './types.js';

function formatMemoryBlock(memory: Memory): string {
  const tags = [memory.type, memory.tema ? `tema: ${memory.tema}` : null, memory.pinned ? 'fijada' : null]
    .filter(Boolean)
    .join(' · ');
  return `### ${memory.name} · ${tags}\n_${memory.summary}_\n\n${memory.content}`;
}

/**
 * Formats a ContextBundle into the Markdown prompt block returned by `contexto_cargar`.
 */
export function formatContextBundle(bundle: ContextBundle, tema?: string): string {
  const lines: string[] = [`# Contexto del perfil "${bundle.profile.name}"`];

  if (bundle.profile.description) {
    lines.push('', `_${bundle.profile.description}_`);
  }

  if (bundle.profile.instructions) {
    lines.push('', '## Instrucciones', '', bundle.profile.instructions);
  }

  if (bundle.userAndFeedback.length > 0) {
    lines.push('', '## Memorias sobre el usuario y cómo trabaja');
    for (const m of bundle.userAndFeedback) {
      lines.push('', formatMemoryBlock(m));
    }
  }

  if (bundle.indexedMemories.length > 0) {
    const header = tema ? `## Memorias del tema "${tema}"` : '## Otras memorias (índice)';
    lines.push('', header, '_Para leer una completa, llamá `memoria_obtener(name)`._', '');
    for (const m of bundle.indexedMemories) {
      const temaLabel = m.tema ? ` [${m.tema}]` : '';
      lines.push(`- **${m.name}** · ${m.type}${temaLabel} — ${m.summary}`);
    }
  }

  if (bundle.temas.length > 0) {
    lines.push('', '## Temas', bundle.temas.map((t) => `${t.tema} (${t.count})`).join(', '));
  }

  if (bundle.skills.length > 0) {
    lines.push('', '## Skills disponibles (leer con `skill_obtener`)', '');
    for (const s of bundle.skills) {
      lines.push(`- **${s.name}** — ${s.description}`);
    }
  }

  if (bundle.historyCount > 0) {
    lines.push('', '## Historial', `Hay ${bundle.historyCount} entradas registradas. Consultalas con \`historial_buscar\`.`);
  }

  return lines.join('\n');
}
