# KeyRotator

Extensión de VS Code que convierte tus API keys de **NVIDIA Build** (y **OpenRouter**)
en un agente con herramientas —o en una agencia de varios modelos coordinados— dentro
del editor: lee y escribe archivos, ejecuta comandos, busca en la web, genera imágenes
e investiga a fondo, todo con tu aprobación explícita en cada paso sensible.

Cada API key que agregas equivale a un modelo. No hay configuración de proveedor
genérico ni credenciales sueltas: pegas el código de ejemplo de build.nvidia.com y la
extensión detecta el resto sola.

## Instalación

```bash
npm install
npm run package
code --install-extension key-rotator-0.1.0.vsix
```

## Primeros pasos

1. Abre el panel **KeyRotator** en la barra de actividad (ícono de llave).
2. En la vista **API Keys**, haz clic en el ícono 📋 ("Pegar código") —o abre el
   **Dashboard** ("KeyRotator: Open Dashboard") y usa la caja de texto.
3. Pega ahí el bloque de código de ejemplo de build.nvidia.com (o de OpenRouter) tal
   cual, o solo tu API key. Se detectan automáticamente el proveedor, el endpoint, el
   modelo y los parámetros (`temperature`, `top_p`, `max_tokens`, `seed`).
4. Si el código traía una key de ejemplo (un marcador de posición), se te pide la real
   en un campo oculto.
5. La cuenta queda creada —con el nombre del modelo— y el chat se abre listo para
   usarla.
6. Repite para cada modelo. La lista de la vista **API Keys** muestra cada uno por su
   nombre, en orden alfabético, con un botón para eliminarlo.

## Verificar qué modelos funcionan de verdad

El catálogo de modelos que devuelve la API no siempre coincide con lo que tu cuenta
puede usar en la práctica: algunos dan error, otros tardan minutos en responder o
nunca lo hacen. Haz clic derecho sobre un modelo (o usa "KeyRotator: Probar conexión")
para correr un análisis real: dos peticiones para medir velocidad y consistencia, más
una prueba de si el modelo invoca herramientas de verdad. El resultado es un
veredicto:

- ✅ **recomendado** — responde rápido y soporta herramientas.
- ⚠️ **usable** — funciona, pero con un aviso concreto (lento, inconsistente, o sin
  soporte de herramientas).
- ⛔ **no viable** — no respondió ninguna vez; se excluye automáticamente del equipo
  del Modo agencia.

## Chat — Modo individual

- El selector **Modelo** (parte inferior) lista todos tus modelos —uno por API key—
  en orden alfabético. Elegir uno cambia de cuenta al instante.
- Arrastra un archivo sobre la conversación para que el agente lo lea (si está fuera
  de su carpeta de trabajo, te pide aprobación antes).
- El botón **+** adjunta un archivo o una imagen (visión, si el modelo la soporta).
- El agente puede: leer, listar, crear y borrar archivos; ejecutar comandos; cambiar
  su carpeta de trabajo; cargar tus Skills; buscar en tus conversaciones anteriores;
  buscar en la web; leer una página completa; y generar imágenes.
- El interruptor **🔬 Investigación profunda** está apagado por defecto: así, un
  simple saludo no dispara búsquedas. Actívalo para que el modelo contraste varias
  fuentes con fecha verificada antes de responder.
- El botón **Enviar** se convierte en **Detener** mientras responde. Puedes seguir
  escribiendo durante ese tiempo: los mensajes se encolan y se envían al terminar el
  turno en curso.
- Una línea de estado en vivo (con cronómetro) muestra qué está haciendo el modelo en
  cada momento —buscando, leyendo un archivo, razonando, procesando el resultado de
  una herramienta— para que nunca parezca congelado.

## Chat — Modo agencia

Se activa desde el menú ▾ junto al nombre de la cuenta activa. En este modo un
**modelo director** (el mejor disponible, con preferencia por los de Google; también
puedes fijarlo tú desde el Dashboard) organiza el trabajo en cuatro etapas:

1. **Investigación** — decide qué disciplinas necesita la tarea (por ejemplo,
   backend/frontend/seguridad para un programa) y qué modelo tuyo rinde mejor en
   cada una, validando con búsquedas reales qué tan reciente es cada dato.
2. **Preparación del entorno** — carga las Skills que la investigación identificó
   como útiles y deja disponibles tus integraciones MCP.
3. **Trabajo en paralelo** — cada especialista hace su parte a la vez, con su propia
   API key y el mismo set de herramientas del modo individual.
4. **Síntesis** — el director integra las entregas en una única respuesta.

El equipo queda fijo para esa conversación: si luego dices que "esta parte no
funciona", el director enruta el mensaje al responsable de esa área, que se presenta,
investiga la causa real y la corrige. Si un especialista falla repetidamente, el
director puede reemplazarlo por otro de tus modelos —pasándole el contexto de lo ya
hecho— o, si ninguno da la talla, investigar en build.nvidia.com y proponerte un
candidato con su currículum (fortalezas, evidencia con fecha, limitaciones). Tú
decides si lo agregas; al avisar que ya está integrado, el modelo nuevo toma el
puesto y continúa el trabajo pendiente.

## Carpetas que usa

