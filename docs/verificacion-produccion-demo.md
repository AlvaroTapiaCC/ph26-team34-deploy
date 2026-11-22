# Verificación de producción de la demo

## Estado observado el 21 de noviembre de 2026 a las 21:58 de Santiago

El espejo de despliegue apuntaba a `bb83a38` (PR #58). El `main` oficial estaba en `d581f24` (PR #117). La comprobación se hizo con solicitudes GET a las URLs documentadas.

| Comprobación | Resultado |
| --- | --- |
| Vercel `/` | HTTP 200 |
| Vercel `/central`, `/reportar` y `/cuadrilla` | HTTP 404 |
| Render `/health` | HTTP 200, estado OK |
| Render `/health/db` | HTTP 200, estado OK con PostGIS |
| Render `/clima` y `/transporte/expuestos` | HTTP 404 |
| Render `GET /observations` | HTTP 405 |
| CORS de las consultas a Render con el origen de Vercel | La respuesta permite ese origen |

La revisión activa todavía impide iniciar la prueba completa. Quedan pendientes la publicación, la confirmación de las migraciones y cargas, la prueba con datos móviles y las dos pasadas con evidencia.

## Preparar la revisión

1. Fijar el SHA que se va a ensayar en el `main` oficial y registrar el SHA publicado en el espejo. Revisar que las tres rutas web estén incluidas.
2. En Render, confirmar `DATABASE_URL`, las credenciales de Storage, `ANTHROPIC_API_KEY`, `CREW_TOKEN`, `ADMIN_TOKEN`, `SIM_TOKEN` y `CORS_ORIGINS`. En Vercel, revisar `NEXT_PUBLIC_API_URL` y la configuración de la vista de cuadrilla. Registrar solo cuáles están configuradas.
3. Con el entorno de producción seleccionado, aplicar `python -m db.migrate` desde `backend/` y verificar que figure la migración `0007`. Primero ejecutar ambas cargas con `--dry-run`. Desde la raíz, ejecutar `python pipeline/07_cargar.py` y luego `python pipeline/08_simulados.py --recalcular`.
4. Confirmar en la central que el escenario base muestra el ranking MUT, que sus puntajes varían y que aparece la ruta inicial de una cuadrilla simulada. Confirmar el estado de la base y que cada servicio publicó el SHA acordado. [Deploy de Drena](deploy.md)

## Probar dos veces con dos celulares

Usar el escenario de ensayo, las tres imágenes preparadas y las URLs del despliegue. Mantener la central visible durante toda la secuencia y usar datos móviles en al menos un dispositivo.

1. Abrir la central y el recorrido móvil. Anotar la revisión, el puntaje y la siguiente parada inicial.
2. Enviar la foto de obstrucción desde `/reportar`. Sin recargar, confirmar la clasificación, el cambio de puntaje y la nueva parada en la central y en el móvil. Medir desde el envío hasta cada actualización.
3. Enviar la imagen con agua. Confirmar que la central muestra el paradero expuesto y el alternativo del mismo servicio y sentido.
4. Enviar la foto de la rejilla limpia desde la cuadrilla. Confirmar el estado de cierre y la disminución del puntaje.
5. Revisar en la red del navegador que la central recibe únicamente las señales públicas y que las respuestas excluyen fotos vecinales, texto crudo y GPS exacto. Reiniciar el escenario con el control de administración y repetir.

Registrar cada paso fallido con el SHA y la issue correspondiente. Completar los tiempos a partir de las dos pasadas observadas.

| Pasada | SHA | Ranking y ruta | Foto → central (s) | Foto → móvil (s) | Paraderos | Cierre | Privacidad | Incidencias |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Pendiente | | | | | | | |
| 2 | Pendiente | | | | | | | |

[Issue #98](https://github.com/platanus-hack/platanus-hack-26-cl-team-34/issues/98) · [Guion de la demo](guion-pitch.md)
