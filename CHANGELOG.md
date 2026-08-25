# Changelog

Todas las versiones de KeyRotator y qué cambió en cada una. Las fechas son la
del release. El formato sigue [Keep a Changelog](https://keepachangelog.com/es/).

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
