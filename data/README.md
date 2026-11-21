# Datos del pipeline

## Catastro de rejillas (fuente única)

`data/rejillas.geojson` es el **único catastro** que usa el sistema: 3002 rejillas de la capa
SUMIDEROS del [SIALL de la DOH](https://rest-sit.mop.gob.cl/arcgis/rest/services/DOH/SIALL/MapServer/3)
en Providencia, Ñuñoa y Las Condes. Se regenera desde la raíz del repo con:

```bash
pip install requests geopandas osmnx
python pipeline/00_comunas.py     # límites comunales → data/comunas.geojson
python pipeline/02_rejillas.py    # catastro → data/rejillas.geojson + rejillas.meta.json
python pipeline/publicar_front.py # copia liviana para el mapa (frontend/public/data/)
```

- **ID estable:** `ID_IDE` (p. ej. `AL13SU013887`). `OBJECTID` puede cambiar si la DOH republica la capa.
  Los registros repetidos con el mismo `ID_IDE` se descartan (queda el `OBJECTID` menor) y se listan en la metadata.
- **Coordenadas** WGS84, orden `[longitud, latitud]`. El servicio oculta la geometría en `/query`; se piden a `/identify`.
- **Comuna:** `comuna` sale del recorte por límites comunales y es la que manda. `COMUNA` (DOH) se conserva y
  `comuna_discrepa` marca dónde difieren.
- **Valores `-99`** de la fuente significan dato desconocido. `CAPA_CAPT` (capacidad) es desconocida en todas.
- `data/rejillas.meta.json` registra fecha de descarga, servicio, conteos (incluido el de 700 m del MUT),
  sha256 del GeoJSON y versión y sha256 del script. Si se vuelve a correr el script, cambian la fecha y el hash.

## Obsoleto

`data/sumideros_nunoa.geojson` y `pipeline/01_sumideros.py` quedan solo como referencia: no los usa nadie.
Tienen los mismos `ID_IDE`, pero filtran Ñuñoa por el código comunal de la DOH (1062 rejillas) en vez de por
los límites comunales (1055).
