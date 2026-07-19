import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSnippet, snippetHasData } from '../src/core/snippetParser.js';

const NVIDIA_SAMPLE = `
from openai import OpenAI
client = OpenAI(
  base_url = "https://integrate.api.nvidia.com/v1",
  api_key = "$NVIDIA_API_KEY"
)
completion = client.chat.completions.create(
  model="z-ai/glm-5.2",
  messages=[{"role":"user","content":""}],
  temperature=1,
  top_p=1,
  max_tokens=16384,
  seed=42,
  stream=True
)
`;

test('parses the NVIDIA Build python sample (placeholder key)', () => {
  const s = parseSnippet(NVIDIA_SAMPLE);
  assert.equal(s.baseUrl, 'https://integrate.api.nvidia.com/v1');
  assert.equal(s.apiKey, null); // $NVIDIA_API_KEY is a placeholder
  assert.equal(s.model, 'z-ai/glm-5.2');
  assert.deepEqual(s.params, { temperature: 1, top_p: 1, max_tokens: 16384, seed: 42 });
  assert.equal(s.provider, 'nvidia');
  assert.ok(snippetHasData(s));
});

test('parses a real nvapi key from api_key or bare paste', () => {
  const key = 'nvapi-AbC123def456ghi789jkl012mno345pqr';
  const s = parseSnippet(NVIDIA_SAMPLE.replace('$NVIDIA_API_KEY', key));
  assert.equal(s.apiKey, key);
  const bare = parseSnippet(`mi key: ${key}`);
  assert.equal(bare.apiKey, key);
  assert.equal(bare.provider, 'nvidia');
});

test('parses single-line pastes (InputBox collapses newlines)', () => {
  const oneLine = NVIDIA_SAMPLE.replace(/\n/g, ' ');
  const s = parseSnippet(oneLine);
  assert.equal(s.baseUrl, 'https://integrate.api.nvidia.com/v1');
  assert.equal(s.model, 'z-ai/glm-5.2');
  assert.equal(s.params.max_tokens, 16384);
});

test('parses OpenRouter JS style and detects provider', () => {
  const s = parseSnippet(`
    const client = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-v1-0123456789abcdef0123456789abcdef' });
    await client.chat.completions.create({ "model": "deepseek/deepseek-v4-flash", "temperature": 0.7 });
  `);
  assert.equal(s.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(s.apiKey, 'sk-or-v1-0123456789abcdef0123456789abcdef');
  assert.equal(s.model, 'deepseek/deepseek-v4-flash');
  assert.equal(s.params.temperature, 0.7);
  assert.equal(s.provider, 'openrouter');
});

test('empty / useless pastes report no data', () => {
  assert.equal(snippetHasData(parseSnippet('hola que tal')), false);
});
