# NVIDIA Build Multimodal Design

## Objective

Turn KeyRotator into a capability-aware client for hosted NVIDIA Build models. A configured model must be invoked through the contract that matches its real input and output modalities instead of assuming every model implements OpenAI chat completions.

This design covers hosted NVIDIA Build endpoints authenticated with an `nvapi-*` credential. Self-hosted NIM, OpenRouter, and other providers are explicitly out of scope.

## Current Problems

1. NVIDIA accounts are modeled primarily as OpenAI-compatible chat accounts.
2. Image models live in a manual catalog that is independent of configured accounts.
3. Image generation is implemented twice. The image-mode runner uses `ai.api.nvidia.com`, while the agent tool derives image URLs from `integrate.api.nvidia.com`.
4. Capability detection relies partly on model-name patterns.
5. Non-image attachments are reduced to filesystem paths and depend on a tool-capable text model to process them.
6. Pasted images have no thumbnail, full-size viewer, or durable attachment representation in the conversation.
7. Speech models use ASR, TTS, or realtime contracts that are separate from chat completions.

## Delivery Boundaries

The work is split into two implementation projects that share one capability model:

### Project 1: NVIDIA Core, Files, and Images

- Capability profiles and invocation adapters.
- Hosted NVIDIA connection diagnostics.
- Chat/VLM and image generation/editing.
- Attachment ingestion, validation, previews, viewer, and conversation persistence.
- Removal of the duplicate image-generation path.

### Project 2: Speech

- Audio attachment and microphone capture.
- ASR transcription.
- TTS output, playback, and download.
- Realtime voice only for hosted models whose Build sample exposes a compatible public endpoint.

Project 1 must be complete and independently usable before Project 2 begins.

## Capability Model

Each configured NVIDIA model has a `NvidiaModelProfile`:

```ts
type NvidiaCapability =
  | 'chat'
  | 'vision'
  | 'image-generate'
  | 'image-edit'
  | 'audio-transcribe'
  | 'speech-synthesize'
  | 'voice-realtime'
  | 'embedding'
  | 'unknown';

interface NvidiaModelProfile {
  accountId: string;
  model: string;
  endpoint: string;
  capabilities: NvidiaCapability[];
  acceptedMimeTypes: string[];
  outputMimeTypes: string[];
  adapter: 'chat' | 'image' | 'asr' | 'tts' | 'voice' | 'embedding' | 'unknown';
  source: 'snippet' | 'probe' | 'known-default';
}
```

Profiles are stored per account. The pasted NVIDIA Build sample is the primary source because it contains the model-specific endpoint and request shape. Known NVIDIA contracts provide conservative defaults. A safe capability probe may confirm a profile, but a failed probe never invents support.

Unknown contracts remain configured as `unknown` and show an actionable message requesting the complete Build sample. KeyRotator does not guess an endpoint from the model name.

## Snippet Import

The NVIDIA snippet parser must extract:

- API key or placeholder.
- Complete invocation URL, not only a `/v1` base URL.
- Model identifier.
- HTTP method.
- Headers that describe NVIDIA asset references, excluding credentials.
- JSON or multipart request shape.
- Standard parameters such as temperature, dimensions, seed, language, and voice.

Only recognized, non-secret request fields are persisted. Authorization headers, bearer values, signed upload URLs, local paths, and sample payload bytes are never stored in profile metadata.

Existing chat snippets remain backward compatible. A legacy `integrate.api.nvidia.com/v1` snippet becomes a `chat` adapter.

## Adapter Boundary

Every adapter implements one focused contract:

```ts
interface MediaInput {
  attachment: MediaAttachment;
  text?: string;
}

interface NvidiaInvocation {
  profile: NvidiaModelProfile;
  apiKey: string;
  prompt: string;
  inputs: MediaInput[];
  parameters: Record<string, string | number | boolean>;
}

type NvidiaResult =
  | { ok: true; text?: string; outputs: MediaAttachment[]; elapsedMs: number }
  | {
      ok: false;
      kind: 'auth' | 'entitlement' | 'rate-limit' | 'validation' | 'timeout' | 'server' | 'unsupported' | 'malformed';
      message: string;
      retryable: boolean;
    };

interface NvidiaAdapter {
  supports(profile: NvidiaModelProfile, input: MediaInput[]): boolean;
  invoke(request: NvidiaInvocation, signal?: AbortSignal): Promise<NvidiaResult>;
}
```

The first project includes:

- `chat`: OpenAI-compatible text and VLM messages at `/v1/chat/completions`.
- `image`: NVIDIA `genai` invocation plus asset upload for editing.

The second project adds:

- `asr`: uploaded or buffered audio to transcript.
- `tts`: text to an audio result.
- `voice`: realtime bidirectional transport only when the hosted sample defines it.

Embedding models may be classified and diagnosed but do not appear as chat models in the first two projects.

## Attachments

Attachments become first-class conversation data:

```ts
interface MediaAttachment {
  id: string;
  name: string;
  path: string;
  mime: string;
  size: number;
  kind: 'image' | 'audio' | 'video' | 'document' | 'archive' | 'text' | 'unknown';
  origin: 'picker' | 'paste' | 'drop' | 'generated';
  previewPath?: string;
}
```

### Ingestion

- Picker, clipboard, and drag/drop all enter one host-side ingestion function.
- MIME is detected from both extension and file signature for supported media.
- Files are copied only when clipboard bytes have no stable path. Existing files remain referenced by path.
- Empty files, directories, unreadable paths, and oversized payloads produce explicit errors.
- Attachment IDs are generated by KeyRotator and never derived from user filenames.

### Limits

