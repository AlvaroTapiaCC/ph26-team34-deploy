# Plan de desarrollo: Drena (Platanus Hack 26, equipo 34)

> **Para quién es**: el equipo y Claude Code. Claude Code debe usar este documento para crear los issues en GitHub (sección 11).
> **Estado: v1**, sábado 21 de noviembre, 10:00. Integra el diseño de `feat/front-v1` y el documento "Fuentes de datos y modelo de prioridad". Pasa a ser la referencia oficial cuando todo el equipo lo valide. Si el diseño o cualquier otro documento lo contradice, manda este.
> **Entrega:** domingo 22 de noviembre a las 15:00.
> **Documentos relacionados:**
> - `claude/contexto-track-physical-world.md`: reglas del track, rúbrica y competencia.
> - `claude/descripcion-solucion.md`: problema y solución. Parte de su contenido quedó obsoleto con esta versión; ver la sección 10.

---

## 1. Qué es Drena

Drena ayuda a los municipios a **prevenir y responder a las inundaciones por lluvia urbana**. El foco son las anegaciones comunes por sumideros tapados, no solo los aluviones. Funciona en **tres fases** de un evento de lluvia:

| Fase | Pregunta que responde | Resultado |
|---|---|---|
| Antes | ¿Qué sumideros tienen más probabilidad de estar tapados y qué pasa si se tapan? | Tabla de misiones priorizada y rutas para las cuadrillas de limpieza |
| Durante | ¿Qué está pasando ahora y qué hay que atender primero? | Prioridades recalculadas en vivo con fotos, textos y cámara; casos urgentes; rutas que se reordenan |
| Después | ¿Se resolvió? ¿Qué funcionó y qué falló? | Cierres verificados con foto, informe del evento y datos para mejorar la fórmula |

### 1.1 Principio central

**La fórmula decide; Claude ve, lee y explica.**

- **Claude** convierte fotos, cuadros de cámara y textos en valores con formato fijo, siempre con las mismas opciones. También explica cada prioridad en lenguaje simple.
- **Una fórmula determinista**, con pesos fijados por el equipo, calcula la prioridad. Con los mismos datos, da siempre el mismo resultado.
- **Lo confirmado manda.** Si una foto muestra una rejilla limpia o tapada, ese valor queda fijo y se recalcula todo lo que está aguas abajo.

### 1.2 Cómo se cuenta en el pitch

"Hoy nadie sabe en qué estado están los miles de sumideros de una comuna. Revisarlos todos a mano es imposible. **Claude son los ojos**: convierte cualquier foto o cámara en un dato confiable. Con eso, una fórmula transparente y auditable dice a qué cuadrilla mandar, dónde y en qué orden, antes, durante y después de la lluvia. Esto no se podía hacer antes de la IA generativa."

> Esto responde a la crítica de los mentores ("lo estático basta con calcularlo una vez"): el estado de las rejillas, las hojas, la basura de la feria, la lluvia y el agua acumulada cambian todo el tiempo, y el sistema los percibe.

---

## 2. Decisiones tomadas en esta versión

| # | Tema | Decisión | Por qué |
|---|---|---|---|
| D1 | Rol de Claude | Claude ve, lee y explica; la fórmula decide | Auditable, reproducible y defendible ante el jurado. Claude sigue siendo indispensable (sección 1.2) |
| D2 | Agua en la foto | Niveles fijos: `sin_agua`, `cuneta`, `hasta_vereda`, `sobre_vereda`, `no_evaluable` | Coherente con D1; más confiable que estimar centímetros |
| D3 | Unidad de análisis | **El sumidero**. En el mapa se agrupan por intersección para que se lean mejor | La fórmula y la validación de campo trabajan por rejilla; el diseño actual trabaja por intersección |
| D4 | Comuna | **Ñuñoa** como comuna principal, con datos reales y validación de campo. Providencia y Las Condes solo como contexto visual si sobra tiempo | La validación de campo se hace en Ñuñoa |
| D5 | Despacho y rutas | **Se mantienen**: convierten la tabla de misiones en acción (qué cuadrilla, en qué orden y por dónde) | Es lo que el track reconoce ("despacho que reasigna rutas") y suma ambición |
| D6 | Fase Después | **Se mantiene**: cierre con foto clasificada por Claude e informe del evento. La recalibración de pesos es opcional | Cierra el ciclo y suma ambición |
| D7 | Hardware, drones y cámaras municipales en vivo | **No se construyen ni se usan.** Quedan como fuentes futuras en el pitch | Hardware armado por el equipo cae en otro track; drones necesitan autorización de la DGAC; las cámaras municipales necesitan un convenio |
| D8 | Cámara en la demo | Un **celular fijo grabando una calle real** | Entrada física real, cumple el track |
| D9 | Stack | Next.js en Vercel, FastAPI en Render, Supabase (Postgres + PostGIS, Storage, Realtime), API de Claude, ElevenLabs, MapLibre con OSM, OSRM u OpenRouteService | Ya desplegado o gratuito |
| D10 | Apps | Una sola app Next.js con tres secciones: `/central` (escritorio), `/cuadrilla` y `/reportar` (celular) | Menos trabajo y un solo deploy |
| D11 | Textos del diseño | No son definitivos; se ajustan a este documento | — |

