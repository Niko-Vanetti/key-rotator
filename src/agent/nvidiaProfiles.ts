import type { ParsedSnippet } from '../core/snippetParser.js';

export type NvidiaCapability =
  | 'chat'
  | 'vision'
  | 'image-generate'
  | 'image-edit'
  | 'audio-transcribe'
  | 'speech-synthesize'
  | 'voice-realtime'
  | 'embedding'
  | 'unknown';

export interface NvidiaModelProfile {
  accountId: string;
  model: string;
  endpoint: string;
  capabilities: NvidiaCapability[];
  acceptedMimeTypes: string[];
  outputMimeTypes: string[];
  adapter: 'chat' | 'image' | 'asr' | 'tts' | 'voice' | 'embedding' | 'unknown';
  source: 'snippet' | 'probe' | 'known-default';
}

export function inferNvidiaProfile(accountId: string, snippet: ParsedSnippet): NvidiaModelProfile {
  const endpoint = snippet.invocationUrl ?? snippet.baseUrl ?? '';
  if (snippet.provider === 'nvidia' && /\/v1\/chat\/completions\/?$/i.test(endpoint)) {
    const vision = snippet.requestKeys.includes('image_url');
    return {
      accountId,
      model: snippet.model ?? '',
      endpoint,
      capabilities: vision ? ['chat', 'vision'] : ['chat'],
      acceptedMimeTypes: vision ? ['image/jpeg', 'image/png', 'image/gif'] : [],
      outputMimeTypes: ['text/plain'],
      adapter: 'chat',
      source: 'snippet',
    };
  }
  if (snippet.provider === 'nvidia' && /\/v1\/genai\/[^?#\s]+/i.test(endpoint)) {
    const editing = snippet.requestKeys.includes('image');
    return {
      accountId,
      model: snippet.model ?? '',
      endpoint,
      capabilities: editing ? ['image-generate', 'image-edit'] : ['image-generate'],
      acceptedMimeTypes: editing ? ['image/jpeg', 'image/png'] : [],
      outputMimeTypes: ['image/png'],
      adapter: 'image',
      source: 'snippet',
    };
  }
  return {
    accountId,
    model: snippet.model ?? '',
    endpoint,
    capabilities: ['unknown'],
    acceptedMimeTypes: [],
    outputMimeTypes: [],
    adapter: 'unknown',
    source: 'snippet',
  };
}

export function imageProfiles(profiles: NvidiaModelProfile[]): NvidiaModelProfile[] {
  return profiles.filter(
    (profile) =>
      profile.adapter === 'image' &&
      profile.capabilities.includes('image-generate'),
  );
}

export function profileAcceptsKind(
  profile: NvidiaModelProfile,
  kind: string,
): boolean {
  if (kind === 'text') return profile.adapter === 'chat';
  if (kind === 'image') return profile.capabilities.includes('vision');
  return false;
}
