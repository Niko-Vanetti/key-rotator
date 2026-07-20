/**
 * "Modo agencia": one model acts as DIRECTOR — it researches which model fits
 * each part of the job, splits the work, runs every worker IN PARALLEL (each
 * on its own API key, with the full tool set), then synthesizes one answer.
 *
 * The planning/parsing helpers are pure so they can be unit-tested without
 * touching the network.
 */

export interface AgencyModel {
  accountId: string;
  model: string;
  apiKey: string;
  endpoint: string;
  provider: string;
  params?: Record<string, number>;
}

export interface AgencyAssignment {
  /** Model id as written by the director (matched loosely to the roster). */
  model: string;
  /** Short role name shown in the UI ("Investigador", "Redactor"…). */
  role: string;
  /** The self-contained instruction for that worker. */
  task: string;
  /**
   * What this member OWNS from now on (files, modules, areas). The team is
   * persistent: later complaints about this area come back to this member.
   */
  scope?: string;
  /** Why this model was chosen, with the date of the evidence. */
  evidence?: string;
}

/** A permanent member of the agency for this conversation. */
export interface AgencyTeamMember {
  role: string;
  model: string;
  /** Area this member is responsible for ("backend y API", "estilos CSS"…). */
  scope: string;
  /** Why they were picked (evidence + date), shown when they introduce themselves. */
  evidence?: string;
  /** Summary of what they delivered last, so they can answer about it. */
  lastWork?: string;
  /** Failed attempts in this role — 2 triggers the director's evaluation. */
  strikes?: number;
  /** Models that held this role before, with why they were replaced. */
  predecessors?: { model: string; reason: string }[];
  /** Context handed over by the previous holder of the role. */
  handoff?: string;
}

/** An open position: the director wants a model the user doesn't have yet. */
export interface AgencyVacancy {
  role: string;
  scope: string;
  /** Why the previous model wasn't enough. */
  reason: string;
  /** The candidate's "CV" as researched by the director (shown to the user). */
  cv: string;
  /** Suggested model id on NVIDIA Build. */
  candidate: string;
  /** Work in progress the newcomer must continue. */
  handoff?: string;
}

/** The director's verdict on a struggling specialist (pure, tested). */
export type Verdict =
  | { action: 'keep' }
  | { action: 'replace'; model: string; reason: string }
  | { action: 'hire'; reason: string };

