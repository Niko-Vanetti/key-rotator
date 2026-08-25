# KeyRotator UI Rework Design

## Objective

Make KeyRotator feel like a focused, advanced VS Code assistant: calm enough for long sessions, dense enough for operational work, and visually consistent with the active editor theme.

## Direction

The chat is the primary workspace. Its signature is a bordered command dock anchored at the bottom, combining message input, attachments, model controls, and runtime state into one coherent surface. The dashboard is the control room: compact navigation, clear forms, and scan-friendly resource rows.

## Visual System

- Use VS Code theme variables exclusively for foregrounds, surfaces, borders, focus, and semantic states.
- Use the editor font for code and model metadata; use the native VS Code UI font everywhere else.
- Keep radii between 4px and 8px.
- Use `--vscode-focusBorder` as the interaction accent and chart green/yellow/red for state only.
- Avoid decorative gradients, oversized headings, nested cards, and new dependencies.

## Chat

- Compact two-level identity in the header: product label, conversation title, live state, and current account.
- Messages have a readable centered measure, stronger role labels, clearer user/assistant separation, and refined Markdown/code treatment.
- Empty state explains the first action without resembling a marketing hero.
- Composer becomes one integrated command dock with attachment and queue rows, expandable textarea, icon-first attach/send controls, and an inline status rail.
- Menus, focus states, narrow-panel wrapping, and reduced-motion behavior remain accessible.

## Dashboard

- Add a compact product header and a sticky VS Code-style tab rail.
- Constrain the working area to a readable maximum width.
- Treat account, MCP, and skill entries as operational rows with consistent metadata and actions.
- Make model import the primary action while keeping the agency director visible and compact.
- Improve table density, empty states, statistics, keyboard focus, and responsive stacking.

## Behavior

Existing element IDs and host message contracts remain unchanged. The rework may adjust visible copy and button labels, but does not change persistence, provider behavior, or extension commands.

## Verification

- An automated UI contract test checks the required shells, landmarks, labels, and theme-variable usage.
- Run the full test suite and production compilation.
- Review the final diff for accidental changes outside the webview UI and documentation.
