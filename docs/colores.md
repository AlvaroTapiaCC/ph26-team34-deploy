# Colores del front

Todos los colores salen de **un solo archivo**: [`frontend/lib/paleta.json`](../frontend/lib/paleta.json). Las vistas no escriben colores: usan variables (`var(--principal)`) o, en el mapa, `colorDe("principal")`.

## Los 3 colores base

| Variable | Valor | Para qué |
|---|---|---|
| `--principal` | `#368786` | Botón principal, selección, cifras destacadas, prioridad alta, agua que no cabe y cadena aguas abajo en el mapa |
| `--secundario` | `#ece9f4` | Texto y prioridad media |
| `--fondo` | `#2a2930` | Fondo de la página, barra superior y franja del clima |

Al cambiar uno de estos tres, cambia todo lo que depende de él. Hoy la paleta por defecto es oscura (texto claro sobre fondo oscuro), pero las mezclas funcionan igual con una paleta clara: tarjetas y bordes se calculan mezclando el fondo con el texto, así que siempre quedan entre los dos.

## Derivados

Se calculan solos con `color-mix()` a partir de los tres base. No se editan uno por uno.

| Variable | Sale de | Uso |
|---|---|---|
| `--surface`, `--surface-2`, `--surface-3` | fondo + texto | tarjetas, tarjeta secundaria, relieve |
| `--line` | fondo + texto | bordes finos |
| `--map-bg` | fondo + texto | fondo del mapa |
| `--text-2`, `--text-3` | secundario | texto secundario y tenue |
| `--contexto` | secundario | capas de contexto del mapa (catastro, GORE) |
| `--principal-suave` | principal | fondos claros del principal |
| `--texto-inv` | fondo | texto sobre algo pintado con el color de texto (chips y pines de prioridad media y baja, avisos) |
| `--sobre-principal` | sobre-color | texto sobre el principal |
| `--prio-alta`, `--prio-media`, `--prio-baja` | principal, secundario | chips y pines de prioridad |
| `--agua-suave` | agua | halo claro del agua |

## Fijos

Tienen significado propio, así que no se derivan de los tres base:
- `--sobre-color` (blanco: texto sobre el principal, peligro, agua, transporte o metro);
- `--danger` (peligro);
- `--ok` (correcto);
- `--aviso` (advertencia);
- `--agua`, `--agua-hondo` y `--agua-brillo` (agua);
- `--bus` y `--bus-dim` (transporte);
- `--metro`.

## Cómo cambiar colores

- **Probar en vivo:** abre cualquier página con `?paleta=1`. El editor cambia los 3 base en la página y en todas las capas del mapa (incluidos el flujo y las cadenas), y lo guarda solo en tu navegador. Al navegar a una URL sin `?paleta=1`, el editor se oculta.
- **Exportar:** "Copiar :root" o "Descargar CSS" entregan el bloque `:root` completo que reproduce la vista previa. "Descargar JSON" entrega los 3 colores base.
- **Dejarlo en el repo:** en el editor, "Descargar JSON". Luego, en `frontend/`, corre `npm run paleta -- paleta.json`.
- **Cambiar una mezcla, un fijo o agregar un color:** edita `lib/paleta.json` y corre `npm run paleta -- --escribir`. Eso regenera el bloque `paleta:inicio … paleta:fin` de `app/globals.css`, que no se edita a mano.

## Reglas al escribir estilos

- **En CSS:** usa siempre `var(--…)`. Para una variante más clara u oscura, usa `color-mix(in srgb, var(--principal) 20%, var(--surface))`.
- **En TS (MapLibre, canvas):** usa `colorDe("…")` de `lib/paleta.ts`. Para que el mapa se repinte al editar la paleta, agrega la capa a `COLORES_CAPAS` en `components/map/DrenaMap.tsx`.
- **Textos:** no nombres colores que dependen de la paleta ("en naranjo"). Di "en el color principal" o describe lo que significa.
- **Chequeo del build:** `npm run build` corre primero `scripts/paleta.mjs`. Falla si `globals.css` no está al día o si hay un color escrito a mano (hex, `rgb()` o `hsl()`) fuera de la paleta. Se permiten las sombras neutras en negro y blanco con transparencia. Si un caso lo necesita a propósito, agrega el comentario `paleta-ok` en esa línea. En Vercel el chequeo solo avisa, para no tumbar un deploy; en local y en el CI de GitHub sí bloquea.
