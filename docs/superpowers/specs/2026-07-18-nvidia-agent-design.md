# Agente de archivos NVIDIA Build / OpenRouter en KeyRotator

Fecha: 2026-07-18 · Estado: aprobado por el usuario (diseño conversado en sesión)

## Qué es

Un agente tipo Claude-Code dentro del chat de KeyRotator, servido por **APIs
OpenAI-compatible de NVIDIA Build y OpenRouter exclusivamente** (los demás
proveedores OpenAI-compatible siguen con el chat simple actual). El modelo puede
leer/listar/escribir/borrar archivos y ejecutar comandos mediante function
calling, con permisos estilo Claude Code.

## Decisiones (del usuario, no re-litigar)

1. **Sin modelos por defecto.** Nada hardcodeado: el dropdown se llena solo con
   lo que devuelve `GET /v1/models` de la cuenta real. Sin modelo elegido, el
   agente no corre (pide elegir). Sin catálogos de fallback.
2. **Historial propio.** Las sesiones del agente viven en
   `globalStorage/agent-sessions/` (JSON por sesión), separadas del almacén de
   Claude (`~/.claude/projects`), y aparecen en el árbol de Chats con prefijo ⚡.
3. **Carpeta de trabajo por defecto:** `Documentos\KeyRotator Agent` (se crea al
   primer uso). El modelo puede cambiarla (`set_working_folder`) — p.ej. a
   Descargas si el usuario lo pide — pero SIEMPRE con pop-up de permiso.
4. **Seguridad de rutas (preocupación explícita del usuario):** toda operación
   de archivo queda confinada a la carpeta de trabajo actual. Rutas absolutas o
   `..` que escapen → rechazadas por `pathGuard` antes de tocar el disco.
   Ampliar el alcance solo vía `set_working_folder` aprobado por el usuario.
5. **Permisos:** leer/listar libres (como Claude). Escribir, borrar, ejecutar
   comando y cambiar carpeta → pop-up modal con **Permitir / Permitir todo en
   este chat / Denegar**. "Permitir todo" es por categoría y por conversación;
   una conversación nueva resetea.
6. **Tope de 25 pasos por turno** (llamadas al modelo) para evitar loops.
7. Rate limit NVIDIA (40 rpm): throttle cliente a 35 rpm ya implementado.

## Componentes

- `src/agent/pathGuard.ts` — `resolveInside(base, p)`: null si escapa. Puro.
- `src/agent/permissions.ts` — `PermissionGate` con `ask(category, detail)`;
  el prompt (showWarningMessage modal) se inyecta → testeable puro.
- `src/agent/tools.ts` — definiciones OpenAI (`AGENT_TOOLS`) + `executeTool`.
  Herramientas: `read_file` (cap 50 KB), `list_directory`, `write_file`,
  `delete_file` (solo archivos; carpetas → negarse), `run_command`
  (cwd = carpeta de trabajo, timeout 60 s, salida capada), `set_working_folder`.
- `src/agent/agentLoop.ts` — streaming SSE que acumula `content` +
  `tool_calls` fragmentados (helper puro `accumulateChunk`) y loop
  llamar→ejecutar→reinyectar (`role:'tool'`) hasta terminar o 25 pasos.
- `src/agent/agentStore.ts` — persistencia JSON, ids `agent-<uuid>`.
- Integración: `ChatSession` rutea provider `nvidia`/`openrouter` al agente;
  `extension.ts` provee contexto (cwd default, gate con UI, store) vía
  `ChatBackend.getAgentContext()`.

## Riesgos aceptados

- `run_command` puede tocar fuera de la carpeta (un comando es arbitrario);
  la defensa es el pop-up con el comando exacto. Prompt injection en contenido
  leído → misma defensa: nada destructivo sin clic del usuario.
- Tool-calling varía por modelo en NVIDIA NIM; si el modelo elegido no soporta
  tools, el error del proveedor se muestra tal cual.

## Pendiente futuro (fuera de alcance v1)

- Imágenes adjuntas (vision) en el agente.
- Failover automático entre cuentas DENTRO de un turno de agente (hoy: el 429
  rota en el chat simple; en el agente se reporta y el usuario reintenta).