---

## 3. Estado actual

- **Deploy funcionando:**
  - Frontend en Vercel: proyecto `ph26-team34`, carpeta `frontend`.
  - Backend en Render: `https://ph26-team34-api.onrender.com`, plan gratuito, carpeta `backend`.
  - Repo personal espejo `AlvaroTapiaCC/ph26-team34-deploy`; cada `git push` sube a los dos repos.
  - Falta borrar `render.yaml`, que no se usa.
- **Rama `feat/front-v1`:** diseño "Drena" implementado con datos de ejemplo.
  - Tokens, componentes base y mapa MapLibre con capas.
  - Vistas de escritorio: Antes, Ficha, Durante, Validación, Metodología, estados y modales.
  - Vistas de celular.
  - `lib/store.tsx`, estado global de la app.
  - `lib/data.ts`, datos de ejemplo: 11 intersecciones, 3 escenarios, ruta, escurrimiento, celda GOES-19 y puntos del Gobierno de Santiago.
  - Menciona un sensor ESP32 y Firebase; se reemplazan según D7 y D9.
- **Créditos:** API de Claude y ElevenLabs (sponsors). Los de Render están por confirmar; se parte en plan gratuito.

---

## 4. Fuentes de datos

| Fuente | Qué aporta | Cómo se analiza | En la demo |
|---|---|---|---|
| Catastro de sumideros (DOH) | Ubicación de cada sumidero | Carga directa | Real. Si la consulta falla, se usan los sumideros que fotografiemos, con ubicación GPS |
| Modelo de elevación de 12,5 m (IDE Chile) y calles de OpenStreetMap (OSMnx) | Pendiente de cada tramo de calle, hacia dónde corre el agua, área que le llega a cada sumidero y orden de los sumideros en una misma calle | Cálculo geográfico, sin IA | Real. Ojo: el modelo de 12,5 m probablemente es uno de 30 m reescalado, pero sirve para pendientes de calles |
| Satélite (Sentinel-2, ESA WorldCover) | Lo que casi no cambia: árboles, zonas quemadas, suelo desnudo, obras y superficie impermeable aguas arriba | Cálculo geográfico, sin IA | Real |
| Árboles, comercio y obras en OSM | Fuentes de hojas, basura y sedimento | Cálculo geográfico | Real |
| Calendario de ferias de Ñuñoa | Días y ubicación de las ferias (fuente de basura) | Dato directo | Real, si lo encontramos |
| Lluvia y viento (Open-Meteo, DMC) | Lluvia pronosticada y observada; viento y lluvia recientes | Dato directo | Real |
| Infraestructura crítica (OSM) | Metro, pasos bajo nivel, hospitales y colegios cerca | Cálculo geográfico | Real |
| Puntos críticos del Gobierno de Santiago (175) | Contexto y validación | Carga directa | Real |
| **Cámara** | Lo que cambia entre un evento y otro: hojas en la calzada, basura después de la feria, agua acumulada. No necesita ver la rejilla | Claude describe cada cuadro | Celular fijo grabando una calle real de Ñuñoa |
| **Reportes de vecinos** | Foto de la rejilla, foto del agua acumulada o solo texto | Claude clasifica la foto o extrae los datos del texto | Real, con fotos tomadas por el equipo |
| **Fotos de las cuadrillas** | Estado antes y después de limpiar | Claude clasifica | Real o reutilizando fotos del equipo |
| Historial de limpieza y cuadrillas | Días desde la última limpieza; equipos y equipamiento disponibles | Dato directo | **Simulado y marcado como simulado** |
| Anegamientos reales del temporal de octubre de 2026 (prensa, redes, @TTISantiago) | Validación histórica y fotos para el modo "Durante" | Geolocalización manual y clasificación de Claude | Real |

**Fuera del plan, se mencionan como fuentes futuras:**

- Sensores físicos: requieren aprobación municipal, compra e instalación.
- Drones: solo para revisar una quebrada puntual. Requieren autorización de la DGAC.
- Cámaras municipales en vivo: requieren un convenio con el municipio.

