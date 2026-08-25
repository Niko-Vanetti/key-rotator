import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSnippet, snippetHasData } from '../src/core/snippetParser.js';
import { inferNvidiaProfile, imageProfiles, profileAcceptsKind } from '../src/agent/nvidiaProfiles.js';

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
  assert.equal(s.invocationUrl, 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(s.method, 'POST');
  assert.deepEqual(s.requestKeys, ['max_tokens', 'messages', 'model', 'seed', 'stream', 'temperature', 'top_p']);
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

test('infers hosted NVIDIA chat and vision profiles from request shape', () => {
  const chat = inferNvidiaProfile('chat-1', parseSnippet(NVIDIA_SAMPLE));
  assert.equal(chat.adapter, 'chat');
  assert.deepEqual(chat.capabilities, ['chat']);

  const vision = inferNvidiaProfile(
    'vision-1',
    parseSnippet(
      NVIDIA_SAMPLE.replace(
        'messages=[{"role":"user","content":""}]',
        'messages=[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]}]'
      )
    )
  );
  assert.equal(vision.adapter, 'chat');
  assert.deepEqual(vision.capabilities, ['chat', 'vision']);
  assert.deepEqual(vision.acceptedMimeTypes, ['image/jpeg', 'image/png', 'image/gif']);
});

test('infers NVIDIA image generation and editing profiles from genai samples', () => {
  const generate = parseSnippet(`
    curl --request POST 'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev'
      --header 'Authorization: Bearer $NVIDIA_API_KEY'
      --header 'Content-Type: application/json'
      --data '{"prompt":"a lighthouse","width":1024,"height":1024,"steps":30}'
  `);
  const generated = inferNvidiaProfile('image-1', generate);
  assert.equal(generate.model, 'black-forest-labs/flux.1-dev');
  assert.equal(generated.adapter, 'image');
  assert.deepEqual(generated.capabilities, ['image-generate']);

  const edit = parseSnippet(`
    requests.post(
      "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-kontext-max",
      headers={"Authorization":"Bearer $NVIDIA_API_KEY"},
      json={"prompt":"change the sky","image":"data:image/jpeg;example_id,abc"}
    )
  `);
  const edited = inferNvidiaProfile('image-2', edit);
  assert.equal(edited.adapter, 'image');
  assert.deepEqual(edited.capabilities, ['image-generate', 'image-edit']);
  assert.deepEqual(edited.acceptedMimeTypes, ['image/jpeg', 'image/png']);
});

test('keeps unrecognized hosted NVIDIA contracts unknown', () => {
  const parsed = parseSnippet(`
    curl -X POST https://ai.api.nvidia.com/v1/custom/nvidia/new-model
      -H "Authorization: Bearer nvapi-AbC123def456ghi789jkl012mno345pqr"
      -d '{"payload":"x"}'
  `);
  const profile = inferNvidiaProfile('unknown-1', parsed);
  assert.equal(profile.adapter, 'unknown');
  assert.deepEqual(profile.capabilities, ['unknown']);
});

test('filters image profiles and preflights media by declared capability', () => {
  const chat = inferNvidiaProfile('chat', parseSnippet(NVIDIA_SAMPLE));
  const vision = inferNvidiaProfile(
    'vision',
    parseSnippet(NVIDIA_SAMPLE.replace('content":""', 'content":[{"type":"image_url","image_url":{"url":"x"}}]'))
  );
  const image = inferNvidiaProfile(
    'image',
    parseSnippet(`curl -X POST https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev -d '{"prompt":"x"}'`)
  );
  assert.deepEqual(imageProfiles([chat, vision, image]).map((p) => p.accountId), ['image']);
  assert.equal(profileAcceptsKind(chat, 'image'), false);
  assert.equal(profileAcceptsKind(vision, 'image'), true);
  assert.equal(profileAcceptsKind(image, 'image'), false, 'generation output is not VLM input');
  assert.equal(profileAcceptsKind(chat, 'text'), true);
  assert.equal(profileAcceptsKind(chat, 'audio'), false);
});
