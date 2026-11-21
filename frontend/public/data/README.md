# Datos del mapa

Estos archivos son una copia generada de `data/` (en la raíz del repo). No se editan a mano.

| Archivo | Origen |
|---|---|
| `comunas.geojson` | `data/comunas.geojson` (`pipeline/00_comunas.py`, límites de OpenStreetMap) |
| `rejillas.geojson` | `data/rejillas.geojson` (`pipeline/02_rejillas.py`, catastro SIALL de la DOH), solo `id` y `comuna` |

Para regenerarlos cuando cambie `data/`:

```
python pipeline/publicar_front.py
```