**Regla para datos simulados:** deben ser verosímiles ("datos tipo") y llevar `is_simulated = true` en la base de datos. La interfaz los marca como simulados.

---

## 5. Qué hace Claude

Claude **no predice ni decide el orden**. Tiene cuatro tareas y siempre responde en JSON validado (con Pydantic en el backend).

### 5.1 Clasificar la foto de una rejilla

```json
{
  "evaluable": true,
  "rejilla": "limpia | parcial | tapada | no_evaluable",
  "material": ["hojas", "basura", "sedimento"],
  "hojas_calzada": "pocas | muchas",
  "agua_visible": true,
  "nivel_agua": "sin_agua | cuneta | hasta_vereda | sobre_vereda | no_evaluable",
  "confianza": "alta | media | baja",
  "nota": "texto breve en español"
}
```

La app pide la foto desde arriba, a un metro, con la rejilla completa en el cuadro.

### 5.2 Describir un cuadro de la cámara

Usa el mismo esquema, sin el campo `rejilla`. Agrega `basura_calzada: "poca | mucha"`.

### 5.3 Leer el texto de un vecino

```json
{
  "tipo": "anegamiento | rejilla_tapada | basura | arbol_caido | otro",
  "gravedad": "baja | media | alta",
  "personas_en_riesgo": false,
  "ubicacion_texto": "esquina o dirección mencionada",
  "desde_cuando": "texto o null",
  "nivel_agua": "sin_agua | cuneta | hasta_vereda | sobre_vereda | no_evaluable"
}
```

Si `personas_en_riesgo = true`, la app muestra de inmediato los números de emergencia (133, 132, 131) y el reporte queda marcado como **urgente**.

### 5.4 Explicar cada prioridad

A partir de los números de la fórmula, Claude redacta un texto breve. Ejemplo: "Prioridad 2. Recibe el agua de 1,2 km² y tiene árboles encima; mañana hay feria a 80 m. Hay una estación de Metro cerca." Este texto solo se muestra: **no cambia el orden**.

### 5.5 Reglas comunes

- **Caché:** cada respuesta de Claude se guarda (clave: hash de la imagen o del texto + versión del prompt). No se vuelve a llamar con lo mismo, y la demo da siempre el mismo resultado.
- **Guardar** el modelo usado, la latencia y la respuesta cruda.
- Si la respuesta no pasa la validación, se reintenta una vez. Si vuelve a fallar, el resultado queda `no_evaluable`.

---

## 6. La fórmula

El código convierte las respuestas de Claude en números (por ejemplo, tapada = 0,95, parcial = 0,6, limpia = 0,05) y calcula en cuatro pasos. **Todos los pesos viven en `backend/config/formula.yaml`**: los fijamos nosotros a criterio, porque no hay registros reales para entrenar.

### 6.1 Paso 1: probabilidad de que el sumidero se tape (P)

Todas las variables se normalizan entre 0 y 1:

```
P_pred = clamp( w_arb·arboles + w_feria·feria_cercana_proxima + w_obra·obras
              + w_suelo·(quemado|suelo_desnudo aguas arriba) + w_pend·arrastre_pendiente
              + w_clima·(viento+lluvia recientes) + w_dias·dias_sin_limpieza
              + w_cam·señal_camara , 0, 1 )
```

- **Lo confirmado manda:** si hay una foto reciente con `rejilla` evaluable, P = valor observado (0,95 / 0,6 / 0,05) y no se usa P_pred.
- **Predicción congelada de validación:** usa `backend/config/formula_validacion.yaml`, igual a `formula.yaml` pero con `w_dias = w_cam = 0` y los otros pesos reescalados para sumar 1. La demo usa `formula.yaml`.
- Los reportes de texto sin foto suben P, pero pesan menos que una foto (por ejemplo, ×0,5).
- Varios reportes parecidos en la misma cuadra suben la confianza y, con ella, P.

### 6.2 Paso 2: efecto en cadena calle abajo (P_ef)

- Se ordenan los sumideros de cada calle del más alto al más bajo, según la elevación.
- La P de cada sumidero se suma a la de los que están más abajo, porque reciben más agua y el mismo material:

```
P_ef(i) = min( P(i) + α · Σ_{j aguas arriba} P(j) · e^(-d_ij / λ) , P(i) + tope )
```

- α: intensidad del efecto.
- λ: distancia a la que se diluye.
- tope: evita que una calle larga quede entera en rojo.

### 6.3 Paso 3: consecuencia (C)

```
C = norm(área_que_le_llega) · (1 + w_crit · criticidad_cercana)
```

