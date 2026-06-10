import { test } from 'node:test';
import assert from 'node:assert';
import { detectFromPatterns, formatGeminiPrompt, parseGeminiDetection } from '../src/core/keyDetector.ts';
import patterns from '../data/patterns.json' with { type: 'json' };

test('detects Anthropic key by prefix', () => {
  const result = detectFromPatterns('sk-ant-api03-abc123', patterns);
  assert.equal(result?.provider, 'anthropic');
  assert.equal(result?.envVar, 'ANTHROPIC_API_KEY');
});

test('prefers more specific prefix over generic one', () => {
  const result = detectFromPatterns('sk-or-v1-abc123', patterns);
  assert.equal(result?.provider, 'openrouter');
});

test('falls back to generic OpenAI prefix', () => {
  const result = detectFromPatterns('sk-abc123def456', patterns);
  assert.equal(result?.provider, 'openai');
});

test('returns null for unrecognized prefix', () => {
  const result = detectFromPatterns('qwen-xyz-12345', patterns);
  assert.equal(result, null);
});

test('builds a Gemini identification prompt', () => {
  const prompt = formatGeminiPrompt('qwen-xyz-12345');
  assert.match(prompt, /qwen-xyz-123/);
  assert.match(prompt, /JSON/);
});

test('parses a well-formed Gemini JSON response', () => {
  const raw = '```json\n{"provider":"qwen","displayName":"Alibaba Qwen","envVar":"QWEN_API_KEY"}\n```';
  const result = parseGeminiDetection(raw);
  assert.deepEqual(result, {
    provider: 'qwen',
    displayName: 'Alibaba Qwen',
    envVar: 'QWEN_API_KEY',
    source: 'ai',
  });
});

test('returns null when Gemini response is not parseable', () => {
  const result = parseGeminiDetection('I am not sure what this is.');
  assert.equal(result, null);
});
