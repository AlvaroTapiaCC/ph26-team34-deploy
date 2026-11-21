Closes #

> Un issue por PR. Ideal: menos de ~300 líneas. Si depende de otro PR, indícalo aquí.

## Qué hace
<!-- 2 a 5 puntos: qué cambia y por qué. -->

## Cómo probarlo
<!-- Comandos o pasos concretos. -->

## Autorrevisión (antes de pedir revisión)
- [ ] Corrí `backend/scripts/pre_pr.sh` (con `--integracion` si toca la base) y pasa
- [ ] Revisé el diff completo en GitHub, línea por línea, como si fuera de otra persona

**Concurrencia y plazos**
- [ ] ¿Qué pasa si dos requests llegan a la vez? (estado global, pools, cachés, locks)
- [ ] ¿Qué pasa si la base, Claude, OSRM o Storage se cuelgan o fallan? ¿Hay timeout y la respuesta es clara (503, plan B)?

**Seguridad y datos personales**
- [ ] ¿El navegador (publishable key) puede leer o escribir algo que no debería? (RLS, GRANT, Realtime, Storage)
- [ ] ¿Se expone texto crudo, fotos, coordenadas exactas o posiciones de personas?
- [ ] Sin secretos en el código ni en el diff (`.env` fuera de git)

**Datos raros**
- [ ] Datos faltantes, vacíos, NaN, duplicados, desordenados o mal formados: ¿error claro en vez de 500 o de un resultado silenciosamente malo?
- [ ] ¿Pueden colarse datos simulados donde no corresponde? (`is_simulated`)

**Tests**
- [ ] Cada test nuevo **falla con el código anterior** (o explico por qué no aplica)
- [ ] Los tests de integración usan IDs únicos por ejecución y borran solo lo que crearon
- [ ] Los tests no dependen del orden ni del tiempo (sin sleeps frágiles)

**Repo**
- [ ] No toqué `README.md`
- [ ] Migraciones nuevas: idempotentes, con número nuevo (nunca edito una ya aplicada sin una migración que corrija el proyecto existente)

## Riesgos revisados
<!-- Qué casos de la lista revisé y cómo quedaron; qué queda pendiente a propósito. -->
