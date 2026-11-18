import { emitKeypressEvents, type Key } from 'node:readline';
import type { HiloStorage } from '../core/types.js';

export type TuiTab = 'memories' | 'skills' | 'docs' | 'history' | 'profiles';

export const TUI_TABS: { id: TuiTab; label: string; key: string }[] = [
  { id: 'memories', label: 'Memorias', key: '1' },
  { id: 'skills', label: 'Skills', key: '2' },
  { id: 'docs', label: 'Docs', key: '3' },
  { id: 'history', label: 'Historial', key: '4' },
  { id: 'profiles', label: 'Perfiles', key: '5' },
];

export interface TuiItem {
  id: string;
  title: string;
  subtitle: string;
  body: string;
}

const ANSI = {
  enterAlt: '\x1b[?1049h',
  exitAlt: '\x1b[?1049l',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clear: '\x1b[2J\x1b[H',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  invert: '\x1b[7m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

function truncate(text: string, max: number): string {
  if (max <= 1) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function wrapLines(text: string, width: number): string[] {
  const safeWidth = Math.max(12, width);
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.length <= safeWidth) {
      out.push(rawLine);
      continue;
    }
    let rest = rawLine;
    while (rest.length > safeWidth) {
      out.push(rest.slice(0, safeWidth));
      rest = rest.slice(safeWidth);
    }
    if (rest) out.push(rest);
  }
  return out;
}

/**
 * Queries the active HiloStorage for the current tab and search query.
 */
export function buildTuiItems(storage: HiloStorage, tab: TuiTab, query: string): TuiItem[] {
  const q = query.trim();
  const qLower = q.toLowerCase();

  if (tab === 'memories') {
    const rows = q ? storage.searchMemories({ q, limit: 50 }) : storage.listMemories({ limit: 50 });
    return rows.map((m) => ({
      id: m.name,
      title: m.name,
      subtitle: `${m.type}${m.tema ? ` · ${m.tema}` : ''}`,
      body: `Tipo: ${m.type}${m.tema ? `  ·  Tema: ${m.tema}` : ''}${m.pinned ? '  ·  Fijada' : ''}\nActualizada: ${m.updatedAt.slice(0, 10)}\n\nResumen:\n${m.summary}\n\nContenido:\n${m.content}`,
    }));
  }

  if (tab === 'skills') {
    const all = storage.listSkills();
    const filtered = qLower
      ? all.filter((s) => s.name.toLowerCase().includes(qLower) || s.description.toLowerCase().includes(qLower))
      : all;
    return filtered.map((s) => {
      const full = storage.getSkill(s.name);
      return {
        id: s.name,
        title: s.name,
        subtitle: s.description,
        body: `Skill: ${s.name}\nActualizada: ${s.updatedAt.slice(0, 10)}\n\nDescripción:\n${s.description}\n\nContenido:\n${full?.content ?? ''}`,
      };
    });
  }

  if (tab === 'docs') {
    const rows = q ? storage.searchDocs({ q, limit: 50 }) : storage.listDocs();
    return rows.map((d) => {
      const full = 'content' in d ? d : storage.getDoc(d.path);
      return {
        id: d.path,
        title: d.title,
        subtitle: d.path,
        body: `Path: ${d.path}${d.tema ? `  ·  Tema: ${d.tema}` : ''}\nActualizado: ${d.updatedAt.slice(0, 10)}\n\n${full?.content ?? ''}`,
      };
    });
  }

  if (tab === 'history') {
    const rows = storage.searchHistory({ q: q || undefined, limit: 50 });
    return rows.map((h) => ({
      id: h.id,
      title: h.title,
      subtitle: h.createdAt.slice(0, 10),
      body: `Fecha: ${h.createdAt.slice(0, 10)}${h.tema ? `  ·  Tema: ${h.tema}` : ''}\nTags: ${h.tags.join(', ') || '—'}\n\n${h.summary}`,
    }));
  }

  const activeId = storage.getActiveProfileId();
  const profiles = storage.listProfiles().filter((p) =>
    qLower ? p.id.toLowerCase().includes(qLower) || p.name.toLowerCase().includes(qLower) : true,
  );
  return profiles.map((p) => ({
    id: p.id,
    title: `${p.id === activeId ? '● ' : '○ '}${p.name}`,
    subtitle: p.id,
    body: `ID: ${p.id}\nNombre: ${p.name}\nEstado: ${p.id === activeId ? 'Activo' : 'Inactivo (Enter para activar)'}\nDescripción: ${p.description ?? '—'}\n\nInstrucciones:\n${p.instructions ?? '(sin instrucciones globales)'}`,
  }));
}

export interface TuiState {
  tab: TuiTab;
  selectedIndex: number;
  searchMode: boolean;
  query: string;
  statusMessage: string;
}

/**
 * Renders the full split-pane TUI frame as a string.
 */
