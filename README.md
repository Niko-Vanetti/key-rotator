# KeyRotator

Extensión de VS Code para gestionar múltiples cuentas/API keys de proveedores de IA
(Claude/Anthropic, OpenAI, Gemini, Ollama, Qwen, OpenRouter, Groq, y cualquier otro
proveedor compatible) y rotar automáticamente entre ellas cuando una alcanza su límite
de uso.

## Características

- **StatusBar** con el estado de la cuenta activa — clic para reportar un rate limit manualmente.
- **TreeView** lateral con todas las cuentas agrupadas por proveedor.
- **Dashboard** (Keys / Historial / Estadísticas) para gestionar cuentas, ver el historial
  de rotaciones y estadísticas de uso.
- **Chat con failover automático**: una interfaz de chat (similar a Claude Code) que corre
  el CLI `claude` por debajo. Si la cuenta activa llega a su límite de uso **o se queda sin
  saldo**, KeyRotator cambia a la siguiente cuenta y **continúa la misma conversación**
  (vía `--resume`) sin que pierdas el hilo. Ver "Chat con failover" abajo.
- **Auto-detección de proveedor**: pegá una API key y se identifica automáticamente por
  patrón conocido (Anthropic, OpenAI, Gemini, Groq, HuggingFace, Replicate, Cohere,
  Together AI, OpenRouter). Si no se reconoce, usa Gemini Flash (gratis) para
  identificarlo por IA.
- **Rotación automática o con confirmación**, configurable por cuenta.
- **Chequeo de salud periódico** para detectar rate limits proactivamente.
- **Integración con Claude Code**: al rotar, actualiza `ANTHROPIC_API_KEY` en el entorno
  y en `.claude/settings.json` si existe.

## Instalación

```bash
npm install
npm run package
code --install-extension key-rotator-0.1.0.vsix
```

## Uso

1. Abrí el panel **KeyRotator** en la Activity Bar (ícono de llave).
2. Click en `+` (o "KeyRotator: Open Dashboard") para abrir el dashboard.
3. Pegá una API key — el proveedor y la variable de entorno se detectan automáticamente.
4. Completá el nombre de la cuenta y agregala. La prioridad se asigna por orden de carga
   (la primera cuenta de un proveedor es prioridad 1).
5. En cada cuenta podés alternar entre modo **Auto** (rota sola al detectar rate limit)
   y **Confirmar** (te pregunta antes de rotar).
6. Si notás un rate limit antes del próximo chequeo automático, hacé click en el ítem
   de la StatusBar o ejecutá "KeyRotator: Report Rate Limit on Active Account".

## Chat con failover

El **Chat** te deja conversar con Claude dentro de VS Code mientras KeyRotator gestiona
las cuentas por debajo. A diferencia de una sesión de Claude Code autenticada por OAuth
(que no se puede cambiar de cuenta a mitad de sesión), este chat lanza el CLI `claude` en
modo API key (`--bare`), un proceso por turno, y mantiene la continuidad con `--resume`.

Cómo funciona:

1. Abrí el chat con el botón 💬 en la barra de la vista KeyRotator o el comando
   **"KeyRotator: Open Chat"**.
2. Escribí normalmente. El chat usa la cuenta de Anthropic **activa de mayor prioridad**.
3. Cuando esa cuenta llega a su límite de uso **o se queda sin saldo**, KeyRotator:
   - la marca como agotada y rota a la siguiente cuenta activa (motor de rotación existente),
   - relanza el **mismo turno** con `claude --resume <session-id>` y la nueva `ANTHROPIC_API_KEY`,
   - mostrá un aviso "↻ Cambiando a <cuenta>" y **continúa la misma conversación**.
4. El badge del encabezado muestra qué cuenta está activa. El botón "＋ Nuevo" inicia
   una conversación limpia.

Requisitos:

- Tené el CLI `claude` instalado y en el `PATH` (el mismo Claude Code).
- Cada cuenta de Anthropic debe tener una **API key real de la Consola** con saldo/cuota
  disponible (no basta el login OAuth de claude.ai).

> Nota: el chat es una superficie **separada** de esta misma conversación de Claude Code
> en el panel de VS Code. No "continúa" una sesión OAuth ya abierta — eso es una
> limitación de plataforma, no de KeyRotator. Lo que sí logra es darte una experiencia de
> chat ininterrumpida que rueda entre tus cuentas cuando una se agota.

## Configuración

| Setting | Default | Descripción |
|---|---|---|
| `keyRotator.healthCheckIntervalMinutes` | `5` | Frecuencia de chequeo de salud por cuenta |
| `keyRotator.geminiApiKey` | `""` | API key de Gemini para identificación de proveedores desconocidos (opcional) |
| `keyRotator.preferPrimary` | `true` | Volver a la cuenta de mayor prioridad cuando se recupera |
| `keyRotator.chatModel` | `""` | Modelo para el Chat (`opus`, `sonnet`, o un id completo). Vacío = default del CLI |

## Seguridad

Las API keys se guardan exclusivamente en VS Code Secret Storage (cifrado por el
sistema operativo). Nunca se escriben en el historial, estadísticas, ni en archivos
del repositorio.

## Limitación conocida

VS Code no permite leer el output de otras extensiones, por lo que la detección de
rate limit usa chequeos de salud periódicos (`GET /v1/models` o equivalente) más un
comando manual ("Report Rate Limit") para casos detectados antes del próximo chequeo.

## Desarrollo

```bash
npm install
npm test       # corre los tests de la lógica core
npm run watch  # recompila en modo watch
```

Presioná `F5` en VS Code (con este proyecto abierto) para lanzar una ventana de
"Extension Development Host" con KeyRotator cargado.