`criticidad_cercana` considera Metro, paso bajo nivel, hospital, colegio y punto crítico del Gobierno de Santiago, dentro de un radio configurable.

### 6.4 Paso 4: prioridad

```
Prioridad = P_ef × C
```

Se ordena todo y eso es la **tabla de misiones**.

### 6.5 Ajustes para la fase "Durante"

- Con lluvia en curso, se suma la **agua observada**: `C_durante = C · (1 + w_agua · nivel_agua_observado)`, con `sobre_vereda` = 1, `hasta_vereda` = 0,6, `cuneta` = 0,3 y `sin_agua` = 0.
- Los reportes **urgentes** (personas en riesgo) se saltan la tabla y van primero, marcados en rojo.
- Cada nueva observación recalcula P, P_ef y la prioridad aguas abajo, y luego las rutas.

### 6.6 Visión futura (para el pitch)

Con los registros de limpieza de un municipio, la fórmula podría **aprender sus pesos**.

---

## 7. Las tres fases en detalle

### 7.1 Antes

1. Se calcula P_pred, P_ef, C y la prioridad de todos los sumideros de Ñuñoa con datos públicos.
2. **Escenarios de lluvia** (del diseño): según dónde cae la lluvia (pronóstico de Open-Meteo y, si se consigue, celda GOES-19), cambia el área que le llega a cada sumidero y por lo tanto la consecuencia.
3. Se genera la **tabla de misiones** y la **ruta de limpieza** para N cuadrillas.
4. Las cuadrillas y los vecinos pueden mandar fotos de las rejillas; cada foto confirma su estado y recalcula.
5. La cámara vigila calles con feria o con muchos árboles y actualiza la señal de hojas y basura.

### 7.2 Durante

1. Llegan reportes de vecinos (foto del agua o texto), fotos de las cuadrillas y cuadros de la cámara.
2. Claude los clasifica (sección 5) y el sistema los agrupa por cercanía: menos de 75 m y menos de 60 minutos cuentan como el mismo caso.
3. La fórmula recalcula y aplica el efecto aguas abajo (sección 6.5).
4. **Despacho:** cada misión se asigna a la cuadrilla con el equipamiento necesario (por ejemplo, hidrojet), más cerca por calle y con menos carga. Se reordena su ruta y se publica en vivo.
5. La app de la cuadrilla muestra la siguiente misión y la lee en voz alta con ElevenLabs.
6. La central puede corregir a mano cualquier prioridad o asignación, y su decisión manda.

### 7.3 Después

1. **Cierre verificado:** la cuadrilla toma una foto al terminar. Claude la clasifica (sección 5.1) y la misión se cierra solo si la rejilla queda `limpia` y sin agua sobre la vereda.
2. **Informe del evento:** Claude redacta, a partir de los datos del evento, un resumen con:
   - casos por sector y tiempos de respuesta;
   - sumideros que se taparon más de una vez;
   - aciertos y errores del ranking "Antes";
   - recomendaciones de limpieza preventiva. Las cifras las calcula el código; Claude solo las redacta.
3. *(Opcional)* Recalibrar los pesos de la fórmula con los resultados del evento.

---

## 8. Validación para el pitch

La validación prueba **por separado** las dos piezas del sistema: la fórmula que predice y Claude que observa.

### 8.1 Prueba de campo (imprescindible)

1. Elegir **unas 20 rejillas** en dos o tres calles de Ñuñoa, mezclando: con y sin árboles, cerca y lejos de una feria, arriba y abajo de una pendiente.
2. Correr la fórmula **solo con datos públicos** y guardar el ranking en un **commit con fecha y hora**, para demostrar que la predicción se hizo antes de salir. En esta prueba no entra "días desde la última limpieza", porque no lo tenemos para Ñuñoa.
3. Fotografiar las 20 rejillas con la app `/reportar`, que guarda GPS y hora.
4. Etiquetar las fotos **dos veces**: dos personas del equipo, cada una por separado, las marcan como limpia, parcial o tapada. Claude clasifica las mismas fotos.
5. Comparar:
   - **¿Acierta la fórmula?** De las rejillas tapadas, cuántas estaban en la mitad alta del ranking. Ejemplo: "6 de las 8 tapadas estaban entre nuestras 10 primeras".
   - **¿Acierta Claude?** En cuántas fotos coincide con las personas. Ejemplo: "18 de 20".

**Advertencias para el pitch:**

- Veinte rejillas son evidencia, no prueba: se presenta como una primera prueba de campo.
- En noviembre puede haber pocas rejillas tapadas, porque no es época de caída de hojas. Si salen 2 de 20, se muestra igual; la comparación de Claude con las personas sigue valiendo.

### 8.2 Validación histórica (deseable)