export function renderTuiFrame(
  storage: HiloStorage,
  state: TuiState,
  cols = process.stdout.columns || 100,
  rows = process.stdout.rows || 28,
): string {
  const activeProfile = storage.getActiveProfileId();
  const items = buildTuiItems(storage, state.tab, state.query);
  const clampedIdx = Math.max(0, Math.min(state.selectedIndex, Math.max(0, items.length - 1)));
  const selected = items[clampedIdx];

  const tabBar = TUI_TABS.map((t) =>
    t.id === state.tab ? `${ANSI.invert} [${t.key}] ${t.label} ${ANSI.reset}` : ` ${ANSI.dim}[${t.key}] ${t.label}${ANSI.reset} `,
  ).join(' ');

  const header = `${ANSI.bold}${ANSI.cyan}Hilo Local${ANSI.reset}  ${ANSI.dim}Perfil:${ANSI.reset} ${ANSI.green}${activeProfile}${ANSI.reset}  ${state.query ? `${ANSI.yellow}Filtro: "${state.query}"${ANSI.reset}` : ''}`;

  const bodyHeight = Math.max(6, rows - 6);
  const leftWidth = Math.max(24, Math.floor(cols * 0.36));
  const rightWidth = Math.max(24, cols - leftWidth - 3);

  const startOffset = Math.max(0, clampedIdx - Math.floor(bodyHeight / 2));
  const visibleItems = items.slice(startOffset, startOffset + bodyHeight);
  const detailLines = selected
    ? wrapLines(selected.body, rightWidth)
    : ['Sin elementos para mostrar.', '', 'Usá `hilo save` o un agente MCP para guardar recuerdos.'];

  const lines: string[] = [header, tabBar, '─'.repeat(Math.max(20, cols))];

  for (let i = 0; i < bodyHeight; i++) {
    const item = visibleItems[i];
    const isSel = item && startOffset + i === clampedIdx;
    let leftCell = ' '.repeat(leftWidth);
    if (item) {
      const label = truncate(`${isSel ? '▸ ' : '  '}${item.title}`, leftWidth);
      const padded = label.padEnd(leftWidth, ' ');
      leftCell = isSel ? `${ANSI.invert}${padded}${ANSI.reset}` : padded;
    }

    const rightRaw = detailLines[i] ?? '';
    const rightCell = truncate(rightRaw, rightWidth).padEnd(rightWidth, ' ');
    lines.push(`${leftCell} │ ${rightCell}`);
  }

  lines.push('─'.repeat(Math.max(20, cols)));
  if (state.searchMode) {
    lines.push(`${ANSI.yellow}Buscar (/):${ANSI.reset} ${state.query}█  ${ANSI.dim}(Enter confirmar · Esc limpiar)${ANSI.reset}`);
  } else {
    const hints =
      state.tab === 'profiles'
        ? '↑↓ Navegar · Enter Activar perfil · 1-5/Tab Sección · / Buscar · q Salir'
        : '↑↓ Navegar · 1-5/Tab Sección · / Buscar · r Refrescar · q Salir';
    lines.push(`${ANSI.dim}${hints}${ANSI.reset}${state.statusMessage ? `  ${ANSI.green}${state.statusMessage}${ANSI.reset}` : ''}`);
  }

  return `${ANSI.clear}${lines.join('\n')}`;
}

/**
 * Starts the interactive terminal UI (TUI) on TTY stdin/stdout.
 */
export async function runTui(storage: HiloStorage): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('La TUI requiere una terminal interactiva (TTY).');
  }

  const state: TuiState = {
    tab: 'memories',
    selectedIndex: 0,
    searchMode: false,
    query: '',
    statusMessage: '',
  };

  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdout.write(ANSI.enterAlt + ANSI.hideCursor);

  const draw = () => {
    process.stdout.write(renderTuiFrame(storage, state));
  };

  return new Promise<void>((resolve) => {
    const cleanup = () => {
      process.stdin.off('keypress', onKeypress);
      process.stdout.off('resize', draw);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write(ANSI.showCursor + ANSI.exitAlt);
      resolve();
    };

    const onKeypress = (str: string, key: Key) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        return;
      }

      if (state.searchMode) {
        if (key.name === 'return') {
          state.searchMode = false;
          state.selectedIndex = 0;
        } else if (key.name === 'escape') {
          state.searchMode = false;
          state.query = '';
          state.selectedIndex = 0;
        } else if (key.name === 'backspace') {
          state.query = state.query.slice(0, -1);
          state.selectedIndex = 0;
        } else if (str && !key.ctrl && !key.meta && str.length === 1) {
          state.query += str;
          state.selectedIndex = 0;
        }
        draw();
        return;
      }

      state.statusMessage = '';
      const items = buildTuiItems(storage, state.tab, state.query);

      if (str === 'q' || key.name === 'escape') {
        cleanup();
        return;
      }
      if (str === '/') {
        state.searchMode = true;
        draw();
        return;
      }
      if (str === 'r') {
        state.statusMessage = 'Actualizado';
        draw();
        return;
      }
      if (key.name === 'up' || str === 'k') {
        state.selectedIndex = Math.max(0, state.selectedIndex - 1);
      } else if (key.name === 'down' || str === 'j') {
        state.selectedIndex = Math.min(Math.max(0, items.length - 1), state.selectedIndex + 1);
      } else if (key.name === 'tab' || key.name === 'right') {
        const idx = TUI_TABS.findIndex((t) => t.id === state.tab);
        state.tab = TUI_TABS[(idx + 1) % TUI_TABS.length].id;
        state.selectedIndex = 0;
      } else if (key.name === 'left') {
        const idx = TUI_TABS.findIndex((t) => t.id === state.tab);
        state.tab = TUI_TABS[(idx - 1 + TUI_TABS.length) % TUI_TABS.length].id;
        state.selectedIndex = 0;
      } else if (['1', '2', '3', '4', '5'].includes(str)) {
        const found = TUI_TABS.find((t) => t.key === str);
        if (found) {
          state.tab = found.id;
          state.selectedIndex = 0;
        }
      } else if (key.name === 'return' && state.tab === 'profiles') {
        const sel = items[state.selectedIndex];
        if (sel) {
          storage.setActiveProfileId(sel.id);
          state.statusMessage = `Perfil activo: ${sel.id}`;
        }
      }
      draw();
    };

    process.stdin.on('keypress', onKeypress);
    process.stdout.on('resize', draw);
    draw();
  });
}
