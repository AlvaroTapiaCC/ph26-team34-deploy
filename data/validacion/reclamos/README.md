# Reclamos de Atención Vecino frente al ranking congelado (#72)

Esta es la validación complementaria de [#86](https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/86). Contrasta los tickets municipales de drenaje con el ranking A congelado del sector MUT, de 700 m y 46 rejillas, y con las dos referencias del replay: el área de aporte y el promedio de 1.000 permutaciones con semilla 86. Se usa la misma configuración congelada y no se cambió ningún peso.

## Fuente

- [Portal de Datos Abiertos de la Municipalidad de Las Condes](https://datos.lascondes.cl/datos), capa «Atención Vecino» (id 6), que reúne los tickets que los vecinos ingresan y que el municipio resuelve. El archivo se descargó desde `https://datos.lascondes.cl/download/capa/6/csv` el 22-11-2026 a las 01:21 UTC. Es la exportación del portal del 15-11-2026, con 116.304 tickets entre febrero de 2022 y noviembre de 2026. El sha256 del archivo crudo está en cada `.meta.json`.
- **Licencia:** la ficha de la capa no declara una licencia. El portal publica un «Decreto Portal de Datos Abiertos» en [Recursos](https://datos.lascondes.cl/recursos), pero es un PDF escaneado que no se pudo leer de forma automática. **Hay que confirmar la licencia antes de redistribuir el crudo o mostrar esta tabla fuera del equipo.**
- La fecha del ticket (`fc_creacion`) viene solo con el día. Los tickets corresponden a lo que el vecino informó y no confirman la causa del problema ni el estado de una rejilla.

## Privacidad

El CSV crudo incluye la dirección y las coordenadas del domicilio de quien hace la solicitud. Por eso **no se versiona** y el script se niega a leerlo si está dentro del repo. Las coordenadas solo se usan en memoria para tres cosas: decidir si el ticket cae en el sector, asignar la cuadra y medir distancias a las rejillas. Lo publicado agrupa los tickets por cuadra, definida como la calle normalizada más el tramo de numeración de 100 (por ejemplo, `MARIANO SANCHEZ FONTECILLA 300-399`). No incluye números de casa, coordenadas ni identificadores de ticket o de vecino.

## Método

- **Tipos de solicitud:** «Sumideros de Aguas Lluvias» y «Anegamiento por aguas lluvias o desbordamiento de canales». Se incluyen todos los motivos (Solicitud, Reclamo, Denuncia, etc.).
- **Ventanas:** se toman los días del evento según la metadata del clima en `data/escenarios/`. La sensibilidad agrega el día siguiente.
- **Cobertura:** una cuadra del sector está cubierta si alguno de sus tickets tiene a menos de 100 m una rejilla del 20 % superior. También se informan los cortes de 10 % y de 50 m. Es la métrica de #86 con la cuadra como unidad.
- El ranking horario B no aplica porque los tickets no tienen hora.

## Resultados

| Evento | Tickets de drenaje en la comuna (días del evento) | En el sector MUT | Cuadras | Cobertura |
|---|---|---|---|---|
| [16 y 17 de julio de 2026](2026-07-16_17.json), evento del replay de #86 | 12 (8 anegamiento, 4 sumideros) | 0 | 0 | No se calcula |
| [13 de octubre de 2026](2026-10-13.json), complementario | 5 (2 anegamiento, 3 sumideros) | 2 | 1 | Ver abajo |

- **El evento reproducido no deja ninguna cifra.** Ningún ticket de drenaje del 16 al 18 de julio cayó dentro del sector MUT, ni siquiera a 1,5 km de su centro. Esos tickets están en otras partes de la comuna, fuera de las rejillas con variables calculadas. La parte del sector que queda en Providencia no puede tener tickets, porque la capa solo cubre Las Condes.
- **13 de octubre (complementario, n = 1 cuadra).** Los 2 tickets de sumideros de `MARIANO SANCHEZ FONTECILLA 300-399` tienen 5 rejillas a menos de 100 m, con ranks entre 36 y 46. Ninguna está en el 20 % superior del ranking A, así que esa cuadra queda sin cubrir. «Solo área de aporte» sí la cubre, y el azar la cubre en el 74,4 % de las permutaciones. No hay rejillas a menos de 50 m. Con una sola cuadra, este resultado no permite concluir nada sobre la fórmula, pero se informa tal como salió.
- **Serie diaria comunal.** Durante la semana de julio, los tickets de drenaje subieron de 0 a 2 por día a entre 4 y 8 por día del 13 al 17. Esto concuerda con un evento de lluvia prolongado, pero el aumento empieza antes de los días elegidos para el replay. El 13 de octubre registró 5 tickets.

## Regenerar

El crudo se descarga fuera del repo y el script se ejecuta desde la raíz:

```bash
curl -H 'X-Requested-With: XMLHttpRequest' -o /tmp/atencion_vecino.csv https://datos.lascondes.cl/download/capa/6/csv
python pipeline/12_reclamos.py --crudo /tmp/atencion_vecino.csv --descargado-utc <hora UTC de la descarga> \
  --clima-meta data/escenarios/2026-07-16_17.meta.json --nota "<por qué este evento>"
```

El portal actualiza la capa, así que una descarga nueva cambia el sha256 del crudo y puede cambiar los conteos. Para reproducir exactamente estas salidas, hay que usar un archivo con el sha256 registrado. Las pruebas en `pipeline/tests/test_reclamos.py` usan tickets sintéticos rotulados como tales.
