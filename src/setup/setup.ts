import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';

export interface McpTarget {
  id: string;
  label: string;
  configPath: string;
  detected: boolean;
  format: 'mcpServers' | 'opencode';
}

export interface SetupResult {
  target: McpTarget;
  status: 'configured' | 'already-configured' | 'dry-run' | 'error';
  error?: string;
}

/**
 * Returns known AI coding agent MCP configuration targets on this machine.
 */
export function detectMcpTargets(home = homedir()): McpTarget[] {
  const candidates: Omit<McpTarget, 'detected'>[] = [
    {
      id: 'claude-code',
      label: 'Claude Code',
      configPath: join(home, '.claude.json'),
      format: 'mcpServers',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      configPath: join(home, '.cursor', 'mcp.json'),
      format: 'mcpServers',
    },
    {
      id: 'antigravity',
      label: 'Antigravity',
      configPath: join(home, '.gemini', 'antigravity', 'mcp_config.json'),
      format: 'mcpServers',
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      configPath: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      format: 'mcpServers',
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      configPath: join(home, '.config', 'opencode', 'opencode.json'),
      format: 'opencode',
    },
  ];

  return candidates.map((c) => ({
    ...c,
    detected: existsSync(c.configPath) || existsSync(dirname(c.configPath)),
  }));
}

/**
 * Safely injects the `hilo-local` MCP server into a client's JSON config without clobbering existing entries.
 */
export function applyMcpConfig(
  target: McpTarget,
  options: { dryRun?: boolean; command?: string; args?: string[] } = {},
): SetupResult {
  const command = options.command ?? 'hilo';
  const args = options.args ?? ['mcp'];

  try {
    let json: Record<string, unknown> = {};
    if (existsSync(target.configPath)) {
      const raw = readFileSync(target.configPath, 'utf8').trim();
      if (raw) {
        json = JSON.parse(raw) as Record<string, unknown>;
      }
    }

    if (target.format === 'opencode') {
      const mcp = (typeof json.mcp === 'object' && json.mcp !== null ? json.mcp : {}) as Record<string, unknown>;
      if (mcp['hilo-local']) {
        return { target, status: 'already-configured' };
      }
      if (options.dryRun) {
        return { target, status: 'dry-run' };
      }
      mcp['hilo-local'] = {
        type: 'local',
        command: [command, ...args],
        enabled: true,
      };
      json.mcp = mcp;
    } else {
      const servers = (
        typeof json.mcpServers === 'object' && json.mcpServers !== null ? json.mcpServers : {}
      ) as Record<string, unknown>;
      if (servers['hilo-local']) {
        return { target, status: 'already-configured' };
      }
      if (options.dryRun) {
        return { target, status: 'dry-run' };
      }
      servers['hilo-local'] = { command, args };
      json.mcpServers = servers;
    }

    mkdirSync(dirname(target.configPath), { recursive: true });
    writeFileSync(target.configPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
    return { target, status: 'configured' };
  } catch (err) {
    return {
      target,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Interactive setup wizard for configuring Hilo Local across detected AI agents.
 */
export async function runSetupWizard(options: { all?: boolean; dryRun?: boolean; home?: string } = {}): Promise<void> {
  const targets = detectMcpTargets(options.home);
  const detected = targets.filter((t) => t.detected);

  console.log('\nHilo Local — Asistente de configuración MCP\n');

  if (detected.length === 0) {
    console.log('No se detectaron clientes MCP instalados en las rutas estándar.');
    console.log('Podés agregar manualmente en tu mcp.json:\n');
    console.log(JSON.stringify({ mcpServers: { 'hilo-local': { command: 'hilo', args: ['mcp'] } } }, null, 2));
    return;
  }

  let selected: McpTarget[] = detected;
  if (!options.all) {
    console.log('Clientes detectados:');
    detected.forEach((t, i) => {
      console.log(`  [${i + 1}] ${t.label} (${t.configPath})`);
    });
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question('\n¿Cuáles querés configurar? (Enter = todos, o números separados por coma, ej. 1,2): ')).trim();
      if (answer) {
        const indices = new Set(
          answer
            .split(',')
            .map((s) => Number.parseInt(s.trim(), 10) - 1)
            .filter((n) => !Number.isNaN(n) && n >= 0 && n < detected.length),
        );
        selected = detected.filter((_, i) => indices.has(i));
      }
    } finally {
      rl.close();
    }
  }

  if (selected.length === 0) {
    console.log('No se seleccionó ningún cliente.');
    return;
  }

  console.log('');
  for (const target of selected) {
    const res = applyMcpConfig(target, { dryRun: options.dryRun });
    if (res.status === 'configured') {
      console.log(`✔ ${target.label}: configurado en ${target.configPath}`);
    } else if (res.status === 'already-configured') {
      console.log(`• ${target.label}: ya tenía hilo-local configurado`);
    } else if (res.status === 'dry-run') {
      console.log(`[simulación] ${target.label}: se escribiría en ${target.configPath}`);
    } else {
      console.error(`✗ ${target.label}: ${res.error}`);
    }
  }
  console.log('\nListo. Reiniciá tu editor o agente para cargar las tools de Hilo Local.');
}
