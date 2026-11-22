# Caso San Carlos · reconstrucción ilustrativa

Ruta web: `/central/san-carlos`. No es una validación de aluviones ni una demostración de que limpiar rejillas habría evitado el evento.

## Regenerar desde la raíz

```sh
python3.12 -m venv pipeline/venv
pipeline/venv/bin/python -m pip install -r pipeline/requirements.txt
pipeline/venv/bin/python pipeline/11_clima_historico.py --evento 2026-10-08 --lat -33.418 --lon -70.541
pipeline/venv/bin/python pipeline/15_caso_san_carlos.py
pipeline/venv/bin/python -m pytest pipeline/tests/test_caso_san_carlos.py pipeline/tests/test_replay.py
```

En el entorno de implementación, el índice no ofrecía `geopandas==1.2.0` (y las dependencias completas no pudieron instalarse). Estos dos scripts solo necesitan PyYAML además de la biblioteca estándar; se ejecutaron con Python 3.12 y `PyYAML==6.0.4`, más pytest para las pruebas. No se cambiaron los requisitos compartidos.

## Lectura y límites

- El modo y `clima` proceden de `backend/config/clima.yaml`. Ranking B reutiliza `ranking_por_hora` de `10_replay.py`, la fórmula y las cadenas congeladas; no hay pesos nuevos.
- La primera alerta de toda la ventana 6–8 y la primera del 7–8 se guardan separadas. El titular usa la segunda para no atribuir al pulso del 8 una alerta de la lluvia anterior.
- El centro solicitado produce 22,5 mm previstos / 37,5 mm observados el 8, y 96,1 mm entre el 6 y el 8. No coincide con la referencia aportada en −33,40, −70,52 (26,7 / 26,9 mm; alrededor de 86 mm en tres días). No se reemplazaron los datos descargados por cifras de otra celda. La referencia se conserva explícitamente separada, no como medición verificada de este sector.
- El eje espacial usa nombre de General Blanche / Camino El Alba y un margen de 60 m sobre la geometría vial de esas calles del extracto OSM existente, no una huella hidráulica del aluvión.
- Los puntos Alto se seleccionan por nombres del eje en el catastro SENAPRED, no por ocurrencia de daños. Cada punto conserva su enlace de origen.
- Las fuentes periodísticas / Wikipedia son antecedentes curados; no una auditoría independiente de decisiones de autoridades. La [hipótesis de Codina sobre ductos obstruidos, reportada por BioBioChile](https://www.biobiochile.cl/noticias/nacional/region-metropolitana/2026/10/08/codina-apunta-a-obstruccion-de-ductos-como-causa-de-grave-aluvion-que-afecta-a-san-carlos-de-apoquindo.shtml) no se presenta como confirmada.
- Los metadatos acompañan la serie, los antecedentes y el resultado; el lector web comprueba la huella SHA-256 de `caso.json` y no muestra cifras si falta el resultado o no coincide.
