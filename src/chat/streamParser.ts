/**
 * Normalizes raw `claude --output-format stream-json` events into a small,
 * stable set of ChatEvents the rest of the app reasons about. Pure functions
 * only — no I/O — so they can be unit-tested against captured fixtures.
 */

export type ChatEvent =
  | { kind: 'init'; sessionId: string; model: string; apiKeySource: string }
  | { kind: 'status'; status: string }
  | { kind: 'delta'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'rateLimit'; info: Record<string, unknown> }
  | { kind: 'result'; isError: boolean; sessionId: string; text: string; raw: Record<string, unknown> }
  | { kind: 'other' };

/** Classify a single parsed JSON object from the stream into a ChatEvent. */
export function classifyEvent(obj: unknown): ChatEvent {
  if (!obj || typeof obj !== 'object') return { kind: 'other' };
  const o = obj as Record<string, any>;

  switch (o.type) {
    case 'system':
      if (o.subtype === 'init') {
        return {
          kind: 'init',
          sessionId: String(o.session_id ?? ''),
          model: String(o.model ?? ''),
          apiKeySource: String(o.apiKeySource ?? ''),
        };
      }
      if (o.subtype === 'status') {
        return { kind: 'status', status: String(o.status ?? '') };
      }
      return { kind: 'other' };

    case 'stream_event': {
      const ev = o.event;
      if (ev?.type === 'content_block_delta') {
        // text_delta carries `text`; ignore non-text deltas (thinking, tool input).
        const text = ev.delta?.text;
        if (typeof text === 'string' && text.length > 0) {
          return { kind: 'delta', text };
        }
      }
      return { kind: 'other' };
    }

    case 'assistant': {
      const content = o.message?.content;
      if (Array.isArray(content)) {
        const text = content
          .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join('');
        return { kind: 'assistant', text };
      }
      return { kind: 'assistant', text: '' };
    }

    case 'rate_limit_event':
      return { kind: 'rateLimit', info: (o.rate_limit_info ?? {}) as Record<string, unknown> };

    case 'result':
      return {
        kind: 'result',
        isError: o.is_error === true,
        sessionId: String(o.session_id ?? ''),
        text: typeof o.result === 'string' ? o.result : '',
        raw: o,
      };

    default:
      return { kind: 'other' };
  }
}

/**
 * True when a `rate_limit_event` indicates the active credential can no longer
 * serve requests (anything other than the normal "allowed" state).
 */
export function isRateLimitBlock(info: Record<string, unknown>): boolean {
  const status = String(info.status ?? '').toLowerCase();
  if (status && status !== 'allowed') return true;
  const overage = String(info.overageStatus ?? '').toLowerCase();
  // "allowed" overage is fine; a rejected overage alone is not a block while
  // base status is still allowed, so only the status check above blocks.
  return overage === 'blocked';
}

// Matches conditions that mean "this credential is out of resources" — both
// rate/usage limits and billing/credit exhaustion — all of which should roll
// over to the next account rather than surface as a hard error.
const RATE_LIMIT_RX =
  /rate.?limit|usage limit|429|quota|exhaust|too many requests|overloaded_error|insufficient.?quota|credit balance|balance is too low|insufficient.?(funds|credit|balance)|billing|payment required|402/i;

/**
 * True when an error `result` looks like a rate-limit / quota / credit
 * exhaustion (vs a generic error we should surface instead of rotating on).
 */
export function isRateLimitResult(raw: Record<string, unknown>): boolean {
  if (raw.is_error !== true) return false;
  const haystack = JSON.stringify(raw.api_error_status ?? '') + ' ' + String(raw.result ?? '') + ' ' + String(raw.subtype ?? '');
  return RATE_LIMIT_RX.test(haystack);
}

/** True when stderr / a launch error string looks like a rate-limit. */
export function isRateLimitText(text: string): boolean {
  return RATE_LIMIT_RX.test(text);
}

// Claude sometimes returns the limit notice as a SUCCESSFUL result whose text
// is e.g. "You've hit your session limit · resets 11:10pm". Detect those so
// they trigger rotation instead of being shown as a normal reply.
const LIMIT_MESSAGE_RX =
  /you'?ve hit your (session|usage|rate|weekly|monthly) limit|(session|usage) limit[^\n]*resets|l[ií]mite de (sesi[oó]n|uso)[^\n]*reinicia/i;

/** True when a *successful* reply's text is actually a usage-limit notice. */
export function isLimitMessageText(text: string): boolean {
  return LIMIT_MESSAGE_RX.test(text);
}

const NOT_LOGGED_IN_RX = /not logged in|please run \/login|please log ?in|run \/login|invalid api key|authentication_error|no auth/i;

/** True when the failure is an auth/login problem (profiles mode setup), not a limit. */
export function isNotLoggedIn(text: string): boolean {
  return NOT_LOGGED_IN_RX.test(text);
}