Comparar las zonas de mayor prioridad con los anegamientos reales del temporal de octubre de 2026 y con los 175 puntos críticos. La vista "Validación" ya está en el diseño.

> **Verificar la fecha del temporal:** el diseño dice 13 de octubre y algunas notas de prensa dicen 14.

---

## 9. Arquitectura y datos

### 9.1 Componentes

- **Frontend:** Next.js (App Router, TypeScript) en Vercel, con `/central`, `/cuadrilla` y `/reportar`.
- **Backend:** FastAPI (Python 3.12) en Render. Servicios: clasificación con Claude, fórmula, despacho, rutas, voz e informe.
- **Supabase:** Postgres con PostGIS, Storage (bucket `photos`) y Realtime.
- **Pipeline "Antes":** scripts de Python en `/pipeline`, que se corren en local. Generan las variables de cada sumidero y las cargan a Supabase.
- **Rutas:** OSRM público u OpenRouteService, con caché. **Mapa:** MapLibre con OSM.

### 9.2 Flujo general

```
Fuentes públicas ──► /pipeline ──► variables por sumidero ─┐
                                                            ▼
Foto / texto / cámara ──► POST /observations ──► Claude (JSON fijo, caché)
                                                            │
                                                            ▼
                                   Fórmula (P → P_ef → C → prioridad)
                                                            │
                                   ┌────────────────────────┴───────────┐
                                   ▼                                    ▼
                     Tabla de misiones + explicación        Despacho y rutas (OSRM)
                                   │                                    │
                                   └────────── Supabase Realtime ───────┘
                                                 │              │
                                             /central   /cuadrilla (+ voz)
```

### 9.3 Estructura del repo

```
/backend
  app/main.py
  app/routers/       sumideros, observations, missions, crews, routes, events, sim
  app/services/      claude_vision.py, claude_text.py, explain.py, formula.py,
                     dispatch.py, routing.py, voice.py, report.py, cache.py
  app/schemas/       modelos Pydantic de las respuestas de Claude
  config/formula.yaml
  db/migrations/     SQL
/frontend
  app/central/  app/cuadrilla/  app/reportar/
  components/  lib/
/pipeline            01_sumideros.py, 02_dem_calles.py, 03_satelite.py,
                     04_osm_features.py, 05_ferias_clima.py, 06_formula_base.py, 07_cargar.py
/data                geojson generados, fotos de la demo, demo_timeline.json,
                     validacion/ (ranking guardado, etiquetas humanas, resultados)
/docs                deploy.md, decisiones.md
```

### 9.4 Tablas (Supabase)

| Tabla | Campos principales |
|---|---|
| `sumideros` | id, geom, fuente (doh/campo), intersection_id, street_id, orden_en_calle, elevacion, features (jsonb: arboles, feria, obras, suelo, pendiente, area_aporte, criticidad), is_simulated |
| `intersections` | id, nombre, geom, comuna |
| `street_chains` | street_id, sumidero_ids ordenados de mayor a menor elevación, distancias |
| `scenarios` | id, nombre, descripción, parámetros de lluvia |
| `observations` | id, sumidero_id (nullable), geom, fuente (vecino/cuadrilla/camara), tipo (foto_rejilla/foto_agua/texto/cuadro_camara), media_url, texto, ts, is_simulated |
| `classifications` | observation_id, resultado (jsonb, esquemas de la sección 5), modelo, prompt_version, cache_key, latencia_ms |
| `scores` | sumidero_id, scenario_id, modo (antes/durante), p_pred, p_obs, p_ef, c, prioridad, rank, explicacion, computed_at |
| `cases` | id, geom, sumidero_id, estado (abierto/asignado/en_curso/resuelto/descartado), urgente, abierto_at, cerrado_at |
| `case_observations` | case_id, observation_id |
| `crews` | id, nombre, equipamiento (text[]), estado, geom_actual, is_simulated |
| `crew_positions` | crew_id, geom, ts |
| `missions` | id, crew_id, sumidero_id o case_id, orden, estado, asignada_at, cerrada_at |
| `routes` | crew_id, version, geojson, paradas (jsonb), computed_at |
| `closures` | mission_id, foto_url, clasificacion (jsonb), verificado |
| `cleaning_history` | sumidero_id, fecha, is_simulated |
| `events` | id, tipo, payload, ts (línea de tiempo para auditoría, informe y repetición de la demo) |
| `claude_cache` | cache_key, respuesta, modelo, created_at |

Realtime activado en: `scores`, `cases`, `missions`, `routes`, `crews`, `observations`.

### 9.5 Endpoints principales

