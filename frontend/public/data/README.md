# Datos del mapa

Estos archivos son una copia generada de `data/` (en la raíz del repo). No se editan a mano.

| Archivo | Origen |
|---|---|
| `comunas.geojson` | `data/comunas.geojson` (`pipeline/00_comunas.py`, límites de OpenStreetMap) |
| `comunas_rm.geojson` | `pipeline/00b_comunas_rm.py`: límites de las 32 comunas de la Provincia de Santiago más Puente Alto, San Bernardo y Pirque (OpenStreetMap, `admin_level=8`, consultado por Nominatim el 21-nov-2026), simplificados a 10 m y 5 decimales. Solo contexto visual del mapa. Propiedades: `comuna`, `en_proyecto`, `lon`/`lat` (punto de la etiqueta). Fuente, fecha y sha256 en `data/comunas.meta.json` (clave `comunas_rm`) |
| `flujo.geojson` | `pipeline/04_flujo.py`: red de escurrimiento del plan B de #75 (calles de OSM, elevación Copernicus GLO-30, flujo D8 sobre el grafo). 1.606 tramos dirigidos de aguas arriba a aguas abajo (caudal de área acumulada, pendiente, tramo siguiente) y 544 sumideros del catastro con el tramo, la posición y el siguiente sumidero aguas abajo. Los tramos sin dirección no se exportan. Detalle de las propiedades en el docstring del script. Fuente y sha256 en `data/flujo.meta.json` |
| `rejillas.geojson` | `data/rejillas.geojson` (`pipeline/02_rejillas.py`, catastro SIALL de la DOH), solo `id` y `comuna` |
| `recorridos.geojson` | `backend/data/transporte_mut.json` (`pipeline/09_gtfs.py`, GTFS de DTPM), un trazado por servicio y sentido |
| `cadenas_mut.geojson` | `data/street_chains_mut.json`, `data/terreno_mut.csv` y `data/rejillas.geojson`. Une rejillas consecutivas de las cadenas que tocan la zona MUT en el sentido de la pendiente. Guarda la distancia de cada tramo y las huellas de los insumos. |
| `contexto_mut.geojson` | `pipeline/publicar_contexto_front.py`: capas de contexto de la central. Infraestructura crítica de `data/osm_mut.geojson` (centroides), colectores SIALL de `data/las_condes/colectores_siall.geojson` recortados a una caja alrededor del MUT y puntos críticos de `data/las_condes/puntos_criticos_invierno_2026.geojson`. Cada elemento lleva `capa`, `tipo`, `nombre` y `fuente`. No entra a la fórmula. |

`comunas_rm.geojson` y `flujo.geojson` los escriben directamente `pipeline/00b_comunas_rm.py` y `pipeline/04_flujo.py` (no pasan por `publicar_front.py`). Si Overpass no responde, `pipeline/04a_red_osm_api.py` baja la red de calles por la API 0.6 de OSM antes de correr `04_flujo.py`.

Para regenerar los demás cuando cambie `data/`:

```
python pipeline/publicar_front.py
python pipeline/publicar_front.py --solo-recorridos   # si solo cambió el extracto GTFS
```