/** Prompt: is this specialist up to the job, or should it be replaced? */
export function evaluationPrompt(
  member: AgencyTeamMember,
  userComplaint: string,
  roster: AgencyModel[]
): string {
  const others = roster.filter((r) => r.model !== member.model);
  return [
    'Eres el DIRECTOR de una agencia de IA. Evalúas si un especialista da la talla.',
    '',
    `ESPECIALISTA: ${member.role} — modelo ${member.model}`,
    `RESPONSABLE DE: ${member.scope}`,
    `INTENTOS FALLIDOS EN ESTE ROL: ${member.strikes ?? 0}`,
    member.lastWork ? `ÚLTIMA ENTREGA (resumen):\n${member.lastWork.slice(0, 2000)}` : '',
    '',
    `QUEJA / SITUACIÓN ACTUAL DEL USUARIO:\n${userComplaint}`,
    '',
    'OTROS MODELOS QUE EL USUARIO YA TIENE (podrías moverlo a este rol):',
    ...(others.length ? others.map((o) => `- ${o.model}`) : ['- (ninguno más)']),
    '',
    'Investiga con tus herramientas si hace falta (recency="mes") y decide. Responde SOLO con UNA línea:',
    'MANTENER: <por qué merece seguir>',
    'REEMPLAZAR <id exacto de un modelo de la lista de arriba>: <por qué ese sí puede>',
    'CONTRATAR: <por qué ninguno de los que tiene sirve para esto>',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Parses the director's verdict against the real roster (pure, tested). */
export function parseVerdict(reply: string, roster: AgencyModel[], currentModel: string): Verdict {
  const line = reply.trim();
  const reason = (s: string) => s.replace(/^[^:]*:\s*/, '').trim().slice(0, 300);
  if (/^\s*reemplazar/i.test(line)) {
    const wanted = line.replace(/^\s*reemplazar\s*/i, '').split(':')[0].trim();
    const match = matchModel(wanted, roster.filter((r) => r.model !== currentModel));
    if (match) return { action: 'replace', model: match.model, reason: reason(line) };
    // Pidió reemplazo pero no hay a quién: se convierte en contratación.
    return { action: 'hire', reason: reason(line) };
  }
  if (/^\s*contratar/i.test(line)) return { action: 'hire', reason: reason(line) };
  return { action: 'keep' };
}

/** Prompt: research NVIDIA Build and write the candidate's CV for the user. */
export function cvPrompt(role: string, scope: string, reason: string, owned: AgencyModel[], today: string): string {
  return [
    `Eres el DIRECTOR de una agencia de IA. HOY ES ${today}.`,
    `Necesitas cubrir el puesto de "${role}" (responsable de: ${scope}).`,
    `Motivo de la vacante: ${reason}`,
    '',
    'El usuario YA TIENE estos modelos (NO los propongas):',
    ...owned.map((o) => `- ${o.model}`),
    '',
    'INVESTIGA en build.nvidia.com qué modelo DISPONIBLE AHÍ sería el mejor para este puesto. Usa web_search/fetch_url con recency="mes" (amplía a "año" si no hay nada) y VALIDA la fecha: descarta modelos viejos o descontinuados.',
    '',
    'Responde con este formato exacto, en español y sin nada más:',
    'CANDIDATO: <id exacto del modelo en NVIDIA Build>',
    'CURRÍCULUM:',
    '- Fortalezas para este puesto: …',
    '- Evidencia y fecha: … (di de cuándo es el dato)',
    '- Por qué supera a los que ya tengo: …',
    '- Limitaciones o riesgos: …',
  ].join('\n');
}

/** Extracts {candidate, cv} from the director's CV answer (pure, tested). */
export function parseCv(reply: string): { candidate: string; cv: string } | null {
  const m = reply.match(/CANDIDATO:\s*([^\s\n]+)/i);
  if (!m) return null;
  const candidate = m[1].trim().replace(/[.,;]$/, '');
  const cvIdx = reply.search(/CURR[IÍ]CULUM:/i);
  const cv = cvIdx === -1 ? reply.trim() : reply.slice(cvIdx).trim();
  return { candidate, cv };
}

/** Context the newcomer receives from the model it replaces (pure, tested). */
export function handoffBrief(prev: AgencyTeamMember, reason: string): string {
  return [
    `TRASPASO DE PUESTO: sustituyes a ${prev.model} como ${prev.role}.`,
    `Área de la que ahora eres responsable: ${prev.scope}`,
    `Motivo del cambio: ${reason}`,
    prev.lastWork ? `\nLO QUE DEJÓ HECHO (revísalo, puede tener errores):\n${prev.lastWork.slice(0, 6000)}` : '',
    '\nContinúa desde ahí: primero verifica el estado real (lee los archivos, ejecuta lo que haya), corrige lo que esté mal y sigue con el trabajo.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Finds a roster model that isn't on the team yet — used when the user says
 * "ya integré el modelo" to fill an open vacancy (pure, tested).
 */
export function findNewcomer(roster: AgencyModel[], team: AgencyTeamMember[], candidate?: string): AgencyModel | null {
  const used = new Set(team.map((t) => t.model.toLowerCase()));
  const fresh = roster.filter((r) => !used.has(r.model.toLowerCase()));
  if (fresh.length === 0) return null;
  if (candidate) {
    const exact = matchModel(candidate, fresh);
    if (exact) return exact;
  }
  return fresh[0];
}

/**
 * True when the message reads as "this doesn't work" — used to count strikes
 * against the responsible specialist (pure, tested).
 */
export function looksLikeComplaint(text: string): boolean {
  const t = text.toLowerCase();
  return /(no (me )?(funciona|sirve|va|anda|carga|corre|compila|abre)|sigue (fallando|roto|igual|sin)|falla|error|est[áa] (mal|roto)|no qued[óo]|mal hecho|otra vez)/.test(
    t
  );
}

/** True when the user is telling us a new model is ready (pure, tested). */
export function saysModelReady(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /(ya (la |lo )?(integr|agregu|puse|añad|anad|pegu)|est[áa] list[ao]|ya la tienes|ya lo tienes|ya est[áa] (ah[íi]|disponible|integrad))/.test(
      t
    ) || /(contrat|incorpor)(a|ada|ado|é|e)\b/.test(t)
  );
}

/** Builds the persistent team from a validated plan (pure, tested). */
export function teamFromPlan(plan: AgencyPlan): AgencyTeamMember[] {
  return plan.assignments.map((a) => ({
    role: a.role,
    model: a.model,
    scope: a.scope?.trim() || a.role,
    evidence: a.evidence,
  }));
}

/**
 * Picks which team member owns a follow-up message. Matches the router's
 * answer, then falls back to scoring the text against each member's scope
 * words. Returns null when nobody clearly owns it (→ director handles it).
 * Pure — unit-tested.
 */
export function routeToMember(reply: string, team: AgencyTeamMember[], userText: string): AgencyTeamMember | null {
  if (team.length === 0) return null;
  const said = reply.toLowerCase();
  const byRole = team.find((t) => said.includes(t.role.toLowerCase()));
  if (byRole) return byRole;
  // Un mismo modelo puede ocupar VARIOS puestos: si el router contestó con el
  // modelo, hay que desempatar por el área a la que se refiere el usuario.
  const byModel = team.filter((t) => said.includes(t.model.toLowerCase()));
  if (byModel.length === 1) return byModel[0];
  const candidates = byModel.length > 1 ? byModel : team;
  // Fallback: score the user's own words against each scope.
  const text = userText.toLowerCase();
  let best: { m: AgencyTeamMember; score: number } | null = null;
  for (const t of candidates) {
    const words = `${t.scope} ${t.role}`.toLowerCase().split(/[^\wáéíóúñ]+/).filter((w) => w.length > 3);
    const score = words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { m: t, score };
  }
  return best?.m ?? null;
}

/** Asks the director which member owns a follow-up (short, cheap call). */
export function routerPrompt(userText: string, team: AgencyTeamMember[]): string {
  return [
    'Eres el director de una agencia de IA. Estos son tus especialistas y de qué es responsable cada uno:',
    ...team.map((t) => `- ${t.role} (${t.model}) → responsable de: ${t.scope}`),
    '',
    `MENSAJE DEL USUARIO:\n${userText}`,
    '',
    'Responde SOLO con el nombre del rol responsable de atender ese mensaje (tal cual aparece arriba). Si el mensaje toca a varios o es general, responde exactamente: TODOS.',
  ].join('\n');
}

/**
 * System prompt for a specialist answering about their own area — they
 * introduce themselves, diagnose honestly and fix it.
 */
export function specialistPrompt(member: AgencyTeamMember, base: string): string {
  return [
    base,
    '',
    `IDENTIDAD: eres el ${member.role} de esta agencia (modelo ${member.model}). Eres el RESPONSABLE de: ${member.scope}.`,
    member.handoff ? `\n${member.handoff}` : '',
    member.lastWork ? `\nLO QUE ENTREGASTE ANTES:\n${member.lastWork.slice(0, 6000)}` : '',
    '',
    'El usuario te está hablando A TI sobre tu área. Responde en primera persona empezando por presentarte en una línea (ej. "Soy el encargado del backend").',
    'Si algo no funciona: (1) INVESTIGA de verdad la causa con tus herramientas — lee los archivos, ejecuta el código, reproduce el fallo; (2) di con claridad POR QUÉ falló, sin excusas ni suposiciones; (3) CORRÍGELO tú mismo y verifica que ya funciona; (4) reporta qué cambiaste. Nunca pidas permiso para investigar ni ofrezcas opciones: hazlo.',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface AgencyPlan {
  /** Why this split (shown to the user). */
  strategy: string;
  assignments: AgencyAssignment[];
  /** Skills the director wants loaded before working (by name). */
  skills?: string[];
  /** MCP servers the director considers useful (by name, from the config). */
  mcp?: string[];
  /**
   * Models the user does NOT have that the director recommends adding, with
   * the reason — surfaced to the user, never auto-installed.
   */
  recommendations?: { model: string; reason: string }[];
}

/**
 * Prompt for STAGE 1: the director researches (with real web tools) which of
 * the user's models fits each part of THIS task, validating how recent each
 * claim is. It never answers from memory about model rankings.
 */
export function directorResearchPrompt(task: string, roster: AgencyModel[], today: string): string {
  return [
    `Eres el DIRECTOR de una agencia de IA. HOY ES ${today}.`,
    '',
    'MODELOS QUE EL USUARIO TIENE DISPONIBLES:',
    ...roster.map((m) => `- ${m.model}`),
    '',
    `TAREA DEL USUARIO:\n${task}`,
    '',
    'ETAPA 1 — INVESTIGACIÓN Y FORMACIÓN DEL EQUIPO (obligatoria, no la saltes):',
    '1. Determina qué DISCIPLINAS necesita realmente esta tarea (ej. para un programa: frontend, backend, seguridad, pruebas; para un documento: redacción, diseño/scripts de maquetado). Tú decides cuáles, según la tarea.',
    '2. INVESTIGA CADA MODELO DE LA LISTA, uno por uno, con web_search/deep_research (recency="mes"; si no sale nada amplía a "año"): busca "<nombre exacto del modelo>" + la disciplina, más benchmarks y fecha de lanzamiento. Necesitas saber en qué es fuerte CADA UNO antes de repartir; no asignes de memoria ni por el nombre.',
    '3. VALIDA LA FECHA de cada afirmación (abre la fuente con fetch_url). Un ranking viejo NO vale: los modelos envejecen rápido. Si de un modelo solo hay información antigua, dilo y no lo trates como "el mejor" — considera que puede estar obsoleto.',
    '4. ASIGNA cada disciplina al modelo que la evidencia respalde, y define el ÁREA DE LA QUE QUEDA RESPONSABLE de forma permanente (archivos, módulos o partes concretas). Ese responsable atenderá después cualquier problema de su área.',
    '5. Si detectas que existe un modelo MEJOR que el usuario NO tiene (disponible en build.nvidia.com), anótalo como recomendación con su razón y la fecha — NO lo asignes.',
    '6. Decide si hacen falta SKILLS (metodologías) o servidores MCP para hacer bien el trabajo.',
    '',
    'Cuando termines de investigar, responde SOLO con este JSON (sin texto alrededor):',
    '{',
    '  "strategy": "2-3 frases: qué disciplinas identificaste y por qué cada modelo, citando la fecha de la evidencia",',
    '  "assignments": [{',
    '     "model":"<id exacto de la lista>",',
    '     "role":"<disciplina, ej. Backend>",',
    '     "scope":"<de qué queda responsable de forma permanente, concreto>",',
    '     "evidence":"<en qué te basas y de qué fecha es>",',
    '     "task":"<instrucción completa y autosuficiente para su parte ahora>"',
    '  }],',
    '  "skills": ["<nombre de skill que conviene cargar>"],',
    '  "mcp": ["<servidor MCP útil>"],',
    '  "recommendations": [{"model":"<modelo que el usuario NO tiene>","reason":"<por qué sería mejor para qué parte, con la fecha de la evidencia>"}]',
    '}',
    '',
    'Reglas: máximo 4 asignaciones, todas ejecutables EN PARALELO (sin depender entre sí); cada "task" es autosuficiente porque el trabajador no ve esta conversación; si la tarea es simple y tú puedes hacerla, asígnate a ti mismo una sola vez; "skills", "mcp" y "recommendations" pueden ir vacíos.',
    'UN MISMO MODELO PUEDE OCUPAR VARIOS PUESTOS: si la evidencia dice que el mismo modelo es el mejor en dos disciplinas (p.ej. backend y frontend), repítelo en ambas asignaciones con roles y "scope" distintos. No repartas entre modelos peores solo por "dar trabajo a todos" — manda la evidencia, no el reparto equitativo.',
  ].join('\n');
}

/** Names the director asked to preload, cleaned against what exists (pure). */
export function resolveNames(wanted: unknown, available: string[]): string[] {
  if (!Array.isArray(wanted)) return [];
  const out: string[] = [];
  for (const w of wanted) {
    if (typeof w !== 'string') continue;
    const needle = w.trim().toLowerCase();
    if (!needle) continue;
    const hit = available.find((a) => a.toLowerCase() === needle) ?? available.find((a) => a.toLowerCase().includes(needle));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/**
 * Picks the director: the strongest general-purpose model available.
 * Preference order is a heuristic over model NAMES (no network): Google/Gemini
 * first (the user's pick), then other top-tier general models, then whatever
 * exists. Pure — unit-tested.
 */
export function pickDirector(models: AgencyModel[], preferred?: string): AgencyModel | null {
  if (models.length === 0) return null;
  // Director elegido a mano en los ajustes/menú: manda sobre la heurística.
  if (preferred && preferred !== 'auto') {
    const chosen = matchModel(preferred, models);
    if (chosen) return chosen;
  }
  const score = (m: string): number => {
    const s = m.toLowerCase();
    if (/gemini|google\/|gemma/.test(s)) return 100;
    if (/deepseek/.test(s)) return 80;
    if (/glm|qwen3|llama-4|nemotron-3/.test(s)) return 70;
    if (/mistral|nemotron|llama/.test(s)) return 60;
    return 40;
  };
  return [...models].sort((a, b) => score(b.model) - score(a.model) || a.model.localeCompare(b.model))[0];
}

/** Extracts the first JSON object/array from a model's reply (pure, tested). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.search(/[{[]/);
    if (start === -1) continue;
    // Walk to the matching close brace so trailing prose doesn't break parsing.
    const open = c[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(c.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

/**
 * Validates the director's plan against the real roster: every assignment must
 * name an available model (fuzzy match), tasks must be non-empty, and the plan
 * is capped so one request can't spawn dozens of parallel calls. Pure, tested.
 */
export function normalizePlan(raw: unknown, roster: AgencyModel[], maxWorkers = 4): AgencyPlan | null {
  const obj = raw as {
    strategy?: unknown;
    assignments?: unknown;
    skills?: unknown;
    mcp?: unknown;
    recommendations?: unknown;
  };
  const list = Array.isArray(obj?.assignments) ? obj.assignments : Array.isArray(raw) ? (raw as unknown[]) : null;
  if (!list) return null;
  const assignments: AgencyAssignment[] = [];
  for (const item of list) {
    const a = item as { model?: unknown; role?: unknown; task?: unknown };
    const task = typeof a?.task === 'string' ? a.task.trim() : '';
    if (!task) continue;
    const wanted = typeof a?.model === 'string' ? a.model.trim() : '';
    const match = matchModel(wanted, roster);
    if (!match) continue;
    const extra = item as { scope?: unknown; evidence?: unknown };
    assignments.push({
      model: match.model,
      role: typeof a?.role === 'string' && a.role.trim() ? a.role.trim() : 'Especialista',
      task,
      scope: typeof extra?.scope === 'string' ? extra.scope.trim() : undefined,
      evidence: typeof extra?.evidence === 'string' ? extra.evidence.trim() : undefined,
    });
    if (assignments.length >= maxWorkers) break;
  }
  if (assignments.length === 0) return null;
  const recs: { model: string; reason: string }[] = [];
  if (Array.isArray(obj?.recommendations)) {
    for (const r of obj.recommendations) {
      const rr = r as { model?: unknown; reason?: unknown };
      if (typeof rr?.model === 'string' && rr.model.trim()) {
        // Ignore "recommendations" for models the user already has.
        if (roster.some((m) => m.model.toLowerCase() === rr.model!.toString().toLowerCase())) continue;
        recs.push({ model: rr.model.trim(), reason: typeof rr.reason === 'string' ? rr.reason : '' });
      }
    }
  }
  return {
    strategy: typeof obj?.strategy === 'string' ? obj.strategy : '',
    assignments,
    skills: Array.isArray(obj?.skills) ? (obj.skills.filter((s) => typeof s === 'string') as string[]) : [],
    mcp: Array.isArray(obj?.mcp) ? (obj.mcp.filter((s) => typeof s === 'string') as string[]) : [],
    recommendations: recs,
  };
}

/** Loose model matching: exact, then substring either way (pure, tested). */
export function matchModel(wanted: string, roster: AgencyModel[]): AgencyModel | null {
  if (roster.length === 0) return null;
  const w = wanted.toLowerCase().trim();
  if (!w) return roster[0];
  const exact = roster.find((r) => r.model.toLowerCase() === w);
  if (exact) return exact;
  const partial = roster.find((r) => r.model.toLowerCase().includes(w) || w.includes(r.model.toLowerCase()));
  if (partial) return partial;
  // Match by family word (gemma, glm, deepseek…)
  const word = w.split(/[/\s:-]/).find((p) => p.length > 3);
  return word ? (roster.find((r) => r.model.toLowerCase().includes(word)) ?? null) : null;
}

/** Prompt that asks the director to plan the work over the real roster. */
export function directorPlanPrompt(task: string, roster: AgencyModel[]): string {
  return [
    'Eres el DIRECTOR de una agencia de IA. Tu trabajo es repartir una tarea entre los modelos disponibles para lograr el mejor resultado posible para el usuario.',
    '',
    'MODELOS DISPONIBLES (usa exactamente estos ids):',
    ...roster.map((m) => `- ${m.model}`),
    '',
    `TAREA DEL USUARIO:\n${task}`,
    '',
    'Antes de repartir, razona qué modelo conviene para cada parte según sus fortalezas conocidas (investigación, redacción, código, análisis, síntesis, visión…). Si el trabajo es simple, UN solo asignado basta.',
    '',
    'Responde SOLO con un objeto JSON (sin texto alrededor) con esta forma:',
    '{"strategy":"1-2 frases explicando el reparto","assignments":[{"model":"<id exacto>","role":"<rol corto>","task":"<instrucción completa y autónoma para ese modelo>"}]}',
    '',
    'Reglas: máximo 4 asignaciones; cada "task" debe ser autosuficiente (el trabajador NO ve esta conversación ni el trabajo de los demás); reparte partes que puedan hacerse EN PARALELO (no dependientes entre sí); si necesitas información actual, asigna a alguien que busque en la web con sus herramientas.',
  ].join('\n');
}

/** Prompt for the final synthesis step. */
export function directorSynthesisPrompt(
  task: string,
  results: { role: string; model: string; output: string }[]
): string {
  return [
    'Eres el DIRECTOR de la agencia. Tus especialistas ya entregaron su trabajo.',
    '',
    `TAREA ORIGINAL DEL USUARIO:\n${task}`,
    '',
    'ENTREGAS DE LOS ESPECIALISTAS:',
    ...results.map((r, i) => `\n--- [${i + 1}] ${r.role} (${r.model}) ---\n${r.output}`),
    '',
    'Redacta AHORA la respuesta final para el usuario: integra lo mejor de cada entrega, resuelve contradicciones (di cuál tomaste y por qué si las hubo), elimina repeticiones y entrega un resultado pulido y completo. No menciones el proceso interno salvo que aporte. Si el trabajo produjo archivos, dilo con sus rutas. Responde en español.',
  ].join('\n');
}
