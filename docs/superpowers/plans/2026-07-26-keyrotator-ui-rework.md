# KeyRotator UI Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the KeyRotator chat and dashboard into a polished, theme-native VS Code assistant interface.

**Architecture:** Preserve the existing vanilla HTML/CSS/JavaScript webviews and all host-facing element IDs. Add semantic layout classes and implement the visual system in CSS, with only minimal JavaScript changes for accessible icon button state.

**Tech Stack:** VS Code Webview API, HTML, CSS, vanilla JavaScript, Node test runner.

## Global Constraints

- No new runtime or development dependencies.
- Preserve existing host message contracts and element IDs.
- Use VS Code theme variables for all application colors.
- Keep radii at 8px or less and support narrow webview widths.
- Preserve keyboard focus visibility and reduced-motion preferences.

---

### Task 1: UI Contract

**Files:**
- Create: `test/uiContract.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `src/ui/media/chat.html`, `chat.css`, `dashboard.html`, and `dashboard.css`.
- Produces: a Node test that prevents removal of the approved UI landmarks and accessibility labels.

- [ ] Write tests asserting the chat command dock, dashboard workspace shell, accessible icon buttons, theme variables, responsive rules, and reduced-motion handling.
- [ ] Run `node --import tsx --test test/uiContract.test.ts` and verify it fails because the new landmarks are absent.
- [ ] Add the test file to the existing `npm test` command.

### Task 2: Chat Surface

**Files:**
- Modify: `src/ui/media/chat.html`
- Modify: `src/ui/media/chat.css`
- Modify: `src/ui/media/chat.js`

**Interfaces:**
- Consumes: existing IDs used by `chat.js` and messages from the extension host.
- Produces: `.chat-identity`, `.welcome-mark`, and `.command-dock` landmarks without changing IDs.

- [ ] Restructure the header, empty state, composer, and status rail while retaining every JavaScript target.
- [ ] Replace the current visual rules with the approved theme-native layout and responsive behavior.
- [ ] Update send/stop button state to use compact symbols with accessible labels.
- [ ] Run the UI contract test and inspect failures before continuing.

### Task 3: Dashboard Surface

**Files:**
- Modify: `src/ui/media/dashboard.html`
- Modify: `src/ui/media/dashboard.css`

**Interfaces:**
- Consumes: existing IDs and `data-tab` values used by `dashboard.js`.
- Produces: `.workspace-shell`, `.dashboard-header`, `.tabs`, and `.workspace-content` landmarks.

- [ ] Add the compact product header and constrained workspace structure.
- [ ] Restyle tabs, forms, operational rows, drop zones, table, and statistics.
- [ ] Add narrow-width stacking, focus-visible, and reduced-motion behavior.

### Task 4: Verification

**Files:**
- Verify: all files above.

**Interfaces:**
- Consumes: completed webview changes.
- Produces: evidence that contracts, tests, and compilation remain valid.

- [ ] Run `node --import tsx --test test/uiContract.test.ts`.
- [ ] Run `npm test`.
- [ ] Run `npm run compile`.
- [ ] Review `git diff --check` and `git diff --stat`.
