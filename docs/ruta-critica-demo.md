# Ruta crítica de la demo de Drena

Estado del repositorio al 21 de noviembre de 2026, en `d581f24`. Horario de Santiago: demo el domingo 22 a las 09:00 y final a las 15:00, según el plan del equipo. [Coordinación de la demo][96]

## Base integrada

| Paso | Evidencia en el repositorio |
| --- | --- |
| Preparar catastro, variables y predicción congelada | [PR #81][81] |
| Cargar datos y cuadrillas simuladas, exponer misiones y rutas | [PR #76][76], [PR #79][79], [PR #80][80] |
| Recibir observaciones y abrir el escenario real en la central | [PR #83][83], [PR #82][82], [PR #84][84] |
| Replanificar la siguiente parada y conservar las misiones iniciadas | [PR #106][106] |
| Mostrar el recorrido en el móvil y verificar el cierre con foto | [PR #113][113], [PR #108][108] |
| Identificar el paradero expuesto y su alternativo en la central | [PR #103][103], [PR #109][109], [PR #115][115] |
| Reiniciar el escenario de ensayo | [PR #114][114] |

## Orden para llegar al ensayo

1. **Tablero Durante.** Conservar una vista operativa desde la que se pueda seguir la clasificación, el cambio de prioridad y de parada, el paradero y el cierre sin recargar. Resolver el acceso a esa vista al integrar el mapa de la demo, cuya PR retira el selector Antes/Durante. [Issue #36][36], [PR #99][99]
2. **Producción.** Una vez integrada la revisión que se va a ensayar, el equipo de infraestructura aplica las migraciones y cargas, publica el mismo `main` en el espejo y verifica el acceso web y móvil. Desde dos celulares, repetir dos veces la secuencia foto de rejilla → siguiente parada → imagen con agua y paradero alternativo → cierre con foto → reinicio. Anotar fallas, tiempos y la revisión publicada. [Issue #98][98], [Procedimiento de despliegue](deploy.md)
3. **Ensayo y video.** Elegir una rejilla del ranking con paradero cercano y cadena calle abajo, preparar las tres imágenes y medir el tiempo desde el envío hasta la nueva misión en ambos dispositivos. Si pasa el ensayo, grabar y verificar la copia offline del recorrido. [Issue #50][50], [Issue #48][48], [Guion](guion-pitch.md)
4. **Corte de la demo.** Al iniciar el ensayo completo, fijar el commit y admitir solo correcciones que impidan la secuencia, expongan datos personales o comprometan la repetición. Si falla una etapa en vivo, usar la grabación si está disponible. Presentar cada paso reproducido como tal. [Coordinación de la demo][96], [Guion](guion-pitch.md)

## Validación en paralelo

- **Replay.** La serie de clima histórico y la parametrización del sector están en `main`. Primero se evalúa la evidencia de octubre con el corte de ocho puntos en un radio de 1,5 km. Si queda bajo el corte, se evalúa la alternativa de julio con los insumos de Las Condes. Solo después se calcula la cobertura contra azar y área de aporte. [PR #110][110], [PR #117][117], [Issues #73][73], [#74][74], [#87][87] y [#86][86]
- **Clasificación.** Dos personas etiquetan de forma independiente el set de imágenes públicas. El resultado comunica el acuerdo, las coincidencias con Claude y las imágenes no evaluables. [Issue #30][30]
- **Pitch.** Si falta una medición, indicar que sigue en curso y mostrar el método y la predicción congelada. La vista Validación, el flujo calle abajo y Realtime quedan después de las verificaciones de la secuencia principal. [Guion](guion-pitch.md), [Issues #40][40], [#93][93] y [#6][6]

[6]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/6
[30]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/30
[36]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/36
[40]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/40
[48]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/48
[50]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/50
[73]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/73
[74]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/74
[76]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/pull/76
[79]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/pull/79
[80]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/pull/80
[81]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/pull/81
[82]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/pull/82
[83]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/pull/83
[84]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/pull/84
[86]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/86
[87]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/87
[93]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/93
[96]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/96
[98]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/98
[99]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/pull/99
[103]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/pull/103
[106]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/pull/106
[108]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/pull/108
[109]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/pull/109
[110]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/pull/110
[113]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/pull/113
[114]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/pull/114
[115]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/pull/115
[117]: https://github.com/platanus-hack/platanus-hack-26-cl-team-34/pull/117
