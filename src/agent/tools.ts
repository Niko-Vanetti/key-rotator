import * as fs from 'node:fs';
import * as os from 'node:os';
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
  tool('use_skill', 'Carga una skill (metodología/instrucciones) de la biblioteca del usuario y devuelve su contenido para que la sigas en esta tarea.', {
    name: { type: 'string', description: 'Nombre exacto de la skill (ver la lista en el prompt del sistema).' },
  }),
  tool('search_chats', 'Busca en TODAS tus conversaciones pasadas de KeyRotator (memoria). Úsala cuando el usuario haga referencia a algo hablado antes.', {
    query: { type: 'string', description: 'Texto o tema a buscar en los chats guardados.' },
  }),
  tool('read_chat', 'Lee el transcript completo de una conversación pasada (por id devuelto por search_chats).', {
    id: { type: 'string', description: 'Id de la sesión (agent-…).' },
  }),
  tool('web_search', 'Busca en internet y devuelve resultados con título, URL y extracto. Úsala para información actual o que no conoces.', {
    query: { type: 'string', description: 'Consulta de búsqueda. NO inventes años: usa el filtro recency en vez de escribir "2024 2025".' },
    recency: { type: 'string', description: 'Ventana temporal: "dia", "semana", "mes" o "año". Úsala siempre que pregunten por lo más reciente.' },
  }, ['query']),
  tool('fetch_url', 'Abre una URL y devuelve su contenido como texto legible. Úsala tras web_search para leer una fuente a fondo.', {
    url: { type: 'string', description: 'URL completa (http/https).' },
  }),
  tool('generate_image', 'Genera una imagen con IA a partir de un prompt y la guarda en la carpeta de trabajo (subcarpeta salidas/).', {
    prompt: { type: 'string', description: 'Descripción detallada en inglés de la imagen a generar.' },
    model: { type: 'string', description: 'Opcional: modelo de imagen de NVIDIA Build (default black-forest-labs/flux.1-dev).' },
  }, ['prompt']),
  tool(
    'deep_research',
    'Investigación profunda: busca en la web, lee varias fuentes y devuelve las notas con citas para que redactes un informe profesional. Úsala cuando pidan investigar, comparar o hacer un informe/reporte.',
    {
      topic: { type: 'string', description: 'Tema o pregunta a investigar.' },
      depth: { type: 'string', description: 'Opcional: "rapida" (3 fuentes), "normal" (5, default) o "profunda" (8).' },
      recency: { type: 'string', description: 'Opcional: "dia", "semana", "mes" o "año" — úsala si el tema depende de información actual.' },
    },
    ['topic']
  ),
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

/**
 * Tools for a turn. Without the deep-research switch the heavy research tool
 * is REMOVED (not just discouraged): models were calling it for a plain "hola".
 */
export function toolsFor(research: boolean): unknown[] {
  if (research) return AGENT_TOOLS;
  return AGENT_TOOLS.filter((t) => (t as { function: { name: string } }).function.name !== 'deep_research');
}

/**
 * Reads a skill's markdown from KeyRotator's own library (and, as a fallback,
 * the user's Claude library). `roots` are skill directories, most specific first.
 */
