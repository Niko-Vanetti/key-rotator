# KeyRotator — Design Spec
**Date:** 2026-06-09  
**Status:** Approved

---

## Overview

VS Code extension that manages multiple AI API keys across unlimited providers (Claude, OpenAI, Gemini, Ollama, Qwen, etc.) with automatic rotation when a rate limit is hit. Packaged as `.vsix` for easy distribution via repo — no Marketplace required.

---

## Architecture

### UI Layers

1. **StatusBar** — always visible, shows `⚡ [Provider Label] [2/3]`
   - Green = active and healthy
   - Yellow = rotating / detecting
   - Red = all keys for provider exhausted

2. **TreeView** (sidebar panel) — collapsible tree by provider, each node is an account with status icon
   - Right-click menu: Activate / Disable / Edit / Delete
   - `+` button to add a new key

3. **WebView Panel** — full dashboard with 3 tabs:
   - **Keys** — provider cards with draggable priority, status badge, auto/confirm toggle, edit/delete buttons
   - **History** — chronological log: `[time] [from: Account X] → [to: Account Y] [reason: rate limit / manual]`
   - **Stats** — bar chart (rotations per provider), pie chart (relative usage), "most stable account" counter

### Logic Layer (TypeScript)

| Module | Responsibility |
|---|---|
| `KeyManager` | CRUD for accounts; reads/writes to VS Code Secret Storage |
| `KeyDetector` | Identifies provider from API key string (pattern DB + Gemini Flash fallback) |
| `RateLimitDetector` | Monitors workspace output channels and error messages for rate limit signals |
| `RotationEngine` | Selects next key by priority, applies switch, respects auto/confirm mode per account |
| `StatsTracker` | Persists switch history and usage counts in `globalState` (no keys, metadata only) |
| `RegistryUpdater` | Fetches updated provider pattern DB from GitHub raw on extension startup |

---

## Data Model

### Account (stored in VS Code Secret Storage)

```ts
interface Account {
  id: string              // uuid
  provider: string        // free text: "anthropic", "openai", "qwen", etc.
  label: string           // friendly name: "Claude Cuenta 2"
  apiKey: string          // encrypted by Secret Storage
  endpoint?: string       // for Ollama or custom OpenAI-compatible providers
  priority: number        // rotation order (1 = first)
  switchMode: "auto" | "confirm"
  status: "active" | "rate-limited" | "error" | "disabled"
}
```

### Provider Pattern Registry (JSON, auto-updated from GitHub)

```ts
interface ProviderPattern {
  prefix: string          // e.g. "sk-ant-"
  provider: string        // e.g. "anthropic"
  displayName: string     // e.g. "Anthropic / Claude"
  envVar: string          // e.g. "ANTHROPIC_API_KEY"
  docsUrl?: string
}
```

Known patterns on first install: `sk-ant-` (Anthropic), `sk-` (OpenAI), `AIza` (Google Gemini), `hf_` (HuggingFace), `gsk_` (Groq), `r8_` (Replicate), `co_` (Cohere), `together_` (Together AI).

---

## Key Auto-Detection Flow

When user pastes an API key in the add/edit form:

```
1. Match against local pattern registry (offline, instant)
   → hit  → fill provider, displayName, envVar automatically
            → show: "Detectado: Anthropic / Claude ✓"

2. No match → call Gemini Flash (free tier, grounded search)
   → prompt: "What AI provider uses API keys with this prefix: [first 12 chars]?"
   → parse response → fill fields
   → show: "Identificado via IA: [Provider Name]"
   → optionally save new pattern to local registry

3. Still unknown → leave fields blank, user fills manually
```

Gemini Flash free tier: 1,500 requests/day, 1M tokens/month — sufficient for this use case.

---

## Rate Limit Detection

The extension monitors VS Code output channels and intercepts error responses:

| Provider | Signals |
|---|---|
| Anthropic | `overloaded_error`, `rate_limit_error`, HTTP 429 |
| OpenAI | `rate_limit_exceeded`, `insufficient_quota`, HTTP 429 |
| Gemini | `RESOURCE_EXHAUSTED`, `quota exceeded` |
| Ollama | Connection refused, timeout |
| Generic | Any HTTP 429 in output |

---

## Rotation Flow

### Auto mode
```
Error detected
  → find next active account for same provider (by priority)
  → if found  → update env var in workspace (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
               → write to .vscode/settings.json if Claude Code integration active
               → show notification: "⚡ Rotado a [Label]"
               → log to history + update stats
  → if none   → StatusBar turns red, show urgent notification
```

### Confirm mode
```
Error detected
  → VS Code info message popup:
    "Rate limit en [Account X]. ¿Rotar a [Account Y]?"
    [Sí] [No] [Ver todas las opciones]
  → on "Sí" → same as auto flow
  → on "Ver todas" → open WebView on Keys tab
```

### Recovery
- Ping every 5 minutes on rate-limited accounts (lightweight HEAD request)
- When recovered → mark as available again
- If "prefer primary" is enabled → automatically rotate back to highest-priority account

---

## Provider Support

- **Not limited to any fixed list** — provider is a free-text field with autocomplete from the registry
- Any OpenAI-compatible API (Qwen, Together AI, Groq, local models) works by setting a custom `endpoint`
- Ollama: endpoint defaults to `http://localhost:11434`

---

## Storage

| Data | Location |
|---|---|
| API keys | VS Code Secret Storage (OS-encrypted) |
| Account metadata (label, priority, mode, status) | `globalState` via ExtensionContext |
| Switch history + stats | `globalState` |
| Provider pattern registry | Extension's local `data/patterns.json` + fetched updates |

Keys **never** appear in logs, history, stats, or any file on disk.

---

## Integration with Claude Code

- Updates `ANTHROPIC_API_KEY` in workspace environment on rotation
- Optionally writes to `.claude/settings.json` `env` block if Claude Code is detected
- Compatible with Claude Code OAuth session as primary (manual fallback, not rotatable)

---

## Distribution

- Packaged as `key-rotator-x.x.x.vsix` via `vsce package`
- `.vsix` committed to repo — installable with `code --install-extension key-rotator.vsix`
- No Marketplace account required

---

## Out of Scope (v1)

- Cloud sync of keys across machines
- Team sharing of key pools
- Claude Code OAuth account switching (OAuth sessions are not API keys)
- Mobile / web version
