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
    'ETAPA 1 — INVESTIGACIÓN (obligatoria, no la saltes):',
    '1. Determina qué DISCIPLINAS necesita realmente esta tarea (ej. para un programa: frontend, backend, seguridad, pruebas; para un documento: redacción, diseño/scripts de maquetado). Tú decides cuáles, según la tarea.',
    '2. Investiga con web_search/deep_research (recency="mes", si no hay nada amplía a "año") cuál de los modelos de la lista rinde mejor en cada disciplina. Busca por el NOMBRE de cada modelo + la disciplina, y benchmarks recientes.',
    '3. VALIDA LA FECHA de cada afirmación (fetch_url para confirmar). Un ranking viejo NO vale: los modelos envejecen rápido. Si solo encuentras información antigua sobre un modelo, dilo y no lo trates como "el mejor".',
    '4. Si detectas que existe un modelo MEJOR que el usuario NO tiene (disponible en build.nvidia.com), anótalo como recomendación con su razón — NO lo asignes.',
    '5. Decide si hacen falta SKILLS (metodologías) o servidores MCP para hacer bien el trabajo.',
    '',
    'Cuando termines de investigar, responde SOLO con este JSON (sin texto alrededor):',
    '{',
    '  "strategy": "2-3 frases: qué disciplinas identificaste y por qué asignaste cada modelo, citando la fecha de la evidencia",',
    '  "assignments": [{"model":"<id exacto de la lista>","role":"<disciplina>","task":"<instrucción completa y autosuficiente>"}],',
    '  "skills": ["<nombre de skill que conviene cargar>"],',
    '  "mcp": ["<servidor MCP útil>"],',
    '  "recommendations": [{"model":"<modelo que el usuario NO tiene>","reason":"<por qué sería mejor para qué parte, con la fecha de la evidencia>"}]',
    '}',
    '',
    'Reglas: máximo 4 asignaciones, todas ejecutables EN PARALELO (sin depender entre sí); cada "task" es autosuficiente porque el trabajador no ve esta conversación; si la tarea es simple y tú puedes hacerla, asígnate a ti mismo una sola vez; "skills", "mcp" y "recommendations" pueden ir vacíos.',
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
export function pickDirector(models: AgencyModel[]): AgencyModel | null {
  if (models.length === 0) return null;
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
    assignments.push({
      model: match.model,
      role: typeof a?.role === 'string' && a.role.trim() ? a.role.trim() : 'Especialista',
      task,
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
