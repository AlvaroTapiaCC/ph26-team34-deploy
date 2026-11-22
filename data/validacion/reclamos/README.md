# Reclamos de Atención Vecino frente al ranking congelado (#72)

Esta es la validación complementaria de [#86](https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/86). Contrasta los tickets municipales de drenaje con el ranking A del mismo sector que usa el replay de julio: el sector histórico de Las Condes de [#87](https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/87), centrado en `[-70.541, -33.418]`, con 1.500 m de radio y 562 rejillas rankeadas (`prediccion_replay_julio.csv`). También lo compara con las dos referencias del replay: el área de aporte y el promedio de 1.000 permutaciones con semilla 86. Se usa la misma configuración congelada, verificada con su sha256, y no se cambió ningún peso.

## Fuente

- Fuente y atribución a la Municipalidad de Las Condes, capa «Atención Vecino» (id 6) del Portal de Datos Abiertos. La exportación del 15-11-2026 contiene 116.304 tickets entre febrero de 2022 y noviembre de 2026. La descarga se registró el 22-11-2026 a las 01:21 UTC y su SHA-256 consta en cada `.meta.json`. [Portal municipal](https://datos.lascondes.cl/datos)
- El Decreto 1862/2025 documenta una política de reutilización con licencias Creative Commons que exige atribuir a la fuente y declarar la licencia específica de cada conjunto. La Cuenta Pública 2025 confirma el uso de Creative Commons en el portal. Sigue pendiente confirmar la variante de licencia de Atención Vecino y sus condiciones para difundir los agregados fuera del equipo. [Decreto 1862/2025, §8.8](https://archivos.lascondes.cl/descargas/transparencia/ordenanzas/2025/mayo/decreto.1862.30may2025.pdf#page=15) · [Cuenta Pública 2025, p. 147](https://archivos.lascondes.cl/descargas/municipalidad/2026/cuenta-publica/CUENTA-PUBLICA-LAS-CONDES-2025.pdf)
- La fecha de creación del ticket tiene resolución diaria. Los tickets registran lo que informó cada vecino sobre el drenaje.

## Privacidad

El CSV crudo incluye la dirección y las coordenadas del domicilio de quien hace la solicitud. El script exige que se guarde fuera del repositorio. Procesa esas columnas en memoria para asignar cuadras, delimitar el sector y calcular distancias. La salida contiene solo totales y métricas por evento y sector.

## Método

- Se filtran los tipos de solicitud «Sumideros de Aguas Lluvias» y «Anegamiento por aguas lluvias o desbordamiento de canales».
- La metadata del clima en `data/escenarios/` fija los días completos de cada evento en hora de Santiago.
- Una cuadra del sector está cubierta si alguno de sus tickets tiene a menos de 100 m una rejilla del 20 % superior. También se informan los cortes de 10 % y de 50 m. La agrupación por calle y tramo de numeración de 100 se usa solo para calcular la métrica.
- Se usa el ranking A porque los tickets tienen resolución diaria.

## Resultados

### 16 y 17 de julio de 2026, evento del replay de #86 ([resultado](2026-07-16_17_replay_julio.json))

En el evento se registraron 12 tickets de drenaje en la comuna. El sector del replay concentra **6 tickets en 3 cuadras**.

| Corte | Fórmula (ranking A) | Solo área de aporte | Azar (1.000 permutaciones) |
|---|---|---|---|
| 20 % superior, < 100 m (principal) | **0 de 3 (0 %)** | 1 de 3 (33,3 %) | 22,9 % |
| 10 % superior, < 100 m | 0 de 3 (0 %) | 0 de 3 (0 %) | 11,5 % |
| 20 % superior, < 50 m | 0 de 3 (0 %) | 0 de 3 (0 %) | 5,4 % |
| 10 % superior, < 50 m | 0 de 3 (0 %) | 0 de 3 (0 %) | 2,9 % |

El 20 % superior corresponde a los puestos 1 a 113. El denominador incluye todas las cuadras evaluadas según la métrica, dada la cobertura parcial del catastro. Con tres cuadras, el resultado es descriptivo.

### 13 de octubre de 2026, complementario en el sector MUT ([resultado](2026-10-13_mut.json))

Este contraste complementario usa el ranking A congelado del MUT. En el evento hubo 5 tickets de drenaje en la comuna y 2 en el sector, agrupados en una cuadra. En el corte principal, el ranking A obtuvo 0 %, el área de aporte 100 % y el azar 74,4 %. El resultado es descriptivo.

## Regenerar

Ejecuta el script desde la raíz con una copia autorizada del CSV guardada fuera del repositorio.

```bash
python pipeline/14_reclamos.py --crudo /ruta/fuera/del/repo/atencion_vecino.csv \
  --descargado-utc 2026-11-22T01:21:28Z \
  --clima-meta data/escenarios/2026-07-16_17.meta.json \
  --prediccion data/validacion/prediccion_replay_julio.csv
```

El portal actualiza la capa, así que una descarga nueva cambia el SHA-256 del crudo y puede cambiar los conteos. Para reproducir las cifras hay que usar un archivo con el SHA-256 registrado y su hora de descarga. Las salidas publicadas conservan las cifras del cálculo versionado. Las pruebas en `pipeline/tests/test_reclamos.py` usan tickets sintéticos y ejecutan el script con la consola en cp1252, como Windows.
