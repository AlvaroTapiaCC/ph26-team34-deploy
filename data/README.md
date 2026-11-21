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

## Lluvia y viento del replay (`data/escenarios/`)

Serie horaria real de Open-Meteo para cada evento candidato del replay (#86), desde un día antes
hasta un día después del evento. Se regenera desde la raíz con:

```bash
python pipeline/11_clima_historico.py                     # 2026-10-13 y 2026-07-16_17
python pipeline/11_clima_historico.py --lat … --lon …     # si #86 elige otro centro de sector
```

- **Horas en UTC** (`hora_utc`) y en Santiago (`hora_santiago`) para mostrar. La lluvia de una hora es la acumulada en la hora anterior.
- **Observado:** Historical Forecast API (`best_match`). **Pronóstico ya emitido:** Previous Runs API
  (`precipitation_previous_day1`), así el modo «tormenta inminente» de cada hora solo usa información que existía en ese momento.
- `clima` (0-1) y `modo` (`seco`, `tormenta_inminente`, `durante`, `despues`, `sin_dato`) salen de
  `backend/config/clima.yaml` con `backend/app/services/clima_serie.py`. Los umbrales se fijaron antes de mirar el replay.
  Un dato faltante deja `clima` nulo y el modo en `sin_dato`, nunca un 0.
- `<evento>.meta.json` registra las URLs de consulta, la celda de la grilla usada, la fecha de descarga y el sha256 de la salida, de la config y del script.

## Obsoleto

`data/sumideros_nunoa.geojson` y `pipeline/01_sumideros.py` quedan solo como referencia: no los usa nadie.
Tienen los mismos `ID_IDE`, pero filtran Ñuñoa por el código comunal de la DOH (1062 rejillas) en vez de por
los límites comunales (1055).
