# NVIDIA Build Project 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add capability-aware hosted NVIDIA Build profiles, one reliable image execution path, and durable file/image attachments with thumbnails and a viewer.

**Architecture:** Keep the existing vanilla VS Code webviews and account storage. Add two pure modules: one classifies NVIDIA snippets into model profiles, and one validates/describes media attachments. Route image mode and the agent image tool through the existing `imageRunner`, then carry attachment metadata through agent sessions and webview messages.

**Tech Stack:** TypeScript, Node.js standard library, VS Code Webview API, vanilla HTML/CSS/JavaScript, Node test runner.

## Global Constraints

- Hosted NVIDIA Build endpoints and `nvapi-*` credentials only.
- No new dependencies.
- Preserve existing accounts and legacy chat snippets.
- Never persist credentials, signed upload URLs, or inline binary payloads in profile metadata.
- Check file sizes before reading or base64 encoding.
- Never delete or modify user-owned attachments.
- Keep all existing tests passing.

---

### Task 1: NVIDIA Capability Profiles

**Files:**
- Create: `src/agent/nvidiaProfiles.ts`
- Modify: `src/core/snippetParser.ts`
- Modify: `src/extension.ts`
- Modify: `test/snippetParser.test.ts`

**Interfaces:**
- Produces: `NvidiaCapability`, `NvidiaModelProfile`, `inferNvidiaProfile(accountId, snippet)`.
- Extends: `ParsedSnippet` with `invocationUrl`, `method`, and `requestKeys`.
- Persists: profiles under `keyRotator.nvidiaProfilesByAccount`.

- [ ] Add failing parser tests for chat, image-generation, image-edit, VLM, and unknown hosted NVIDIA samples.
- [ ] Run `node --import tsx --test test/snippetParser.test.ts` and confirm failures are caused by missing profile fields.
- [ ] Implement URL, method, and request-key extraction without storing credential values.
- [ ] Implement conservative profile inference from endpoint and request shape.
- [ ] Store the inferred profile when a NVIDIA account is added; preserve legacy chat behavior.
- [ ] Run the focused tests.

### Task 2: Single Image Adapter

**Files:**
- Modify: `src/agent/imageRunner.ts`
- Modify: `src/agent/aiTools.ts`
- Modify: `src/chat/chatSession.ts`
- Modify: `test/viability.test.ts`
- Modify: `test/aiTools.test.ts`

**Interfaces:**
- Produces: `runImage()` as the only NVIDIA image invocation function.
- Changes: `generateImage()` delegates to `runImage()` and accepts an optional injected runner for tests.

- [ ] Add a failing regression test proving the agent tool invokes `https://ai.api.nvidia.com/v1/genai/<model>`.
- [ ] Run focused tests and confirm the current `integrate.api.nvidia.com` URL fails the assertion.
- [ ] Replace duplicate request code in `generateImage()` with `runImage()`.
- [ ] Pass the active account key, selected model, output folder, and abort signal through the shared runner.
- [ ] Run focused tests.

### Task 3: Attachment Domain

**Files:**
- Create: `src/chat/mediaAttachments.ts`
- Modify: `src/agent/agentLoop.ts`
- Modify: `src/agent/agentStore.ts`
- Modify: `src/chat/chatSession.ts`
- Modify: `src/ui/chatPanel.ts`
- Create: `test/mediaAttachments.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `MediaAttachment`, `inspectAttachment(path, origin, owned)`, `attachmentToDataUrl()`, `extractAttachmentText()`.
- Extends: `AgentMessage` with optional `attachments: MediaAttachment[]`.
- Webview receives: `{ type: 'webAttach', attachment }` and history messages containing attachments.

- [ ] Add failing tests for extension/signature detection, empty/oversized files, image limits, UTF-8 extraction, binary rejection, and owned-file metadata.
- [ ] Run the focused test and confirm failures.
- [ ] Implement bounded inspection before reads.
- [ ] Implement text extraction for text-like files; mark OOXML/PDF/archive/audio/video as identified but unavailable when no safe extractor exists.
- [ ] Replace `pendingWebFiles` with `pendingAttachments` while preserving paths passed to web chat.
- [ ] Persist attachment metadata on user messages and generated image metadata on assistant messages.
- [ ] Ensure deleting a pending attachment removes only KeyRotator-owned clipboard files.
- [ ] Add the test to `npm test` and run focused tests.

### Task 4: Image Thumbnails and Viewer

**Files:**
- Modify: `src/ui/media/chat.html`
- Modify: `src/ui/media/chat.css`
- Modify: `src/ui/media/chat.js`
- Modify: `src/ui/chatPanel.ts`
- Modify: `test/uiContract.test.ts`

**Interfaces:**
- Consumes: attachment objects containing `id`, `name`, `path`, `mime`, `size`, `kind`, `origin`, `owned`, and optional `previewUri`.
- Produces: attachment tiles and one `#mediaViewer` dialog reused by pending and historical media.
- Sends: `{ type: 'openAttachment', id }`, `{ type: 'revealAttachment', id }`, and existing removal messages.

- [ ] Extend the UI contract test with failing assertions for attachment tiles, viewer dialog, accessible close, and navigation controls.
- [ ] Run the UI contract test and confirm it fails.
- [ ] Add the viewer landmark and controls.
- [ ] Render image thumbnails from host-provided webview URIs; render non-image files as metadata rows.
- [ ] Add click, Escape, previous/next, remove, open-original, and reveal-in-folder behavior.
- [ ] Render attachments alongside sent history messages.
- [ ] Add responsive and focus-visible styles, then run the UI contract test.

### Task 5: Capability-Aware Routing and Diagnostics

**Files:**
- Modify: `src/ui/chatPanel.ts`
- Modify: `src/chat/chatSession.ts`
- Modify: `src/ui/media/chat.js`
- Modify: `src/ui/media/dashboard.js`
- Modify: `test/viability.test.ts`

**Interfaces:**
- Consumes: persisted `NvidiaModelProfile` values.
- Produces: model entries with `capabilities`, image-mode filtering, and preflight errors for incompatible input.

- [ ] Add failing tests for image-mode filtering and image/VLM attachment compatibility.
- [ ] Run focused tests and confirm failures.
- [ ] Publish configured NVIDIA profiles instead of the hardcoded global image list.
- [ ] Block unsupported or oversized media before network activity.
- [ ] Display capability labels and adapter-specific diagnostic text.
- [ ] Run focused tests.

### Task 6: Verification

**Files:**
- Verify all modified files.

**Interfaces:**
- Produces evidence for Project 1 acceptance criteria.

- [ ] Run `npm test`.
- [ ] Run `npm run compile`.
- [ ] Run `git diff --check`.
- [ ] Render chat at desktop and narrow-panel widths and check for overlap, blank previews, and inaccessible viewer controls.
- [ ] Review `git diff --stat` and confirm no unrelated files changed.
