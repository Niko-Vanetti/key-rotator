import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickDirector,
  extractJson,
  normalizePlan,
  matchModel,
  resolveNames,
  teamFromPlan,
  routeToMember,
  routerPrompt,
  specialistPrompt,
  directorResearchPrompt,
  type AgencyModel,
} from '../src/agent/agency.js';
import { recencyParam } from '../src/agent/aiTools.js';

const m = (model: string): AgencyModel => ({
  accountId: 'id-' + model,
  model,
  apiKey: 'k',
  endpoint: 'https://integrate.api.nvidia.com/v1',
  provider: 'nvidia',
});

const ROSTER = [m('z-ai/glm-5.2'), m('google/gemma-4-31b-it'), m('deepseek-ai/deepseek-v4-pro')];

test('pickDirector prefers the Google model', () => {
  assert.equal(pickDirector(ROSTER)?.model, 'google/gemma-4-31b-it');
  assert.equal(pickDirector([])?.model, undefined);
  // Sin Google, cae al siguiente mejor (deepseek sobre glm).
  assert.equal(pickDirector([m('z-ai/glm-5.2'), m('deepseek-ai/deepseek-v4-pro')])?.model, 'deepseek-ai/deepseek-v4-pro');
});

test('extractJson survives prose, fences and trailing text', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Aquí tienes:\n{"a":[1,2]}\nEso es todo.'), { a: [1, 2] });
  assert.deepEqual(extractJson('{"texto":"llave } dentro"}'), { texto: 'llave } dentro' });
  assert.equal(extractJson('sin json'), null);
});

test('matchModel resolves exact, partial and family names', () => {
  assert.equal(matchModel('z-ai/glm-5.2', ROSTER)?.model, 'z-ai/glm-5.2');
  assert.equal(matchModel('glm', ROSTER)?.model, 'z-ai/glm-5.2');
  assert.equal(matchModel('deepseek', ROSTER)?.model, 'deepseek-ai/deepseek-v4-pro');
  assert.equal(matchModel('modelo-inexistente', ROSTER), null);
});

test('normalizePlan keeps valid assignments, caps them and drops bad ones', () => {
  const plan = normalizePlan(
    {
      strategy: 'reparto',
      assignments: [
        { model: 'glm', role: 'Backend', task: 'haz el backend' },
        { model: 'inexistente', role: 'X', task: 'algo' }, // modelo desconocido → fuera
        { model: 'gemma', role: 'Front', task: '' }, // sin tarea → fuera
        { model: 'deepseek', role: 'Seguridad', task: 'audita' },
      ],
    },
    ROSTER
  );
  assert.ok(plan);
  assert.equal(plan.assignments.length, 2);
  assert.deepEqual(plan.assignments.map((a) => a.role), ['Backend', 'Seguridad']);
  assert.equal(plan.assignments[0].model, 'z-ai/glm-5.2'); // resuelto al id real
});

test('normalizePlan captures skills/mcp and ignores recommendations already owned', () => {
  const plan = normalizePlan(
    {
      assignments: [{ model: 'gemma', role: 'Redactor', task: 'redacta' }],
      skills: ['niko-ieee'],
      mcp: ['context7'],
      recommendations: [
        { model: 'z-ai/glm-5.2', reason: 'ya lo tiene, debe ignorarse' },
        { model: 'qwen/qwen3-max', reason: 'mejor para código, según junio 2026' },
      ],
    },
    ROSTER
  );
  assert.ok(plan);
  assert.deepEqual(plan.skills, ['niko-ieee']);
  assert.deepEqual(plan.mcp, ['context7']);
  assert.equal(plan.recommendations?.length, 1);
  assert.equal(plan.recommendations?.[0].model, 'qwen/qwen3-max');
});

test('normalizePlan returns null when nothing is usable', () => {
  assert.equal(normalizePlan({ assignments: [] }, ROSTER), null);
  assert.equal(normalizePlan('no soy un plan', ROSTER), null);
});

test('resolveNames matches available skills case-insensitively', () => {
  assert.deepEqual(resolveNames(['NIKO-IEEE', 'no-existe'], ['niko-ieee', 'ponytail']), ['niko-ieee']);
  assert.deepEqual(resolveNames(undefined, ['a']), []);
});

test('the research prompt carries the date, the roster and the recency rule', () => {
  const p = directorResearchPrompt('haz un programa', ROSTER, '19 de julio de 2026');
  assert.match(p, /19 de julio de 2026/);
  assert.match(p, /google\/gemma-4-31b-it/);
  assert.match(p, /VALIDA LA FECHA/);
  assert.match(p, /recency="mes"/);
});

test('teamFromPlan builds the permanent roster with scope and evidence', () => {
  const plan = normalizePlan(
    {
      assignments: [
        { model: 'glm', role: 'Backend', scope: 'API y base de datos', evidence: 'benchmark de junio 2026', task: 'haz la API' },
        { model: 'gemma', role: 'Frontend', task: 'haz la UI' }, // sin scope → cae al rol
      ],
    },
    ROSTER
  )!;
  const team = teamFromPlan(plan);
  assert.equal(team.length, 2);
  assert.equal(team[0].scope, 'API y base de datos');
  assert.equal(team[0].evidence, 'benchmark de junio 2026');
  assert.equal(team[1].scope, 'Frontend');
});

const TEAM = [
  { role: 'Backend', model: 'z-ai/glm-5.2', scope: 'API, base de datos y autenticación' },
  { role: 'Frontend', model: 'google/gemma-4-31b-it', scope: 'interfaz, estilos CSS y componentes' },
];

test('routeToMember picks the owner from the router reply', () => {
  assert.equal(routeToMember('Backend', TEAM, 'lo que sea')?.role, 'Backend');
  assert.equal(routeToMember('creo que es el Frontend', TEAM, 'x')?.role, 'Frontend');
  assert.equal(routeToMember('google/gemma-4-31b-it', TEAM, 'x')?.role, 'Frontend');
});

test('routeToMember falls back to the scope words of the user message', () => {
  // El router no dijo nada útil, pero el usuario habla de su área.
  assert.equal(routeToMember('no sé', TEAM, 'la autenticación no funciona')?.role, 'Backend');
  assert.equal(routeToMember('', TEAM, 'los estilos se ven rotos')?.role, 'Frontend');
  assert.equal(routeToMember('', TEAM, 'hola qué tal'), null); // nadie claro → director
  assert.equal(routeToMember('Backend', [], 'x'), null);
});

test('specialistPrompt makes the owner introduce itself, diagnose and fix', () => {
  const p = specialistPrompt({ ...TEAM[0], lastWork: 'entregué el endpoint /login' }, 'BASE');
  assert.match(p, /BASE/);
  assert.match(p, /eres el Backend/);
  assert.match(p, /API, base de datos y autenticación/);
  assert.match(p, /entregué el endpoint \/login/);
  assert.match(p, /primera persona/);
  assert.match(p, /CORRÍGELO/);
});

test('routerPrompt lists every member with its scope', () => {
  const p = routerPrompt('el login falla', TEAM);
  assert.match(p, /Backend \(z-ai\/glm-5\.2\) → responsable de: API/);
  assert.match(p, /TODOS/);
});

test('recencyParam maps the windows for the search engine', () => {
  assert.equal(recencyParam('dia'), 'd');
  assert.equal(recencyParam('semana'), 'w');
  assert.equal(recencyParam('mes'), 'm');
  assert.equal(recencyParam('año'), 'y');
  assert.equal(recencyParam(undefined), '');
  assert.equal(recencyParam('cualquier cosa'), '');
});
