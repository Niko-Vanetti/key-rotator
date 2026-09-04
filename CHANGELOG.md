# Changelog

Todas las versiones de KeyRotator y qué cambió en cada una. Las fechas son la
del release. El formato sigue [Keep a Changelog](https://keepachangelog.com/es/).

## [0.4.1] — 2026-09-04

Pase visual, con el mismo criterio: que la forma diga algo, no que decore.

### Cambiado

- **La lista de modelos deja de ser tarjetas y pasa a ser un manifiesto de
  columnas alineadas.** Antes el veredicto, su motivo y la antigüedad iban
  apretados en una sola línea con `text-overflow: ellipsis` — el motivo casi
  siempre salía cortado y no se podían comparar dos modelos. Ahora los estados
  forman una columna que se escanea en vertical y el motivo se lee entero.
- **Los veredictos usan los colores semánticos del editor**
  (`testing-iconPassed`, `editorWarning-foreground`, `editorError-foreground`),
  así se leen bien en cualquier tema, no solo en el oscuro.
- **La tipografía monoespaciada queda reservada a los identificadores de
  modelo**, que es lo que de verdad es código. Antes decoraba etiquetas.
- Con el selector de modelo ya solo en la barra del chat, sube de 10 a 12 px:
  es el único control que queda y hay sitio para que se lea.

### Eliminado

- **Los 5 `eyebrow`** (etiquetas diminutas en mayúsculas sobre cada encabezado):
  repetían literalmente el título que tenían debajo — "Proveedores" sobre
  "Modelos conectados".
- **Pestaña "Estadísticas"**, fusionada en **"Actividad"**: las estadísticas se
  calculan a partir del historial de rotación, así que eran la misma pantalla
  partida en dos. 5 pestañas → 4.
- El borde de acento del formulario de pegado, que pesaba más que la lista de
  modelos siendo esta lo importante de la pantalla.

## [0.4.0] — 2026-09-02

Limpieza a fondo de la interfaz: **una sola forma de hacer cada cosa**.

### Corregido

- **5 comandos no hacían nada, en silencio.** Al quitarse la vista "API Keys",
  `activateAccount`, `disableAccount`, `deleteAccount`, `moveAccountUp` y
  `moveAccountDown` quedaron sin su nodo de árbol y salían por `if (!id) return`
  — se ejecutaban desde la paleta sin efecto ni aviso. Eliminados.
- **La rotación de modelos API no se registraba en el Historial**: solo se
  guardaban las rotaciones del viejo camino de Claude. Ahora se registra toda.
- El smoke test comprueba los comandos **contra `package.json` en ambos
  sentidos**, así no puede repetirse el caso de comandos huérfanos.

### Eliminado

- **Chat por Claude CLI** (modos `full`/`profiles`/`failover`) y **chat web de
  DeepSeek** (Playwright). El producto es el agente NVIDIA Build / OpenRouter;
  esas superficies causaban la mitad de la redundancia. Con ellas se van
  `playwright-core` y los módulos `streamParser` y `sessionStore`.
- **Comandos: 20 → 8.** `addAccount` era un duplicado exacto de `openDashboard`.
- **Ajustes: 13 → 6.** Fuera `chatModel`, `chatEffort`, `chatMode`,
  `chatExtraArgs`, `webChatBrowser`, `webChatUseRealProfile` y `openRouterModel`
  (este competía con el modelo del snippet como segunda fuente de verdad).
- **Selector "Esfuerzo"**: solo afectaba a Claude CLI; con un modelo de NVIDIA u
  OpenRouter no hacía nada.
- **Badge de modelo duplicado**: repetía el texto del propio selector "Modelo".
- **"Adjuntar imagen"**: compartía handler con "Adjuntar archivo" y solo añadía
  un filtro que escondía PDF, audio y vídeo (que ya funcionan). Ahora el botón
  **+** adjunta directo y el tipo se deduce del archivo.

### Notas

- El paquete baja de 6,4 MB a **4,3 MB** (141 archivos, antes 479).

## [0.3.0] — 2026-08-28

### Agregado

- **Lectura real de documentos**: al adjuntar (arrastrar, Ctrl+V o el botón) un
  **PDF, Word (.docx), Excel (.xlsx) o PowerPoint (.pptx)**, la extensión extrae
  su texto y lo pasa al modelo. Sin dependencias nuevas (solo `zlib` de Node);
  soporta streams Flate y ASCII85 en PDF. No hace OCR: un PDF escaneado (solo
  imágenes) no tiene texto que extraer.
- **Transcripción de voz 100% local**: adjuntar **audio** (mp3, wav, m4a, ogg…)
  o **vídeo** (se le saca la pista de audio) lo transcribe con Whisper corriendo
  en tu propia máquina (transformers.js + onnxruntime nativo), sin enviar nada a
  la nube. Usa `whisper-tiny` cuantizado para andar en equipos modestos; el
  modelo (~40 MB) se descarga una sola vez a `KeyRotator Config/models`.
  Requiere **ffmpeg** en el sistema para decodificar el audio.

### Notas

- El runtime de Whisper se empaqueta solo para **Windows x64** (el binario
  nativo de otras plataformas queda fuera para no inflar el paquete).

## [0.2.0] — 2026-07-26

Reorientación completa: de un rotador de API keys de Claude a un **agente y una
agencia de IA sobre NVIDIA Build / OpenRouter**, con imágenes y multimodal.

### Agregado

- **Agente con herramientas** (NVIDIA Build / OpenRouter): leer, escribir,
  borrar archivos, ejecutar comandos, buscar en la web, leer páginas, cargar
  skills, recordar conversaciones y generar imágenes, con aprobación por acción.
- **Modo agencia**: un director investiga qué modelo rinde mejor en cada parte,
  forma un equipo permanente, trabaja en paralelo, sintetiza, y puede evaluar,
  relevar o proponer contratar modelos nuevos.
- **Modo imágenes**: generar y editar imágenes con los modelos de NVIDIA Build;
  el selector solo muestra modelos de imagen.
- **Analizador de viabilidad** ("Probar"): mide velocidad, consistencia y
  soporte de herramientas de cada modelo y da un veredicto persistente
  (recomendado / usable / no viable / no concluyente). Se corre solo al agregar.
- **Configuración en un pegado**: pega el código de ejemplo de build.nvidia.com
  y se detecta endpoint, modelo, key y parámetros; cada API key = un modelo.
- **Multimodal**: visión (adjuntar/pegar/arrastrar imágenes), sistema de
  capacidades que deduce del snippet qué sabe hacer cada modelo.
- **Skills y MCP**: importar skills desde una carpeta (repo completo),
  sincronizar con Claude Code, usar tus servidores MCP con aprobación.
- Interruptor de investigación profunda, botón Detener + cola de mensajes,
  indicador de actividad en vivo, importar/pegar/arrastrar archivos.

### Cambiado

- La barra lateral ya no muestra "API Keys"; los modelos se gestionan en el
  Dashboard. La UI es responsive (se reacomoda en paneles estrechos).
- El chat es NVIDIA-primero: nunca cae al login de Claude por defecto.
- README reescrito en español neutro reflejando la app real.

### Corregido

- Los modelos de razonamiento (reasoning_content) ya no responden vacío.
- Reintentos ante 500/504/429 y timeouts del gateway; diagnóstico preciso del
  404 "no habilitado" y de los modelos que no son de chat.
- Búsquedas desactualizadas: se inyecta la fecha actual y filtro de recencia.

## [0.1.0]

Versión inicial: rotación de API keys multi-proveedor y chat de Claude con
failover vía el CLI `claude` (hoy soporte heredado).
