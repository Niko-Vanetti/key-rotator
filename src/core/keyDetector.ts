import type { ProviderPattern, DetectionResult } from '../types.js';

/**
 * Match an API key string against the local pattern registry.
 * Patterns are checked in array order, so more specific prefixes
 * must be listed before generic ones in data/patterns.json.
 */
export function detectFromPatterns(apiKey: string, patterns: ProviderPattern[]): DetectionResult | null {
  for (const pattern of patterns) {
    if (apiKey.startsWith(pattern.prefix)) {
      return {
        provider: pattern.provider,
        displayName: pattern.displayName,
        envVar: pattern.envVar,
        source: 'pattern',
      };
    }
  }
  return null;
}

/**
 * Build the prompt sent to Gemini Flash to identify an unrecognized key prefix.
 * Only the first 12 characters are sent — never the full key.
 */
export function formatGeminiPrompt(apiKey: string): string {
  const prefix = apiKey.slice(0, 12);
  return [
    `An API key starts with this prefix: "${prefix}".`,
    'Identify which AI provider issues API keys with this prefix.',
    'Respond with ONLY a JSON object (no markdown, no extra text) in this exact shape:',
    '{"provider": "<lowercase-slug>", "displayName": "<Human Readable Name>", "envVar": "<CONVENTIONAL_ENV_VAR_NAME>"}',
    'If you do not recognize the prefix, respond with {"provider": null}.',
  ].join('\n');
}

/**
 * Parse a Gemini Flash response into a DetectionResult.
 * Handles responses wrapped in markdown code fences.
 */
export function parseGeminiDetection(raw: string): DetectionResult | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.provider || !parsed.displayName || !parsed.envVar) {
      return null;
    }
    return {
      provider: parsed.provider,
      displayName: parsed.displayName,
      envVar: parsed.envVar,
      source: 'ai',
    };
  } catch {
    return null;
  }
}
