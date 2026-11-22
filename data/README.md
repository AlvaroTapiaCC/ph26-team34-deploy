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

## Variables de otro sector (replay, #87)

`03_terreno.py`, `04_variables.py` y `05_prediccion.py` usan por defecto la zona MUT, con 700 m alrededor de
Av. Apoquindo 2730. Sin argumentos, sus salidas no cambian. Para otro sector se agregan un centro, un radio y un sufijo:

```bash
python pipeline/03_terreno.py --centro=-70.5975,-33.4565 --radio 700 --sufijo replay --nota "de dónde sale el centro"
python pipeline/04_variables.py --sufijo replay
python pipeline/05_prediccion.py --sufijo replay
```

- El `=` de `--centro` es necesario porque el valor empieza con `-`.
- Las salidas son `terreno_<sufijo>.csv`, `street_chains_<sufijo>.json`, `variables_<sufijo>.csv`,
  `osm_<sufijo>.geojson` y `validacion/prediccion_<sufijo>.csv`, cada una con su `.meta.json`.
  La metadata registra centro, radio, nota, tesela del DEM, hashes y versión de cada script.
- La columna de zona se llama `en_zona_<sufijo>`. `07_cargar.py` solo etiqueta como `zona_mut` la columna
  `en_zona_mut`, así que cargar un sector del replay no lo mezcla con la demo.
- `PENDIENTE_REF` se recalcula como el p90 de las rejillas del sector. Queda en `parametros.pendiente_ref`.
- 04 y 05 toman el centro y el radio de `terreno_<sufijo>.meta.json`, para que terreno y variables usen la
  misma zona. La tesela del DEM y la de WorldCover se eligen según el centro.
- La primera vez, la red de calles de OSM tarda varios minutos en bajar. Conviene lanzarla apenas se decida el sector.

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

## Fuentes complementarias de Las Condes

Los archivos de [`las_condes/`](las_condes/) apoyan el replay y la revisión del terreno. Se obtienen con las dependencias de `pipeline/requirements.txt` y el comando `python pipeline/13_las_condes.py`. Cada archivo incluye metadatos de fuente, descarga, cobertura, unidades y SHA-256.

| Archivo | Cobertura |
| --- | --- |
| `colectores_siall.geojson` | 631 tramos de la capa 6 de SIALL con comuna Las Condes. |
| `subareas_tributarias_siall.geojson` | 64 polígonos de la capa 12 de SIALL que intersectan el límite comunal del catastro. Se conserva la geometría completa. |
| `puntos_criticos_invierno_2026.geojson` | 29 de los 33 puntos del Programa Invierno de SENAPRED. Se excluyeron cuatro vinculados a domicilios. Son antecedentes de riesgo por recurrencia, sin fecha de ocurrencia. |
| `pronostico_rotonda_atenas_2026-07-16.csv` | 48 horas nominales de la corrida ECMWF IFS inicializada el 16 de julio a las 06:00 UTC para el sector Rotonda Atenas. Un campo vacío indica que el proveedor no entregó ese dato. |

La versión pública disponible de la capa 12 produjo 64 subáreas con este filtro. Queda por cotejar con el extracto de 103 mencionado en la issue. También quedan pendientes la capa municipal de canales y los archivos de Atención Vecino y arbolado. [Issue #74](https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/74) · [Portal de Datos Abiertos de Las Condes](https://datos.lascondes.cl/)

## Obsoleto

`data/sumideros_nunoa.geojson` y `pipeline/01_sumideros.py` quedan solo como referencia: no los usa nadie.
Tienen los mismos `ID_IDE`, pero filtran Ñuñoa por el código comunal de la DOH (1062 rejillas) en vez de por
los límites comunales (1055).
