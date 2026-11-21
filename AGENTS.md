# AGENTS.md · Drena

Esta guía aplica a todo el repositorio del equipo 34 de Platanus Hack 26, track Physical World. La dirección de producto viene de la «Versión unificada» del documento de alineación del equipo del 21 de noviembre de 2026. Consulta el código y las pruebas para confirmar el estado de cada integración.

## Producto y decisiones

Drena convierte evidencia de calle en dos decisiones para la central municipal durante una lluvia. Propone qué sumideros atender y con qué ruta, e identifica recorridos y paraderos de buses expuestos al mismo incidente. La central aprueba misiones y avisos. La cuadrilla recibe el recorrido en el celular y documenta la limpieza con una foto de cierre.

- **Claude interpreta evidencia.** Valida sus respuestas con los esquemas de la API. En una foto de rejilla registra si se puede evaluar, su estado y el material visible. En un cuadro de calle registra agua respecto de la cuneta o la vereda. En texto extrae tipo, gravedad, ubicación, antigüedad y riesgo para personas. Usa la caché por hash del contenido y versión del prompt. Las explicaciones se construyen a partir del cálculo y preservan el puntaje.
- **La fórmula v1 ordena.** El código reúne los datos numéricos de las fuentes y las observaciones asociadas. La prioridad combina el puntaje de obstrucción ajustado por evidencia vigente y cadenas calle abajo con la consecuencia según el área de aporte, la infraestructura crítica y el agua observada. Presenta el resultado como puntaje de priorización. Usa los YAML versionados y documenta cualquier cambio de pesos. [Justificación de los pesos](docs/pesos.md)
- **El despacho propone.** Considera equipo, acceso, traslado y tiempo de intervención. Usa hidrojet para sedimento y herramientas manuales para hojas. OSRM calcula el recorrido por calle y Google Maps permite abrirlo en el celular. Al recalcular, conserva las misiones ya iniciadas.
- **Movilidad muestra exposición.** Cruza los tramos con agua observada o prioridad alta con el GTFS de DTPM. Muestra servicio, sentido y un paradero alternativo fuera del tramo expuesto para el mismo servicio y sentido. Los avisos de desvíos requieren confirmación de Red.
- **El mapa representa evidencia.** Usa las cadenas calle abajo y flechas en el sentido de la pendiente para mostrar el escurrimiento estimado. Distingue agua observada, prioridad calculada y cobertura de las fuentes. El agua visible señala un incidente en el tramo. La causa y el estado de una rejilla requieren evidencia propia.

## Contratos y datos

- Usa `ID_IDE` del catastro SIALL de la DOH como identidad estable del sumidero. El mapa cubre Providencia, Ñuñoa y Las Condes con un catastro parcial de 3.002 rejillas. Muestra el ranking donde estén calculadas sus variables. Conserva los valores desconocidos, incluida la capacidad que el catastro marca como `-99`. [Catastro y regeneración](data/README.md)
- Usa el modelo de elevación y las calles de OSM para pendiente, área de aporte y cadenas. Las coberturas de suelo y árboles provienen de ESA WorldCover. OSM aporta mercados, obras e infraestructura crítica. Open-Meteo es la fuente prevista de lluvia y viento. Pasa estos valores numéricos directamente desde sus adaptadores al cálculo.
- Preserva fuente, ubicación, hora de captura y unidad cuando corresponda. Registra los tiempos en UTC y muestra la hora de Santiago. Separa captura de recepción y deja las ubicaciones inciertas pendientes de verificación. Una imagen no evaluable deja vigente la observación previa hasta que expire. Un reintento del mismo reporte conserva su ID y evita duplicar efectos.
- Los reportes entran por `/reportar` y `POST /observations`. Si hay personas en riesgo, muestra los números de emergencia de inmediato y marca el caso como urgente. Mantén las fotos en el almacenamiento privado y las credenciales privilegiadas en el backend. Conserva la protección de escrituras y los permisos de lectura pública vigentes.
- Rotula los datos simulados, de ejemplo o reproducidos tanto en la interfaz como en los registros que los contienen. Para una reproducción, usa solo la evidencia disponible en cada instante del evento.
- Confirma las condiciones de uso antes de automatizar la captura de cámaras UOCT. Usa un celular fijo o cuadros guardados y rotulados para el ensayo. Los caudales del Maipo son una posible capa de contexto para Antes, fuera del cálculo de sumideros. SOSAFE queda como integración futura. [Disponibilidad de caudales](docs/canales-maipo.md)