- Inline image data sent to VLMs: 20 MB per image, 40 MB per turn.
- Clipboard image: 20 MB.
- Text extraction sent to a model: 100,000 characters per file and 200,000 per turn.
- Larger or unsupported files remain attached but are not silently transmitted.

Limits are checked before base64 conversion to avoid excessive memory use.

### File Processing

Project 1 supports:

- Text and source files: UTF-8 text extraction with binary detection.
- JSON, CSV, XML, Markdown, and logs: text extraction.
- PNG, JPEG, and GIF: VLM input when the selected model supports vision.
- WebP: previewable in the UI; sent only when the selected model profile explicitly accepts it.
- DOCX, XLSX, and PPTX: text extraction from their OOXML ZIP packages.
- PDF: accepted and shown as an attachment; text extraction requires an existing supported extractor. It is never read as UTF-8.
- ZIP and other archives: listed as attachments but never expanded automatically.
- Audio and video: accepted and previewed as metadata in Project 1, processed in Project 2.

“Accept any attachment” means KeyRotator preserves and identifies it. Processing is performed only when a compatible, bounded adapter exists.

## Image Experience

### Input

- Pasted, selected, and dropped images render as thumbnail tiles before sending.
- Each tile shows filename, size, remove action, and processing state.
- Clicking a thumbnail opens a keyboard-accessible modal viewer with the full image.
- The viewer supports close, previous/next, open original, and remove while the image is still pending.

### Conversation

- Sent image attachments remain visible on the user message.
- Generated and edited images remain visible on the assistant message after reopening the chat.
- Clicking a conversation image opens the same viewer.
- Generated files expose open-original and reveal-in-folder commands.

### Execution

- The image adapter is the only image execution path.
- Image generation uses the model profile endpoint.
- Image editing uploads the source through NVIDIA Cloud Functions assets and sends the returned asset reference.
- Generation and editing are enabled only when the selected profile advertises the matching capability.
- Response parsing supports base64 and remote URL outputs and records the actual output MIME type.

## Routing and UI

The model selector shows capability badges derived from the profile. Selecting a model changes the available controls:

- Chat: text composer and file tools.
- Vision: image attachments enabled.
- Image generation: dimensions, seed, and generation action.
- Image editing: source-image requirement and editing action.
- Speech, in Project 2: record/upload or voice/format controls.

Modes no longer expose a global hardcoded image catalog. They filter the user’s configured NVIDIA profiles by capability.

When a user sends incompatible input, the UI blocks the request before network activity and explains which configured models can handle it.

## Persistence

Agent conversation messages store attachment metadata alongside text content. Binary payloads are not embedded in session JSON.

- Stable local files are referenced by normalized path.
- Clipboard and generated files are stored under KeyRotator global storage using generated IDs.
- Missing files render as unavailable without breaking transcript loading.
- Removing a pending attachment deletes a temporary clipboard copy.
- Conversation cleanup may delete only KeyRotator-owned temporary media, never user files.

## Connection Diagnostics

Diagnostics are adapter-specific:

- Chat/VLM: minimal completion request.
- Image generation: validation request using conservative dimensions.
- Image editing: capability validation without uploading a user file when the endpoint metadata is sufficient.
- ASR/TTS: minimal sample requests in Project 2.

The dashboard reports credential validity, endpoint reachability, capability, response time, and actionable NVIDIA errors separately. A model is not labeled broken merely because it does not support chat or function calling.

Live integration tests require a user-provided test credential at runtime and never print or persist it.

## Error Handling

- Authentication, entitlement, rate limit, validation, timeout, server, unsupported capability, and malformed response are distinct result kinds.
- Retries apply only to rate limits, selected 5xx responses, and timeouts.
- Asset upload and inference have separate progress and error reporting.
- Aborting a turn cancels pending network requests and does not delete successful prior outputs.
- Partial or malformed model output is preserved for diagnostics without exposing credentials.

## Security

- Content Security Policy continues to restrict scripts and media origins.
- Remote media URLs are allowed only from HTTPS.
- HTML rendering escapes user-controlled names and paths.
- File size checks occur before reads and encoding.
- No archive auto-extraction, executable execution, or macro processing occurs during attachment ingestion.
- Existing permission gates remain required for model-requested filesystem access.

## Testing

### Project 1

- Unit tests for snippet capability extraction and secret removal.
- Unit tests for MIME/signature detection, limits, and attachment ownership.
- Adapter tests for chat, VLM, generation, editing, asset upload, response parsing, retries, and aborts using local HTTP fakes.
- Regression test proving the agent image tool and image mode use the same adapter and endpoint.
- UI contract tests for thumbnail, viewer, keyboard close, next/previous, removal, and persisted rendering.
- Existing full suite and production compilation.

### Project 2

- Contract tests for ASR/TTS request and response formats.
- Audio size/format validation tests.
- UI tests for record permission, playback, download, and abort.
- Optional live tests gated by an environment-provided NVIDIA test credential.

## Acceptance Criteria

Project 1 is complete when:

1. A pasted hosted NVIDIA Build sample creates a capability profile.
2. Chat and VLM models use chat completions; image models use the image adapter.
3. The duplicate broken image-generation path is removed.
4. Pasted, selected, and dropped images show thumbnails and open in a viewer.
5. Sent and generated images remain viewable after reopening a conversation.
6. Supported documents are extracted through bounded format-aware handlers.
7. Incompatible or oversized inputs fail before network transmission with a clear message.
8. Tests and production compilation pass.

Project 2 is complete when configured hosted ASR/TTS/voice profiles expose their matching input and output controls and pass the same diagnostic, persistence, error, and security standards.