| Método y ruta | Qué hace |
|---|---|
| `GET /health` | Ya existe |
| `GET /scenarios` · `GET /scenarios/{id}/ranking?modo=antes\|durante` | Tabla de misiones |
| `GET /sumideros/{id}` | Ficha: variables, cadena aguas abajo, observaciones y explicación |
| `POST /observations` | Foto o texto → Claude → recálculo → despacho. Devuelve la clasificación y si es urgente |
| `POST /formula/recompute` | Recalcula todo (uso interno o de la demo) |
| `GET /crews` · `POST /crews/{id}/position` · `GET /crews/{id}/route` | Cuadrillas y rutas |
| `POST /missions/{id}/status` · `POST /missions/{id}/close` | Avance y cierre con foto |
| `GET /crews/{id}/next/audio` | Audio de ElevenLabs con la siguiente misión |
| `GET /events/report` | Informe "Después" |
| `POST /sim/start`, `/sim/stop`, `/sim/reset` | Línea de tiempo de la demo |

---

## 10. Alcance, hitos y riesgos

### 10.1 Alcance

**Imprescindible:**

1. Pipeline "Antes" con datos reales de Ñuñoa.
2. Fórmula y tabla de misiones en `/central`.
3. Clasificación de fotos con Claude y "lo confirmado manda".
4. `/reportar` con foto y texto.
5. Despacho, rutas y mapa en vivo.
6. `/cuadrilla` básica.
7. Prueba de campo de 20 rejillas.
8. Deploy en producción.

**Deseable:**

- Voz con ElevenLabs.
- Cámara con celular fijo.
- Explicaciones de Claude.
- Fase Después (cierre verificado e informe).
- Validación histórica.
- Escenarios de lluvia.

**Opcional:**

- Recalibrar los pesos.
- Detector YOLO propio.
- Canal de WhatsApp.
- Providencia y Las Condes.

### 10.2 Hitos (hoy sábado 10:00; entrega domingo 15:00)

| Hito | Hora | Listo cuando |
|---|---|---|
| H1: Base | Sáb 13:00 | Supabase con el esquema; backend conectado; `feat/front-v1` integrado en `main`; `formula.yaml` creado |
| H2: Predicción guardada | Sáb 16:00 | Pipeline con datos reales de las calles elegidas; ranking de las 20 rejillas **en un commit con fecha y hora** |
| H3: Prueba de campo | Sáb 19:00 | 20 fotos tomadas con luz de día; etiquetas de dos personas; Claude clasificando |
| H4: Durante completo | Sáb 23:59 | Foto o texto → Claude → recálculo → despacho → ruta en vivo en `/central` |
| H5: Cuadrilla, voz y Después | Dom 07:00 | `/cuadrilla` con voz; cierre verificado; informe |
| H6: Congelar el código | Dom 11:00 | Todo en producción; solo arreglos críticos |
| H7: Demo | Dom 11:00–15:00 | Guion ensayado, video de respaldo, `platanus-hack-project.jsonc` completo |

> La prueba de campo **tiene que hacerse con luz de día el sábado**. Si se atrasa, se hace el domingo temprano, antes de las 09:00.

### 10.3 Riesgos

| Riesgo | Mitigación |
|---|---|
| El pitch se entiende como "la IA es un adorno" | Usar el mensaje de la sección 1.2: sin Claude no se puede ver el estado de miles de rejillas |
| La consulta al catastro de la DOH falla | Usar los sumideros fotografiados, con su GPS |
| No aparece el calendario de ferias de Ñuñoa | Usar ferias mapeadas en OSM o ubicarlas a mano; la variable queda marcada como aproximada |
| Pocas rejillas tapadas en noviembre | Mostrar igual el resultado; la comparación entre Claude y las personas sigue valiendo |
| Claude falla o tarda | Caché, reintento único, y respuestas pre-guardadas para las fotos de la demo |
| Render gratis se duerme (~50 s) | Despertarlo antes de la demo o pasar a un plan pagado con créditos |
| Límites de OSRM y ElevenLabs | Caché de rutas y audios |
| El diseño menciona ESP32 y Firebase | Reemplazar por la cámara con celular y Supabase (D7, D9) |
| `descripcion-solucion.md` quedó desactualizado (profundidad en cm, "la IA decide", dron como entrada) | Actualizarlo con este enfoque |

---

## 11. Issues en GitHub

