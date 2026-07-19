import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { resolveInside } from './pathGuard.js';
import type { PermissionGate } from './permissions.js';

/**
 * The agent's tools (OpenAI function-calling format) and their executors.
 * File tools are confined to the current working folder by pathGuard; risky
 * ones go through the PermissionGate. Every executor returns a STRING that is
 * fed back to the model as the tool result (errors included, so the model can
 * react instead of the turn dying).
 */

const READ_CAP = 50_000; // chars of file content sent to the model
const OUT_CAP = 20_000; // chars of command output sent to the model

export interface AgentContext {
  getCwd(): string;
  setCwd(dir: string): void;
  gate: PermissionGate;
}

export const AGENT_TOOLS = [
  tool('read_file', 'Lee un archivo de texto y devuelve su contenido. Dentro de la carpeta de trabajo es libre; una ruta absoluta fuera pide aprobación al usuario.', {
    path: { type: 'string', description: 'Ruta relativa a la carpeta de trabajo, o absoluta (ej. C:\\Users\\...\\archivo.txt).' },
  }),
  tool('list_directory', 'Lista los archivos y subcarpetas de un directorio. Dentro de la carpeta de trabajo es libre; una ruta absoluta fuera pide aprobación al usuario.', {
    path: { type: 'string', description: 'Ruta relativa (omite o "." para la carpeta de trabajo) o absoluta.' },
  }, []),
  tool('write_file', 'Crea o sobrescribe un archivo dentro de la carpeta de trabajo (crea las carpetas intermedias).', {
    path: { type: 'string', description: 'Ruta del archivo, relativa a la carpeta de trabajo.' },
    content: { type: 'string', description: 'Contenido completo del archivo.' },
  }),
  tool('delete_file', 'Borra UN archivo dentro de la carpeta de trabajo. No borra carpetas.', {
    path: { type: 'string', description: 'Ruta del archivo, relativa a la carpeta de trabajo.' },
  }),
  tool('run_command', 'Ejecuta un comando de shell con la carpeta de trabajo como cwd y devuelve su salida.', {
    command: { type: 'string', description: 'El comando exacto a ejecutar.' },
  }),
  tool('set_working_folder', 'Cambia la carpeta de trabajo del agente (la crea si no existe). Úsala solo si el usuario pide trabajar en otra ruta.', {
    path: { type: 'string', description: 'Ruta absoluta de la nueva carpeta de trabajo.' },
  }),
];

function tool(
  name: string,
  description: string,
  props: Record<string, { type: string; description: string }>,
  required?: string[]
) {
  return {
    type: 'function' as const,
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: props,
        required: required ?? Object.keys(props),
      },
    },
  };
}

const DENIED = 'DENEGADO por el usuario. No insistas con esta acción; pregúntale al usuario qué hacer.';

/** System prompt for the agent (initial working folder baked in). */
export function agentSystemPrompt(cwd: string): string {
  return [
    'Eres un agente de archivos dentro de VS Code (extensión KeyRotator). Respondes en español.',
    `Tu carpeta de trabajo actual es: ${cwd}`,
    'Tienes herramientas para leer, listar, escribir y borrar archivos, ejecutar comandos de shell y cambiar la carpeta de trabajo.',
    'Reglas:',
    '- Escribes/borras solo dentro de la carpeta de trabajo. Si el usuario pide TRABAJAR en otra ruta, usa set_working_folder directamente (él aprobará) — no le preguntes primero.',
    '- LEER una ruta absoluta fuera de la carpeta sí puedes: llama read_file con esa ruta tal cual y el usuario aprobará. Si el usuario te da una ruta, léela de una vez, sin pedir opciones.',
    '- Las acciones de leer-fuera/escribir/borrar/ejecutar/cambiar-carpeta requieren aprobación del usuario; si algo sale DENEGADO, no lo reintentes — pregunta.',
    '- Prefiere pasos pequeños: lee antes de modificar, verifica después de escribir.',
    '- Ejecutas en Windows: los comandos corren con cmd.exe.',
  ].join('\n');
}