export function readSkill(name: string, roots: string[] = [path.join(os.homedir(), '.claude', 'skills')]): string {
  const clean = name.replace(/^\//, '').trim();
  if (!clean || /[\\/]|\.\./.test(clean)) return `ERROR: nombre de skill inválido: "${name}"`;
  const candidates = roots.flatMap((r) => [path.join(r, clean, 'SKILL.md'), path.join(r, `${clean}.md`)]);
  candidates.push(path.join(os.homedir(), '.claude', 'commands', `${clean}.md`));
  for (const p of candidates) {
    try {
      const content = fs.readFileSync(p, 'utf-8');
      return content.length > READ_CAP ? content.slice(0, READ_CAP) + '\n…[truncado]' : content;
    } catch {
      // try next location
    }
  }
  return `ERROR: no existe la skill "${clean}". Usa un nombre de la lista del prompt del sistema.`;
}

/** Skill names available in the given roots (dirs with SKILL.md, or *.md). */
export function listSkillNames(roots: string[]): string[] {
  const names = new Set<string>();
  for (const root of roots) {
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.isDirectory() && fs.existsSync(path.join(root, e.name, 'SKILL.md'))) names.add(e.name);
        else if (e.isFile() && e.name.endsWith('.md')) names.add(e.name.replace(/\.md$/, ''));
      }
    } catch {
      // missing dir — skip
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** System prompt for the agent (initial working folder baked in). */
export function agentSystemPrompt(cwd: string, skillNames: string[] = [], research = false): string {
  return [
    'Eres un agente de archivos AUTÓNOMO dentro de VS Code (extensión KeyRotator). Respondes en español, breve y al grano.',
    `HOY ES ${new Date().toLocaleDateString('es-DO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} (${new Date().toISOString().slice(0, 10)}).`,
    'Tu conocimiento interno tiene fecha de corte ANTERIOR a hoy: para cualquier dato que cambie con el tiempo (lo más reciente, precios, versiones, lanzamientos, quién es el mejor en algo) NO respondas de memoria — búscalo. Y NUNCA escribas años inventados en la consulta: usa el año de HOY o, mejor, el filtro de recencia.',
    `Tu carpeta de trabajo es: ${cwd}`,
    '',
    'REGLA Nº1 — AUTONOMÍA TOTAL: NUNCA preguntes "¿qué prefieres?", nunca ofrezcas menús de opciones ni pidas confirmación por chat. Decide tú la mejor vía y EJECÚTALA de inmediato — los pop-ups de aprobación de VS Code son el único control que el usuario necesita. Si una vía falla, prueba la siguiente alternativa tú solo; solo reporta cuando lo lograste o cuando agotaste las alternativas (di qué intentaste).',
    '',
    'FORMATOS BINARIOS (docx, xlsx, pptx, pdf, zip, imágenes…): jamás digas "no puedo leerlo" — conviértelo tú con run_command y PowerShell, sin anunciar el plan:',
    '- Leer .docx/.xlsx/.pptx: son ZIP → powershell -Command "Expand-Archive ..." a una subcarpeta temporal de tu carpeta de trabajo y lee word/document.xml (el texto está en los nodos <w:t>). Alternativa si Office está instalado: COM, p.ej. (New-Object -ComObject Word.Application).',
    '- Crear .docx/.xlsx/.pptx: usa COM de Office por PowerShell (Word.Application: Documents.Add, TypeText, SaveAs2; Excel.Application igual). Si no hay Office, genera el paquete OOXML mínimo (carpeta con [Content_Types].xml + document.xml + Compress-Archive renombrado a .docx).',
    '- PDF: intenta extraer texto con COM de Word (abre PDF). Imágenes: usa comandos del sistema.',
    '',
    'ORGANIZACIÓN: TODO lo que generes (scripts, temporales, conversiones, resultados, "residuos") va DENTRO de tu carpeta de trabajo — crea subcarpetas si ayuda (p.ej. temp/, salidas/). Si el usuario menciona un archivo fuera de la carpeta, LÉELO con su ruta absoluta tal cual (read_file — el usuario aprobará) y produce los resultados en TU carpeta; NO cambies la carpeta de trabajo por eso. set_working_folder SOLO si el usuario pide explícitamente trabajar o crear una carpeta en otro sitio.',
    '',
    'LÍMITES DUROS (los únicos): escribir/borrar con las herramientas solo dentro de la carpeta de trabajo; leer-fuera/escribir/borrar/ejecutar/cambiar-carpeta pasan por el pop-up de aprobación; si el usuario DENIEGA algo, no lo reintentes — pregúntale qué hacer.',
    '',
    'Entorno: Windows; run_command usa cmd.exe con tu carpeta de trabajo como cwd (timeout 60 s). Para cualquier lógica no trivial usa: powershell -Command "...". Verifica tus resultados (p.ej. lista o relee lo que creaste) antes de reportar éxito.',
    '',
    'MEMORIA: tienes acceso a TODAS las conversaciones pasadas de KeyRotator. Si el usuario dice "recuerdas…" o alude a un chat anterior, usa search_chats(query) y luego read_chat(id) — no digas que no recuerdas sin buscar primero.',
    '',
    ...(research
      ? [
          'INVESTIGACIÓN PROFUNDA ACTIVADA por el usuario: para esta consulta investiga a fondo con deep_research/web_search/fetch_url, contrasta varias fuentes y cita lo que uses. Vale la pena tardar.',
        ]
      : [
          'MODO DIRECTO (el usuario NO activó la investigación profunda): responde de una vez con lo que sabes. NO uses herramientas web para saludos, charla, opiniones, explicaciones generales ni nada que ya domines. Busca SOLO si la pregunta exige un dato que cambia con el tiempo (lo más reciente, precios, versiones, resultados) o si el usuario lo pide; en ese caso una o dos búsquedas bastan, no encadenes decenas.',
        ]),
    'WEB: web_search(query, recency) para buscar y fetch_url(url) para leer la fuente completa. Nunca inventes un dato que puedas verificar.',
    'REGLAS ANTI-DESACTUALIZACIÓN (cuando sí busques):',
    '- Si la pregunta dice "más reciente/último/nuevo/ahora", pasa recency="mes" (o "semana"); si sale vacío, amplía a "año". Nunca te quedes con el primer resultado sin fecha.',
    '- ABRE la fuente con fetch_url para confirmar la FECHA del dato antes de afirmar que es lo más reciente. Un resultado sin fecha verificada no sirve como "lo último".',
    '- Contrasta al menos 2 fuentes cuando el dato sea "lo más reciente". Si hay conflicto, gana la de fecha más nueva y dilo.',
    '- Al reportar, di la fecha del dato ("según X, del 12 de junio de 2026"). Si no pudiste verificar la fecha, adviértelo en vez de afirmar.',
    ...(research
      ? ['Para informes/comparativas usa deep_research(topic, depth, recency) y redacta el informe profesional citando [1],[2]… Si piden archivo, guárdalo (write_file .md, o .docx por PowerShell).']
      : []),
    '',
    'IMÁGENES: si el usuario adjunta una imagen la ves directamente (descríbela/analízala sin excusas). Para CREAR imágenes usa generate_image(prompt, model) — el prompt en inglés y detallado; se guarda en salidas/ dentro de tu carpeta.',
    ...(skillNames.length
      ? [
          '',
          'SKILLS: el usuario tiene una biblioteca de skills (metodologías). Si la tarea encaja con una, llama use_skill(name) y SIGUE sus instrucciones. Disponibles: ' +
            skillNames.join(', ') +
            '.',
        ]
      : []),
    '',
    'Puede haber herramientas extra con prefijo "mcp__" (integraciones MCP del usuario): úsalas cuando apliquen; cada llamada pasa por aprobación.',
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