Los issues ya están creados en `platanus-hack/platanus-hack-26-cl-team-34` (#2 a #53; el issue N° k del plan es el #k+1).

**Etiquetas:**

- Área: `area:frontend`, `area:backend`, `area:ia`, `area:datos`, `area:infra`, `area:demo`
- Fase: `fase:antes`, `fase:durante`, `fase:despues`, `transversal`
- Prioridad: `prio:imprescindible`, `prio:deseable`, `prio:opcional`
- Esfuerzo: `esfuerzo:S` (< 1 h), `esfuerzo:M` (1–3 h), `esfuerzo:L` (> 3 h)

**Milestones:** `H1 Base`, `H2 Predicción`, `H3 Campo`, `H4 Durante`, `H5 Cuadrilla+Después`, `H6 Freeze`, `H7 Demo`.

No asignar responsables desde Claude Code. No modificar `README.md`.

### Épica 0: Infraestructura (`area:infra`, `transversal`)

1. **Integrar `feat/front-v1` en `main`**: resolver conflictos con el scaffold, verificar `npm run build` y el deploy en Vercel. *H1, imprescindible.*
2. **Borrar `render.yaml` y escribir `docs/deploy.md`**: URLs, variables de entorno, redeploy manual en Render y repo espejo. *H1, imprescindible.*
3. **Crear Supabase con el esquema de la sección 9.4**: PostGIS, Realtime y bucket `photos`; migraciones en `backend/db/migrations`. *H1, imprescindible.*
4. **Conectar el backend a Supabase**: variables en Render y endpoint de prueba. *H1, imprescindible. Depende de 3.*
5. **Conectar el frontend a Supabase**: cliente, suscripción Realtime de ejemplo y variables en Vercel. *H1, imprescindible. Depende de 3.*
6. **Secretos**: `ANTHROPIC_API_KEY` y `ELEVENLABS_API_KEY`; `.env.example` en backend y frontend. *H1, imprescindible.*
7. **Estructura del backend** (sección 9.3): routers, servicios, schemas y `config/formula.yaml` con pesos iniciales documentados. *H1, imprescindible.*

### Épica 1: Datos y pipeline "Antes" (`area:datos`, `fase:antes`)

8. **Catastro de sumideros de la DOH para Ñuñoa**: probar la consulta y, si falla, dejar el plan B documentado. *H2, imprescindible.*
9. **Elevación y calles**: DEM de 12,5 m de IDE Chile + OSMnx; pendiente por tramo, área que le llega a cada sumidero y orden de los sumideros en cada calle (`street_chains`). *H2, imprescindible.*
10. **Variables de satélite**: árboles, zonas quemadas, suelo desnudo y superficie impermeable aguas arriba (Sentinel-2, WorldCover). *H2, imprescindible.*
11. **Variables de OSM**: árboles mapeados, comercio, obras e infraestructura crítica (Metro, pasos bajo nivel, hospitales, colegios). *H2, imprescindible.*
12. **Ferias y clima**: calendario de ferias de Ñuñoa (o plan B con OSM) y lluvia y viento recientes y pronosticados de Open-Meteo. *H2, imprescindible.*
13. **Cargar a Supabase** las variables por sumidero y las cadenas por calle. *H2, imprescindible. Depende de 3 y de 8 a 12.*
14. **Elegir las 20 rejillas de la prueba de campo** según los criterios de la sección 8.1, y armar un mapa de la salida. *H2, imprescindible. Depende de 8.*
15. **Datos de cuadrillas e historial de limpieza simulados** (`is_simulated = true`). *H2, imprescindible.*
16. **Escenarios de lluvia** (pronóstico y, si se consigue, GOES-19). *H4, deseable.*
17. **Anegamientos reales de octubre geolocalizados**, para la validación histórica y como fotos del modo "Durante" (con fuente). *H4, deseable.*

### Épica 2: Fórmula (`area:backend`, `transversal`)

18. **Paso 1: probabilidad P** con las variables normalizadas y "lo confirmado manda" (sección 6.1). Tests unitarios. *H2, imprescindible. Depende de 7.*
19. **Paso 2: efecto en cadena calle abajo** con decaimiento por distancia y tope (sección 6.2). Tests. *H2, imprescindible. Depende de 18.*
20. **Pasos 3 y 4: consecuencia y prioridad** (secciones 6.3 y 6.4), más el endpoint del ranking. *H2, imprescindible. Depende de 19.*
21. **Guardar la predicción de la prueba de campo** en `data/validacion/ranking_<fecha>.json` y hacer un commit **antes** de salir. *H2, imprescindible. Depende de 13, 14 y 20.*
22. **Ajustes del modo "Durante"** (sección 6.5): agua observada, casos urgentes y recálculo aguas abajo. *H4, imprescindible. Depende de 20.*

### Épica 3: Claude (`area:ia`)

23. **Clasificar fotos de rejillas** (sección 5.1): prompt, schema Pydantic, caché y reintento. *H3, imprescindible.*
24. **Clasificar cuadros de cámara** (sección 5.2). *H4, deseable. Depende de 23.*
25. **Leer textos de vecinos** (sección 5.3), con detección de personas en riesgo. *H4, imprescindible.*
26. **Explicar cada prioridad** (sección 5.4). *H4, deseable. Depende de 20.*
27. **Endpoint `POST /observations`**: clasificar, asociar al sumidero más cercano (y preguntar si hay dos cerca), agrupar en casos, recalcular y despachar. *H4, imprescindible. Depende de 22, 23, 25 y 30.*

### Épica 4: Prueba de campo (`area:demo`, `fase:antes`)

28. **Salida a terreno**: fotografiar las 20 rejillas con `/reportar` (desde arriba, a un metro, rejilla completa). *H3, imprescindible. Depende de 21 y 33.*
29. **Etiquetado y comparación**: dos personas etiquetan por separado; Claude clasifica; se calculan los aciertos de la fórmula y de Claude (sección 8.1); resultados en `data/validacion/`. *H3, imprescindible. Depende de 23 y 28.*

### Épica 5: Despacho y rutas (`area:backend`, `fase:durante`)

30. **Servicio de rutas** (OSRM u OpenRouteService) con caché. *H4, imprescindible.*
31. **Despacho y re-planificación**: equipamiento, distancia por calle y carga; nueva versión de la ruta por Realtime. *H4, imprescindible. Depende de 20 y 30.*
32. **Endpoints de cuadrillas, misiones y rutas** (sección 9.5). *H4, imprescindible. Depende de 4.*

### Épica 6: Frontend (`area:frontend`)

33. **`/reportar`**: foto de la rejilla, foto del agua o solo texto; GPS y hora; guía para sacar la foto; elegir el sumidero si hay dos cerca; mostrar la clasificación; números de emergencia si hay personas en riesgo. *H3, imprescindible. Depende de 23.*
34. **`/central` modo Antes con datos reales**: reemplazar `lib/data.ts` por la API o Supabase; mostrar sumideros agrupados por intersección; ficha con variables, cadena aguas abajo y explicación. *H2–H4, imprescindible. Depende de 20.*
35. **`/central` modo Durante en vivo**: casos, urgencias, misiones y rutas por Realtime; cuadrillas en movimiento; corrección manual. *H4, imprescindible. Depende de 27 y 31.*
36. **Ajustar los textos del diseño a este documento**: quitar ESP32 y Firebase; explicar "la fórmula decide; Claude ve, lee y explica". *H4, imprescindible.*
37. **`/cuadrilla`**: misiones en orden, mapa, "llegué / terminé", cierre con foto y "Abrir en Google Maps". *H5, imprescindible. Depende de 32.*
38. **Voz de ElevenLabs** en `/cuadrilla`, con caché del audio. *H5, deseable. Depende de 37.*
39. **Vista Validación** con los resultados de la prueba de campo y, si existe, la validación histórica. *H5, imprescindible. Depende de 29.*
40. **Vista Después**: cierres verificados e informe. *H5, deseable. Depende de 41 y 42.*

### Épica 7: Después (`area:ia`, `fase:despues`)

41. **Cierre verificado con foto** (sección 7.3). *H5, deseable. Depende de 23.*
42. **Informe del evento**: las cifras las calcula el código y Claude las redacta. *H5, deseable.*
43. **Recalibrar los pesos** con los resultados. *Opcional.*

### Épica 8: Demo y pitch (`area:demo`)

44. **Cámara con celular fijo**: grabar una calle de Ñuñoa y enviar cuadros al backend cada N segundos. *H4, deseable. Depende de 24.*
45. **Simulador de la línea de tiempo** (`data/demo_timeline.json` y `/sim/*`), con la opción de disparar un reporte en vivo. *H4, imprescindible. Depende de 27 y 32.*
46. **Guion del pitch de 3 minutos**: mensaje de la sección 1.2, resultados de la prueba de campo, diferenciación frente a Corea y Busan, y fuentes futuras (sensores, drones, cámaras municipales). *H6, imprescindible.*
47. **Video de respaldo** de la demo. *H7, imprescindible.*
48. **Completar `platanus-hack-project.jsonc`** con la URL y la descripción. *H7, imprescindible.*
49. **Ensayo general y plan B**: despertar Render, revisar la caché de Claude y qué hacer si algo falla. *H7, imprescindible.*

### Épica 9: Opcionales

50. Detector YOLO propio de rejillas tapadas, para comparar con Claude. *Opcional.*
51. Canal de WhatsApp para vecinos. *Opcional.*
52. Extender a Providencia y Las Condes. *Opcional.*
