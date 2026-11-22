# Video de respaldo de Drena

[Descargar la secuencia reproducida](drena-demo-reproducida.webm)

La grabación dura 48 segundos, lleva los rótulos en pantalla y se puede reproducir sin conexión. Muestra el ranking inicial, el recorrido de la cuadrilla, la entrada del reporte por foto, el cambio de prioridad y de siguiente parada, el paradero alternativo y el cierre verificado. Al cerrar, la foto de rejilla limpia baja el puntaje de Calle Dos de 0,8 a 0,3 en el ranking y Calle Uno vuelve a ser la siguiente parada. El paradero sigue expuesto porque el agua observada mantiene su vigencia.

Se grabó el tablero de la demo con respuestas controladas. Los nombres, puntajes y tiempos de la secuencia son ilustrativos. La foto del reporte es una maqueta rotulada. La toma con dos celulares corresponde al ensayo de producción. [Ensayo y plan B](../ensayo-demo.md) · [Tablero Durante](https://github.com/platanus-hack/platanus-hack-26-cl-team-34/pull/125)

## Regenerar

[`grabar-respaldo.mjs`](grabar-respaldo.mjs) reproduce la secuencia con Playwright. Intercepta las llamadas a la API y responde con el escenario de ensayo, así que no necesita backend ni credenciales. Los mapas base se descargan durante la grabación.

```bash
cd frontend
NEXT_PUBLIC_API_URL=http://localhost:8799 npx next build
npx next start -p 3138
```

En otra terminal, desde la raíz del repositorio. La instalación crea solo `node_modules/`, que git ignora.

```bash
npm i --no-save playwright@1.62.1
```

```bash
npx playwright install chromium
```

```bash
node docs/demo/grabar-respaldo.mjs
```

El script reemplaza `drena-demo-reproducida.webm`. `DRENA_CHROME` permite usar un Chromium ya instalado.