- `Documents\KeyRotator` — carpeta de trabajo por defecto: ahí quedan los scripts,
  archivos y resultados que genere el agente (subcarpeta `salidas\` para imágenes).
- `Documents\KeyRotator Chats` — el historial de conversaciones, en su propio
  almacén, separado del de Claude Code.
- `Documents\KeyRotator Config` — tu configuración propia de MCP (`mcp.json`) y de
  Skills (`skills\`).

## MCP y Skills

El Dashboard tiene pestañas para administrar tus servidores **MCP** y tus **Skills**
(ver, editar, agregar, eliminar), con botones para sincronizarlos desde tu
configuración de Claude Code (`~/.claude.json` y `~/.claude/skills`). Nota: las
integraciones gestionadas por claude.ai (Canva, Google Drive, Gmail, Calendar) son
OAuth y no se pueden vincular por esta vía; solo los servidores MCP que se lanzan con
un comando propio funcionan aquí.

## Vista lateral y barra de estado

La vista **API Keys** lista tus modelos; haz clic derecho sobre uno para más opciones
(probar conexión, renombrar, eliminar, ajustar prioridad). El ítem de la barra de
estado muestra cuántos de tus modelos están activos y permite reportar un límite de
uso detectado antes del próximo chequeo automático.

## Soporte heredado: chat clásico de Claude

Si no tienes ningún modelo de NVIDIA Build u OpenRouter configurado, el chat cae de
vuelta a un modo clásico que conversa con Claude lanzando el CLI `claude` por debajo,
con rotación entre cuentas de Anthropic. No es el flujo principal de la extensión,
pero el código sigue ahí. Se controla con `keyRotator.chatMode`:

- `full` (por defecto) — usa tu login de Claude tal cual, sin rotación.
- `profiles` — login aislado por cuenta; rota entre ellas conservando las
  integraciones de claude.ai.
- `failover` — rota por API key (`ANTHROPIC_API_KEY`); requiere saldo de la Consola
  de Anthropic, ya que tu suscripción Pro/Max no cubre llamadas por API key.

## Configuración

### Agente / Modo agencia

| Setting | Default | Descripción |
|---|---|---|
| `keyRotator.agencyDirector` | `"auto"` | Qué modelo dirige la agencia. `"auto"` elige el mejor disponible; también puedes poner el id exacto de uno de tus modelos, o elegirlo en el Dashboard. |
| `keyRotator.agentUseMcp` | `true` | Permite que el agente use tus servidores MCP. Cada llamada pide aprobación. |
| `keyRotator.openRouterModel` | `""` | Modelo fijo opcional para cuentas de OpenRouter. Vacío = eliges desde el selector del chat. |
| `keyRotator.geminiApiKey` | `""` | API key de Gemini para identificar proveedores desconocidos al pegar una key suelta (opcional). |
| `keyRotator.healthCheckIntervalMinutes` | `5` | Frecuencia del chequeo de salud periódico por cuenta. |
| `keyRotator.preferPrimary` | `true` | Volver a la cuenta de mayor prioridad cuando se recupera de un límite de uso. |

### Chat clásico de Claude (heredado)

| Setting | Default | Descripción |
|---|---|---|
| `keyRotator.chatMode` | `"full"` | `full` = login único sin rotación. `profiles` = login aislado por cuenta. `failover` = API key + rotación. |
| `keyRotator.chatModel` | `""` | Modelo para el chat clásico (`opus`, `sonnet`, o un id completo). Vacío = default del CLI. |
| `keyRotator.chatEffort` | `""` | Nivel de esfuerzo/razonamiento (`--effort`). Vacío = default del modelo. |
| `keyRotator.chatMcpConfig` | `""` | Ruta a un JSON `{"mcpServers":{...}}` propio; se carga tanto en el chat clásico como en el agente. |
| `keyRotator.chatExtraArgs` | `[]` | Argumentos extra para el CLI `claude` del chat clásico. |
| `keyRotator.webChatBrowser` | `"auto"` | Navegador que usa el chat web (cuentas tipo DeepSeek). |
| `keyRotator.webChatUseRealProfile` | `false` | Usar tu perfil real del navegador (con tu sesión de Google) en vez de uno aislado. |

## Seguridad

Las API keys se guardan exclusivamente en el Secret Storage de VS Code (cifrado por
el sistema operativo). Nunca se escriben en el historial, las estadísticas ni en
archivos del repositorio. Los archivos, scripts y comandos que produce el agente
quedan confinados a su carpeta de trabajo; salir de ella —al leer, escribir, borrar o
ejecutar algo— requiere tu aprobación explícita.

## Limitación conocida

VS Code no permite leer el output interno de un modelo mientras responde, así que la
detección de problemas combina chequeos de salud periódicos, el análisis de
viabilidad bajo demanda ("Probar conexión") y un comando manual
("KeyRotator: Report Rate Limit on Active Account") para los casos detectados antes
del próximo chequeo automático.

## Desarrollo

```bash
npm install
npm test       # corre los tests de la lógica core
npm run watch  # recompila en modo watch
```

Presiona `F5` en VS Code (con este proyecto abierto) para lanzar una ventana de
"Extension Development Host" con KeyRotator cargado.