## Demo y trabajo pendiente

- El escenario es un radio de 700 m alrededor del MUT, entre Providencia y Las Condes. El ranking congelado contiene 46 rejillas. En **Antes** se muestra la tabla y la ruta inicial. **Durante** es el centro de la demo. Una foto de obstrucción enviada desde un segundo celular cambia la prioridad y la siguiente parada en el tablero y en el móvil. Un cuadro con agua muestra la exposición de un paradero. En **Después** la cuadrilla registra el cierre con una foto. Usa una foto preparada o una maqueta para mantener despejadas las rejillas reales. [Guion de la demo](docs/guion-pitch.md) · [Metadatos del ranking congelado](data/validacion/prediccion_congelada.meta.json)
- La alineación prevé ponderar las observaciones según la confianza de Claude con factores 1,0, 0,7 y 0,4. Verifica el estado de esa ponderación, la integración de Open-Meteo en vivo, el recálculo de la siguiente misión, la visualización de exposición GTFS y la clasificación de la foto de cierre en sus módulos respectivos antes de presentarlos como disponibles.
- El alcance de la demo deja para etapas futuras los sensores físicos, drones, voz de cuadrilla, lectura de redes sociales, simulación hidráulica, visualización 3D, estimación de profundidades y desvíos completos de recorridos.

## Repositorio y arranque

- `backend/` contiene FastAPI y Python 3.12. `app/main.py` monta los routers. `app/schemas/claude.py` define el contrato de clasificación. `app/services/formula.py` y `app/services/scoring.py` calculan el ranking con `config/formula.yaml` para la demo y `config/formula_validacion.yaml` para validar. `db/migrations/` contiene las migraciones de Postgres/PostGIS.
- `frontend/` contiene Next.js, TypeScript y MapLibre. `app/reportar/` monta la captura vecinal. `lib/api.ts` y `lib/observations.ts` conectan las vistas con la API. `components/desktop/` y `components/mobile/` contienen la central y la vista de cuadrilla. Al cambiar un contrato, revisa los tipos y consumidores web.
- `pipeline/` genera catastro, cadenas, variables, predicción congelada y extracto GTFS. Ejecuta estos scripts desde la raíz y conserva los metadatos de procedencia. Los archivos que consume el mapa están en `frontend/public/data/`. El extracto de transporte está en `backend/data/transporte_mut.json`.
- Para ejecutar la API local, parte de la raíz del repositorio y configura las credenciales necesarias con `backend/.env.example`.

  ```bash
  cd backend
  python3.12 -m venv .venv
  .venv/bin/python -m pip install -r requirements-dev.txt
  .venv/bin/python -m uvicorn app.main:app --reload --port 8000
  ```

- Para ejecutar la web en otra terminal, parte de la raíz del repositorio. La API local por defecto es `http://localhost:8000`. Consulta `frontend/.env.example` para configurar otra URL.

  ```bash
  cd frontend
  npm ci
  npm run dev
  ```

- El frontend se despliega en Vercel, la API en Render y los datos en Supabase. Usa el flujo del espejo documentado al publicar un despliegue. [Configuración local y despliegue](docs/deploy.md)

## Verificación

- Ejecuta las pruebas pertinentes con `.venv/bin/python -m pytest` en `backend/`. Las pruebas de integración usan `DRENA_TEST_INTEGRACION=1` con una base de pruebas configurada. Para cambios web, ejecuta `npm run build` en `frontend/`. Para integración verifica `GET /health` y una llamada desde la web. `GET /health/db` comprueba la conexión a la base.
- Para cambios operativos, sigue el flujo afectado desde la captura hasta la central y el móvil. Cubre según corresponda fotos no evaluables, reintentos, reportes urgentes y misiones ya iniciadas. En el ensayo cronometra el intervalo desde la foto hasta que se actualiza la misión.
- La validación principal reproduce una lluvia real hora a hora en un sector con anegamientos documentados y variables calculadas. Congela la predicción y los pesos antes del contraste. Compara dónde y cuándo subieron los puntajes o la urgencia con los incidentes y con dos referencias, un ranking aleatorio y otro por área de aporte. Si se ajustan pesos después, conserva ambas versiones. Incorpora reclamos municipales del mismo evento si están disponibles.
- Para evaluar a Claude, usa imágenes con fuente y licencia registradas, etiquetadas por dos personas de forma independiente. Mantén las imágenes de prueba fuera de los ejemplos del prompt e informa coincidencias y casos no evaluables.