export async function executeTool(name: string, argsJson: string, ctx: AgentContext): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return `ERROR: argumentos no son JSON válido: ${argsJson.slice(0, 200)}`;
  }
  const str = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '');

  try {
    switch (name) {
      case 'read_file': {
        // Reads inside the working folder are free; an ABSOLUTE path outside
        // it (e.g. the user pasted C:\...\Downloads\x.ps1) asks permission
        // instead of refusing — the user click is the security boundary.
        const abs = await guardRead(ctx, str('path'));
        if (typeof abs !== 'string') return abs.err;
        const content = await fs.promises.readFile(abs, 'utf-8');
        return content.length > READ_CAP
          ? content.slice(0, READ_CAP) + `\n…[truncado: el archivo tiene ${content.length} caracteres]`
          : content;
      }
      case 'list_directory': {
        const abs = await guardRead(ctx, str('path') || '.');
        if (typeof abs !== 'string') return abs.err;
        const entries = await fs.promises.readdir(abs, { withFileTypes: true });
        if (entries.length === 0) return '(carpeta vacía)';
        return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
      }
      case 'write_file': {
        const rel = str('path');
        const abs = guard(ctx, rel);
        if (!abs) return outOfBounds(ctx, rel);
        const content = str('content');
        const ok = await ctx.gate.ask('write', `${abs}\n(${content.length} caracteres)`);
        if (!ok) return DENIED;
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, content, 'utf-8');
        return `Escrito: ${abs} (${content.length} caracteres)`;
      }
      case 'delete_file': {
        const abs = guard(ctx, str('path'));
        if (!abs) return outOfBounds(ctx, str('path'));
        const st = await fs.promises.stat(abs);
        if (st.isDirectory()) return 'ERROR: es una carpeta, no un archivo. Este agente no borra carpetas.';
        const ok = await ctx.gate.ask('delete', abs);
        if (!ok) return DENIED;
        await fs.promises.unlink(abs);
        return `Borrado: ${abs}`;
      }
      case 'run_command': {
        const command = str('command');
        if (!command) return 'ERROR: comando vacío.';
        const ok = await ctx.gate.ask('command', `${command}\n(cwd: ${ctx.getCwd()})`);
        if (!ok) return DENIED;
        return await runShell(command, ctx.getCwd());
      }
      case 'set_working_folder': {
        const target = str('path');
        if (!path.isAbsolute(target)) return 'ERROR: se requiere una ruta absoluta.';
        const abs = path.resolve(target);
        const ok = await ctx.gate.ask('folder', abs);
        if (!ok) return DENIED;
        await fs.promises.mkdir(abs, { recursive: true });
        ctx.setCwd(abs);
        return `Carpeta de trabajo cambiada a: ${abs}`;
      }
      default:
        return `ERROR: herramienta desconocida "${name}".`;
    }
  } catch (e) {
    return `ERROR: ${(e as Error).message}`;
  }
}

function guard(ctx: AgentContext, p: string): string | null {
  if (!p) return null;
  return resolveInside(ctx.getCwd(), p);
}

/**
 * Read access: free inside the working folder; an absolute path outside it is
 * allowed WITH the user's approval (category 'read'). Relative escapes stay
 * rejected (the model should name the real path or move the working folder).
 */
async function guardRead(ctx: AgentContext, p: string): Promise<string | { err: string }> {
  const inside = guard(ctx, p);
  if (inside) return inside;
  if (p && path.isAbsolute(p)) {
    const abs = path.resolve(p);
    const ok = await ctx.gate.ask('read', abs);
    return ok ? abs : { err: DENIED };
  }
  return { err: outOfBounds(ctx, p) };
}

function outOfBounds(ctx: AgentContext, p: string): string {
  return (
    `ERROR: la ruta "${p}" queda FUERA de la carpeta de trabajo (${ctx.getCwd()}). ` +
    'Por seguridad solo puedes operar dentro de ella. Si el usuario quiere trabajar en otra ruta, usa set_working_folder.'
  );
}

function runShell(command: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      let out = '';
      if (stdout) out += stdout;
      if (stderr) out += (out ? '\n[stderr]\n' : '[stderr]\n') + stderr;
      if (err && !err.killed) out += `${out ? '\n' : ''}[exit: ${err.code ?? 'error'}]`;
      if (err?.killed) out += `${out ? '\n' : ''}[cancelado: superó el timeout de 60s]`;
      if (!out) out = '(sin salida, exit 0)';
      resolve(out.length > OUT_CAP ? out.slice(0, OUT_CAP) + '\n…[salida truncada]' : out);
    });
  });
}
