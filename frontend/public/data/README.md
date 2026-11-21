# Datos del mapa

Estos archivos son una copia generada de `data/` (en la raíz del repo). No se editan a mano.

| Archivo | Origen |
|---|---|
| `comunas.geojson` | `data/comunas.geojson` (`pipeline/00_comunas.py`, límites de OpenStreetMap) |
| `comunas_rm.geojson` | `pipeline/00b_comunas_rm.py`: límites de las 32 comunas de la Provincia de Santiago más Puente Alto, San Bernardo y Pirque (OpenStreetMap, `admin_level=8`, consultado por Nominatim el 21-nov-2026), simplificados a 10 m y 5 decimales. Solo contexto visual del mapa. Propiedades: `comuna`, `en_proyecto`, `lon`/`lat` (punto de la etiqueta). Fuente, fecha y sha256 en `data/comunas.meta.json` (clave `comunas_rm`) |
| `rejillas.geojson` | `data/rejillas.geojson` (`pipeline/02_rejillas.py`, catastro SIALL de la DOH), solo `id` y `comuna` |

Para regenerarlos cuando cambie `data/`:

```
python pipeline/publicar_front.py
```
