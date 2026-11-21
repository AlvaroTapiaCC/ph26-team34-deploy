# Catastro de sumideros de Ñuñoa

Desde la raíz del repositorio, ejecuta `python3 pipeline/01_sumideros.py` para regenerar
`data/sumideros_nunoa.geojson`. El script usa la biblioteca estándar de Python y
requiere conexión al servicio público de la DOH. Usa `--salida` para exportar a otra ruta.

El archivo incluye un punto por `ID_IDE` de la capa SUMIDEROS con código comunal
`13120` y estado `EXISTENTE`. Las coordenadas están en WGS84, en orden
`[longitud, latitud]`. Usa `feature.id` o `properties.ID_IDE` para vincular el
activo con otras fuentes. Para filas idénticas con el mismo `ID_IDE` se conserva
el menor `OBJECTID`. [Capa SUMIDEROS de SIALL](https://rest-sit.mop.gob.cl/arcgis/rest/services/DOH/SIALL/MapServer/3)

Los valores numéricos `-99` de la fuente se representan como `null`. En este
catastro, `CAPA_CAPT` (capacidad de captación en L/s) es desconocida para todos los
sumideros. Las posiciones provienen del levantamiento de la DOH y quedan
pendientes de verificación en terreno. El campo `metadata` registra el origen,
el filtro, la fecha de descarga UTC y los `OBJECTID` duplicados descartados.
