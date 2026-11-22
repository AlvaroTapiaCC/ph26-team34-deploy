# Datos del mapa

Estos archivos son una copia generada de `data/` (en la raíz del repo). No se editan a mano.

| Archivo | Origen |
|---|---|
| `comunas.geojson` | `data/comunas.geojson` (`pipeline/00_comunas.py`, límites de OpenStreetMap) |
| `rejillas.geojson` | `data/rejillas.geojson` (`pipeline/02_rejillas.py`, catastro SIALL de la DOH), solo `id` y `comuna` |
| `recorridos.geojson` | `backend/data/transporte_mut.json` (`pipeline/09_gtfs.py`, GTFS de DTPM), un trazado por servicio y sentido |
| `cadenas_mut.geojson` | `data/street_chains_mut.json`, `data/terreno_mut.csv` y `data/rejillas.geojson`. Une rejillas consecutivas de las cadenas que tocan la zona MUT en el sentido de la pendiente. Guarda la distancia de cada tramo y las huellas de los insumos. |

Para regenerarlos cuando cambie `data/`:

```
python pipeline/publicar_front.py
python pipeline/publicar_front.py --solo-recorridos   # si solo cambió el extracto GTFS
```
