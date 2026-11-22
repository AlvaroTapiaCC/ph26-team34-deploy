# Ensayo general de Drena

## Cruce de prueba

Primera opción: rejilla **AL13SU010171**, en avenida Los Leones. Está a **28,6 m** de **PC36, parada Liceo Tajamar**, y ocupa el puesto **29 de 46** en la predicción congelada. Cadena abajo siguen **AL13SU010170** y **AL13SU010108**, entre otras rejillas. PC36 tiene, entre sus servicios, el **104 sentido 1, destino Providencia**. En el ensayo, comprobar qué paradero alternativo ofrece Drena para ese mismo recorrido y sentido. [Extracto GTFS](../backend/data/transporte_mut.meta.json) · [Predicción congelada](../data/validacion/prediccion_congelada.csv) · [Cadenas](../data/street_chains_mut.json)

Segunda opción: **AL13SU012923**, en Luis Thayer Ojeda, a **49,7 m** de **PC155, parada 1 de Metro Tobalaba**. La cadena continúa hacia **AL13SU010087**. Usarla si el primer cruce queda sin una cuadrilla compatible o sin paradero alternativo durante las pasadas de prueba.

## Preparación

- Confirmar la revisión que pasó la verificación de producción y las horas de demo y final con el equipo. Fijar el commit al iniciar el ensayo completo. [Issue #98](https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/98) · [Issue #96](https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/96)
- Preparar una foto de obstrucción, un cuadro con agua y una foto de rejilla limpia. Usar material preparado o una maqueta. Mantener despejadas las rejillas reales y rotular el cuadro guardado o el escenario reproducido.
- Abrir `/health` con anticipación, conectar un celular con datos móviles y abrir el recorrido de la cuadrilla en el otro. Confirmar `/reportar`, el tablero y la vista móvil.
- En el escenario de ensayo, hacer una pasada de preparación con las tres imágenes exactas, confirmar sus clasificaciones y que el backend puede reutilizar los resultados de la caché en otro envío. Reiniciar con el control de administración de la API y verificar que vuelve el ranking y la ruta inicial.

## Registrar dos pasadas

Cronometrar desde el envío de la foto hasta que se vea la nueva parada en la central y en el celular de la cuadrilla. Comparar los dos tiempos y los estados finales al repetir tras el reinicio. [Guion de la demo](guion-pitch.md)

| Pasada | SHA desplegado | Parada inicial → nueva | Central (s) | Cuadrilla (s) | Expuesto → alternativo | Cierre y reinicio |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Pendiente | | | | | |
| 2 | Pendiente | | | | | |

## Plan B

| Si falla | Continuación |
| --- | --- |
| Render sigue despertando o se corta internet | Pasar al video local. Mostrar la secuencia completa desde el ranking inicial. |
| Claude demora o falla con la foto | Reutilizar la imagen exacta preparada durante el ensayo. Si no aparece la clasificación, pasar al video local. |
| Falla el despacho, la exposición del paradero o el cierre | Mostrar el tramo correspondiente del video. Si aún no hay grabación, explicar el paso con el guion y las vistas que estén disponibles. |

Antes de presentar cualquier respaldo, anunciar «secuencia reproducida». Verificar que el video abre sin conexión y que el enlace abre desde otro dispositivo. [Grabación de respaldo, issue #48](https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/48)
