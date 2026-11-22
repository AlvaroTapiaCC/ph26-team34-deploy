# Evaluación de las clasificaciones visuales de Claude

El manifiesto fija los bytes de cada foto y conserva autoría, fuente y licencia.
Las fotos muestran rejillas y calles, con distintos encuadres y condiciones de
agua y obstrucción. Las 26 fotos provienen de fuera de Chile y varias rejillas
pertenecen a una misma colección de cunetas. El conjunto se armó para un ensayo
pequeño con dos personas. Las cifras describen ese conjunto.

Se revisó el [conjunto público de Iqbal para alcantarillas](https://zenodo.org/records/7623641).
Sus escenas se centran en entradas de conductos. Para esta prueba se buscaron
rejillas superficiales y calles con una calzada o vereda visible.

Se revisaron las licencias y el contenido visible de cada foto en Wikimedia
Commons. El repositorio registra el manifiesto y sus SHA-256. El script comprueba
los hashes contra las imágenes de la interfaz y los ejemplos que se indiquen
con `--ejemplo`. Si se agrega una foto a los prompts, también hay que excluir
recortes o variantes de la misma toma antes de fijar el manifiesto.

## Preparar y etiquetar

Desde la raíz, con las dependencias de `backend/requirements.txt` instaladas:

```bash
python pipeline/12_validar_claude.py preparar --paquete /tmp/drena-claude
```

Si ya están descargados los originales, agrega `--origen` con la carpeta que
contiene los nombres definidos en el manifiesto. El paquete incluye las fotos
por ID y una planilla CSV con las etiquetas vacías.

Entrega la misma planilla y las mismas fotos a dos personas por separado.
Cada una devuelve su copia de `etiquetas.csv` antes de consultar el manifiesto
de procedencia, conversar sobre las imágenes o conocer una clasificación de
Claude. Aplica estas reglas de forma independiente:

- **Rejilla.** Marca `limpia` si las ranuras están libres, `parcial` si el material
  tapa una parte relevante o `tapada` si cubre la mayor parte. Marca
  `no_evaluable` si el encuadre, la iluminación o la definición impiden
  juzgar el estado de la rejilla.
- **Cámara.** Marca `sin_agua` si la calle no tiene agua acumulada, `cuneta` si
  corre o se acumula solo al borde de la calzada, `hasta_vereda` si cubre la
  calzada hasta el borde de la vereda o `sobre_vereda` si la supera. Marca
  `no_evaluable` si el encuadre impide distinguir el nivel.

Conserva las dos planillas separadas con identificadores pseudónimos. El
manifiesto acredita las fotos para su uso posterior y debe acompañar cualquier
redistribución pública de los archivos.

## Ejecutar la comparación

Con las dos planillas completas y `ANTHROPIC_API_KEY` configurada como indica
`backend/.env.example`, ejecuta:

```bash
DATABASE_URL='' python pipeline/12_validar_claude.py evaluar \
  --paquete /tmp/drena-claude \
  --etiquetas-a /tmp/revision-a.csv --revisor-a evaluador-a \
  --etiquetas-b /tmp/revision-b.csv --revisor-b evaluador-b
```

El script llama a los mismos clasificadores de rejilla y cámara que usa la API y
registra el modelo y la versión del prompt. Cuando falla una consulta, se puede
reintentar la ejecución. Los fallos de la API detienen la medición y una
respuesta válida `no_evaluable` se cuenta como abstención.

`resultado.json` registra el acuerdo de las personas sobre todo el corpus y una
matriz de confusión por tipo de foto con filas de consenso humano y columnas de
Claude. La cifra para el pitch usa los casos que las dos personas coincidieron
en etiquetar como evaluables. Si Claude se abstiene de clasificar uno de ellos,
el caso cuenta en el denominador. Informa también el total de abstenciones de
Claude y el acuerdo humano. La cifra se publica una vez terminadas las dos
revisiones independientes.
