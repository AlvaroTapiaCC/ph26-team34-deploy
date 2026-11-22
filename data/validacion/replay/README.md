# Reproducción horaria de una lluvia histórica

La validación compara la prioridad de Drena con los lugares documentados por fuentes
públicas. La cobertura es el porcentaje de lugares con una rejilla del 20 % superior
a menos de 100 m en línea recta. Se publican también los cortes con 10 % y con 50 m.
En cada corte, el número de rejillas se redondea hacia arriba.

## Entradas

- **Predicción A sin clima.** Usa `prediccion_congelada.csv` para el MUT. Para otro
  sector, ejecuta 03, 04 y 05 con el mismo sufijo y usa `prediccion_<sufijo>.csv` y
  `street_chains_<sufijo>.json`. Conserva los metadatos de la predicción junto al CSV.
- **Clima.** Usa la serie histórica y los metadatos de `11_clima_historico.py`. El
  centro solicitado a Open-Meteo debe coincidir con el del ranking.
- **Lugares.** Usa un GeoJSON `FeatureCollection` de puntos WGS84. Cada punto lleva
  `lugar` y `fuente_url`. Para el evento de octubre también requiere `precision`
  (cruce o tramo), `hora` ISO 8601 con zona horaria, y conviene incluir `tipo_hora`
  (`observacion`, `aviso` o `publicacion`). El corte exige ocho lugares dentro del
  mismo sector de radio máximo 1.500 m. Las coordenadas idénticas se cuentan una vez.
  El plan de julio puede usar `--tipo-evidencia puntos-criticos` para evaluar la
  cobertura espacial de lugares conocidos por su susceptibilidad, con el tiempo de
  respuesta sin determinar.

## Ejecución

Ejemplo para octubre, una vez que se hayan reunido los lugares y calculado el
sector. Descarga el clima con las coordenadas de ese sector antes de ejecutar.

```bash
python pipeline/10_replay.py \
  --prediccion data/validacion/prediccion_replay.csv \
  --cadenas data/street_chains_replay.json \
  --clima data/escenarios/2026-10-13.json \
  --anegados data/validacion/anegados_20261013.geojson \
  --tipo-evidencia evento \
  --motivo "Sector y criterio que cumplió al seleccionar la evidencia"
```

El comando verifica el SHA-256 de la configuración contra el congelamiento y los
hashes de las entradas con sus metadatos. El ranking B se calcula hora a hora con
la configuración congelada y el clima de esa hora. Los lugares solo se usan al
evaluar los rankings. Los comparadores son el área de aporte y el promedio de
1.000 permutaciones de ranking con semilla 86.

## Salidas

- `resultado.json` contiene la cobertura de A, los dos comparadores y la de B.
  La serie de B evalúa el conjunto de lugares en cada hora con clima disponible.
  La comparación `formula_horaria_al_registro` usa para cada lugar la última hora
  completada al momento del registro. Su denominador cuenta solo lugares con
  hora y clima disponible. Una publicación indica cuándo el incidente ya era
  conocido. La comparación temporal de alertas usa el primer aviso u observación
  con hora y expresa los retrasos con signo negativo.
- `ranking_horario.csv` guarda el modo, el clima, el puntaje y la prioridad de
  cada rejilla por hora. Los campos de B quedan vacíos cuando falta clima.
- `resultado.meta.json` registra el evento, el sector, la razón de la elección,
  la versión del congelamiento y los hashes de las entradas y salidas.

Para una prueba técnica, usa `--salida` fuera del repositorio y datos de prueba
rotulados. La vista de validación y el pitch usan resultados de evidencia verificada.
