"""Despacho y re-planificación (plan §7.2, issue #32).

Drena PROPONE: qué rejillas atiende cada cuadrilla y en qué orden. La central aprueba (#36).

Versión mínima para la demo (zona MUT, cuadrillas simuladas de #79):

1. Candidatas: las N rejillas de mayor prioridad de la zona (`scores`, escenario y modo de
   PARAMS) más los casos urgentes abiertos. No entran las rejillas con una misión cerrada
   hace menos de `excluir_cerradas_horas` (la cuadrilla acaba de limpiarlas).
2. Las misiones ya iniciadas (`en_camino`, `en_sitio`) NO se mueven: siguen con su cuadrilla y
   van primero.
3. Asignación: equipamiento compatible (sedimento visto en la última foto → hidrojet; hojas o
   basura → cualquiera) y, entre las compatibles, la de menor costo = tiempo por calle desde su
   posición + carga × tiempo de intervención ("más cercana por calle y con menos carga").
4. Orden de cada cuadrilla: iniciadas, después urgentes, después el resto. Dentro de cada grupo,
   la siguiente parada es la que más prioridad atiende por segundo invertido:
   prioridad / (traslado + intervención). Así una foto "tapada" sube de prioridad y pasa
   adelante si está razonablemente cerca.
5. Se guarda solo lo que cambió: misiones (una activa por rejilla o caso), una versión nueva en
   `routes` si cambió la secuencia de paradas y un evento `replan` por cuadrilla con la parada
   siguiente antes y después (lo usan el panel "qué cambió" de #36 y el cronómetro de #50).
   Planificar dos veces con los mismos datos no crea misiones ni versiones. Al planificar por un
   reporte, una misión por rejilla sin caso puede asumir el caso registrado por ese reporte.

Tiempos con `services/routing.py` (OSRM con plan B en línea recta): sin OSRM el despacho sigue.
Privacidad (revisión de #80): la geometría de la ruta de una cuadrilla REAL parte en su primera
parada, nunca en su posición; las paradas usan la ubicación pública del sumidero o del caso.
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb

from app.config import get_formula_config
from app.db import get_conn
from app.services import cuadrillas, routing
from app.services.scoring import _ULTIMA_CLASIFICACION

log = logging.getLogger(__name__)

PARAMS: dict[str, Any] = {
    "escenario": "base",
    "modo": "durante",
    "zona": "zona_mut",              # etiqueta de `sumideros.etiquetas`; None = todas
    "candidatas": 8,                 # rejillas de mayor prioridad que entran al plan
    "intervencion_s": 600,           # tiempo de limpieza por parada (10 min)
    "excluir_cerradas_horas": 12,    # una rejilla recién limpiada no vuelve al plan
    "vigencia_urgente_horas": 6,     # igual que `durante.vigencia_urgente_horas` de formula.yaml
    "cuadrillas": None,              # ids de cuadrillas a planificar; None = todas (los tests lo acotan)
}
INICIADAS = ("en_sitio", "en_camino")   # en_sitio primero
LOCK = "drena_despacho"
SIN_RUTA = {"type": "GeometryCollection", "geometries": []}
SIN_TIEMPO_S = 24 * 3600.0  # traslado de/hacia un punto sin coordenadas


@dataclass
class Parada:
    clave: str                     # "s:<sumidero_id>" o "c:<case_id>"
    lat: float
    lon: float
    nombre: str
    prioridad: float = 0.0
    urgente: bool = False
    hidrojet: bool = False         # requiere hidrojet (sedimento)
    sumidero_id: str | None = None
    case_id: str | None = None
    mission_id: str | None = None
    estado: str = "pendiente"
    crew_id: str | None = None     # cuadrilla actual (si ya tiene misión)
    orden: int | None = None

    @property
    def iniciada(self) -> bool:
        return self.estado in INICIADAS

    def resumen(self) -> dict[str, Any]:
        return {"mission_id": self.mission_id, "sumidero_id": self.sumidero_id, "case_id": self.case_id,
                "nombre": self.nombre}


@dataclass
class Cuadrilla:
    id: str
    lat: float | None
    lon: float | None
    hidrojet: bool
    is_simulated: bool
    paradas: list[Parada] = field(default_factory=list)

    @property
    def clave(self) -> str:
        return f"crew:{self.id}"


Tiempo = Callable[[str, str], float]


# ---------------------------------------------------------------------------
# Reglas puras (sin base ni red): se prueban sin Supabase
# ---------------------------------------------------------------------------
def _inicio(c: Cuadrilla) -> str | None:
    """Desde dónde parte la cuadrilla: su última parada iniciada o su posición."""
    iniciadas = [p for p in c.paradas if p.iniciada]
    if iniciadas:
        return iniciadas[-1].clave
    return c.clave if c.lat is not None else None


def asignar(pendientes: list[Parada], equipo: list[Cuadrilla], tiempo: Tiempo, intervencion_s: float) -> None:
    """Agrega cada parada pendiente a la cuadrilla compatible de menor costo (modifica `equipo`).

    Orden de asignación: urgentes primero, después por prioridad; empates por clave (determinista).
    Si ninguna cuadrilla tiene el equipo pedido, va a la de menor costo de todas (mejor que nadie).
    """
    disponibles = [c for c in equipo if _inicio(c) is not None]
    if not disponibles:
        return
    for p in sorted(pendientes, key=lambda x: (not x.urgente, -x.prioridad, x.clave)):
        compatibles = [c for c in disponibles if c.hidrojet or not p.hidrojet] or disponibles
        _, _, elegida = min((tiempo(_inicio(c), p.clave) + len(c.paradas) * intervencion_s, c.id, c)
                            for c in compatibles)
        elegida.paradas.append(p)


def ordenar(c: Cuadrilla, tiempo: Tiempo, intervencion_s: float) -> list[Parada]:
    """Iniciadas (en_sitio, luego en_camino) primero; después urgentes y luego el resto, eligiendo
    cada vez la parada con más prioridad atendida por segundo: prioridad / (traslado + intervención)."""
    iniciadas = sorted((p for p in c.paradas if p.iniciada),
                       key=lambda p: (INICIADAS.index(p.estado), p.orden if p.orden is not None else 1_000_000, p.clave))
    orden = list(iniciadas)
    actual = orden[-1].clave if orden else (c.clave if c.lat is not None else None)
    for grupo in ([p for p in c.paradas if not p.iniciada and p.urgente],
                  [p for p in c.paradas if not p.iniciada and not p.urgente]):
        resto = list(grupo)
        while resto:
            _, _, sig = min(
                (-(max(p.prioridad, 1e-6) / ((tiempo(actual, p.clave) if actual else 0.0) + intervencion_s)),
                 p.clave, p)
                for p in resto
            )
            resto.remove(sig)
            orden.append(sig)
            actual = sig.clave
    return orden


# ---------------------------------------------------------------------------
# Lectura
# ---------------------------------------------------------------------------
def _cuadrillas(conn: Connection, ids: list[str] | None) -> list[Cuadrilla]:
    return [
        Cuadrilla(r["id"], r["lat"], r["lon"], "hidrojet" in (r["equipamiento"] or []), r["is_simulated"])
        for r in conn.execute(
            "select id, equipamiento, is_simulated, st_y(geom_actual) as lat, st_x(geom_actual) as lon"
            " from crews where %(ids)s::text[] is null or id = any(%(ids)s) order by id",
            {"ids": ids},
        )
    ]


def _misiones_activas(conn: Connection, ids: list[str] | None) -> list[dict[str, Any]]:
    return conn.execute(
        """
        select m.id, m.crew_id, m.sumidero_id, m.case_id, m.orden, m.estado,
               coalesce(s.calle, s.id, 'Caso reportado') as nombre,
               st_y(coalesce(s.geom, cp.geom)) as lat, st_x(coalesce(s.geom, cp.geom)) as lon
          from missions m
          left join sumideros s on s.id = m.sumidero_id
          left join casos_publicos cp on cp.id = m.case_id
         where m.estado = any(%s) and (%s::text[] is null or m.crew_id = any(%s))
         order by m.orden nulls last, m.asignada_at, m.id
        """,
        (list(cuadrillas.ACTIVAS), ids, ids),
    ).fetchall()


def _candidatas(conn: Connection, prm: dict[str, Any]) -> list[Parada]:
    q = {"esc": prm["escenario"], "modo": prm["modo"], "zona": prm["zona"], "n": prm["candidatas"],
         "h": prm["excluir_cerradas_horas"], "hu": prm["vigencia_urgente_horas"]}
    out: dict[str, Parada] = {}
    for r in conn.execute(
        """
        select s.id, coalesce(s.calle, s.id) as nombre, st_y(s.geom) as lat, st_x(s.geom) as lon, sc.prioridad
          from scores sc join sumideros s on s.id = sc.sumidero_id
         where sc.scenario_id = %(esc)s and sc.modo = %(modo)s and sc.prioridad is not null
           and (%(zona)s::text is null or %(zona)s = any(s.etiquetas))
           and not exists (select 1 from missions m where m.sumidero_id = s.id and m.estado = 'cerrada'
                            and m.cerrada_at > now() - make_interval(hours => %(h)s))
         order by sc.prioridad desc, s.id
         limit %(n)s
        """,
        q,
    ):
        out[f"s:{r['id']}"] = Parada(f"s:{r['id']}", r["lat"], r["lon"], r["nombre"], r["prioridad"],
                                     sumidero_id=r["id"])
    # Casos urgentes abiertos: con sumidero, la parada es el sumidero; sin sumidero, el caso
    # (ubicación pública de `casos_publicos`, nunca el GPS del vecino).
    for r in conn.execute(
        """
        select ca.id as case_id, ca.sumidero_id, coalesce(s.calle, s.id, 'Caso reportado') as nombre,
               st_y(coalesce(s.geom, cp.geom)) as lat, st_x(coalesce(s.geom, cp.geom)) as lon,
               coalesce(sc.prioridad, 1.0) as prioridad
          from cases ca
          left join sumideros s on s.id = ca.sumidero_id
          left join casos_publicos cp on cp.id = ca.id
          left join scores sc on sc.sumidero_id = ca.sumidero_id and sc.scenario_id = %(esc)s and sc.modo = %(modo)s
         where ca.urgente and ca.estado not in ('resuelto', 'descartado')
           and ca.abierto_at > now() - make_interval(hours => %(hu)s)
         order by ca.abierto_at, ca.id
        """,
        q,
    ):
        if r["lat"] is None:
            continue
        clave = f"s:{r['sumidero_id']}" if r["sumidero_id"] else f"c:{r['case_id']}"
        p = out.get(clave) or Parada(clave, r["lat"], r["lon"], r["nombre"], r["prioridad"],
                                     sumidero_id=r["sumidero_id"],
                                     case_id=None if r["sumidero_id"] else str(r["case_id"]))
        p.urgente = True
        out[clave] = p
    return list(out.values())


def _necesitan_hidrojet(conn: Connection, sumidero_ids: list[str]) -> set[str]:
    """Rejillas cuya última foto vigente y evaluable muestra sedimento."""
    if not sumidero_ids:
        return set()
    vig = get_formula_config()["observado"]["vigencia_horas"]
    return {
        r["sumidero_id"]
        for r in conn.execute(
            f"""
            select distinct on (o.sumidero_id) o.sumidero_id,
                   coalesce(c.resultado->'material' ? 'sedimento', false) as sedimento
              from observations o {_ULTIMA_CLASIFICACION}
             where o.tipo = 'foto_rejilla' and o.sumidero_id = any(%(ids)s)
               and (c.resultado->>'evaluable')::boolean
               and o.ts > now() - make_interval(hours => %(h)s)
             order by o.sumidero_id, o.ts desc, o.id desc
            """,
            {"ids": sumidero_ids, "h": vig},
        )
        if r["sedimento"]
    }


def _tiempos(puntos: dict[str, tuple[float, float]]) -> Tiempo:
    """Matriz de tiempos por calle entre todos los puntos (OSRM o línea recta)."""
    claves = list(puntos)
    coords = [puntos[k] for k in claves]
    try:
        m = routing.matriz(coords, coords)
    except ValueError:  # demasiados puntos para OSRM público
        m = routing.matriz_linea_recta(coords, coords)
    idx = {k: i for i, k in enumerate(claves)}

    def t(a: str, b: str) -> float:
        if a == b:
            return 0.0
        if a not in idx or b not in idx:  # parada sin coordenadas: al final
            return SIN_TIEMPO_S
        return m.duraciones_s[idx[a]][idx[b]]

    return t


# ---------------------------------------------------------------------------
# Plan
# ---------------------------------------------------------------------------
def _armar(conn: Connection, ids: list[str] | None) -> tuple[list[Cuadrilla], dict[str, Parada], list[Parada], dict[str, Cuadrilla]]:
    """Lee cuadrillas y misiones activas. Devuelve (cuadrillas, activas por clave, sobrantes, cuadrillas por id).

    `sobrantes` son misiones activas duplicadas (más de una por rejilla o caso): se cancelan si
    están pendientes.
    """
    equipo = _cuadrillas(conn, ids)
    por_id = {c.id: c for c in equipo}
    activas: dict[str, Parada] = {}
    sobrantes: list[Parada] = []
    for r in _misiones_activas(conn, ids):
        clave = f"s:{r['sumidero_id']}" if r["sumidero_id"] else f"c:{r['case_id']}"
        p = Parada(clave, r["lat"], r["lon"], r["nombre"], sumidero_id=r["sumidero_id"],
                   case_id=str(r["case_id"]) if r["case_id"] else None, mission_id=str(r["id"]),
                   estado=r["estado"], crew_id=r["crew_id"], orden=r["orden"])
        previa = activas.get(clave)
        if previa is None or (p.iniciada and not previa.iniciada):
            if previa is not None:
                sobrantes.append(previa)
            activas[clave] = p
        else:
            sobrantes.append(p)
    return equipo, activas, sobrantes, por_id


def planificar(conn: Connection, motivo: str, observation_id: str | None = None,
               params: dict[str, Any] | None = None, *, caso_id: str | None = None) -> dict[str, Any]:
    """Recalcula el plan de todas las cuadrillas y guarda solo lo que cambió. Ver el docstring del módulo."""
    prm = {**PARAMS, **(params or {})}
    ahora = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with conn.transaction():
        conn.execute("select pg_advisory_xact_lock(hashtext(%s))", (LOCK,))
        equipo, activas, sobrantes, por_id = _armar(conn, prm["cuadrillas"])

        # Paradas siguientes antes del cambio, por cuadrilla (mismo orden que GET /crews/{id}/route)
        antes: dict[str, list[Parada]] = {c.id: [] for c in equipo}
        for p in sorted(activas.values(), key=lambda x: (x.orden if x.orden is not None else 1_000_000, x.clave)):
            if p.crew_id in antes:
                antes[p.crew_id].append(p)
        antes = {cid: _orden_vigente(ps) for cid, ps in antes.items()}

        # Candidatas: se fusionan con las misiones activas (conservan su id y estado)
        candidatas = {p.clave: p for p in _candidatas(conn, prm)}
        hidro = _necesitan_hidrojet(conn, [p.sumidero_id for p in candidatas.values() if p.sumidero_id])
        for clave, p in candidatas.items():
            p.hidrojet = p.sumidero_id in hidro
            if (a := activas.get(clave)) is not None:
                a.prioridad, a.urgente, a.hidrojet = p.prioridad, p.urgente, p.hidrojet

        # Las iniciadas se quedan con su cuadrilla; las demás se reasignan
        for p in activas.values():
            if p.iniciada and p.crew_id in por_id:
                por_id[p.crew_id].paradas.append(p)
        pendientes = [activas.get(k, p) for k, p in candidatas.items() if not activas.get(k, p).iniciada]
        descartar = [p for k, p in activas.items() if not p.iniciada and k not in candidatas]
        descartar += [p for p in sobrantes if not p.iniciada]

        puntos = {c.clave: (c.lat, c.lon) for c in equipo if c.lat is not None}
        puntos |= {p.clave: (p.lat, p.lon) for p in [*activas.values(), *pendientes] if p.lat is not None}
        tiempo = _tiempos(puntos)
        asignar(pendientes, equipo, tiempo, prm["intervencion_s"])
        despues = {c.id: ordenar(c, tiempo, prm["intervencion_s"]) for c in equipo}

        # Guardar
        canceladas = [_cancelar(conn, p) for p in descartar if p.mission_id]
        creadas = 0
        for cid, paradas in despues.items():
            for i, p in enumerate(paradas, start=1):
                creadas += _guardar_mision(conn, p, cid, i)
        if motivo == "observacion" and observation_id and caso_id:
            _vincular_caso_del_reporte(conn, observation_id, caso_id,
                                       [p for paradas in despues.values() for p in paradas])

        rutas: dict[str, dict[str, Any]] = {}
        for c in equipo:
            version = _guardar_ruta(conn, c, despues[c.id])
            sig_a = antes[c.id][0].resumen() if antes[c.id] else None
            sig_d = despues[c.id][0].resumen() if despues[c.id] else None
            rutas[c.id] = {"siguiente_antes": sig_a, "siguiente_despues": sig_d, "ruta_version": version,
                           "cambio": version is not None, "paradas": [p.resumen() for p in despues[c.id]]}
            if version is not None:
                conn.execute(
                    "insert into events (tipo, payload) values ('replan', %s)",
                    (Jsonb({"crew_id": c.id, "motivo": motivo, "observation_id": observation_id,
                            "siguiente_antes": sig_a, "siguiente_despues": sig_d, "ruta_version": version,
                            "paradas": [p.resumen() for p in despues[c.id]], "hora": ahora}),),
                )
    return {"despachado": True, "motivo": motivo, "hora": ahora, "creadas": creadas,
            "canceladas": len([x for x in canceladas if x]), "cuadrillas": rutas}


def _orden_vigente(paradas: list[Parada]) -> list[Parada]:
    """Orden con que la cuadrilla ve hoy sus paradas: por `orden` guardado."""
    return sorted(paradas, key=lambda p: (p.orden if p.orden is not None else 1_000_000, p.clave))


def _cancelar(conn: Connection, p: Parada) -> bool:
    fila = conn.execute(
        "update missions set estado = 'cancelada' where id = %s and estado = 'pendiente'"
        " returning id, crew_id, case_id, sumidero_id, estado",
        (p.mission_id,),
    ).fetchone()
    if fila:
        cuadrillas._sincronizar(conn, fila)
    return fila is not None


def _guardar_mision(conn: Connection, p: Parada, crew_id: str, orden: int) -> int:
    """Crea la misión o actualiza cuadrilla y orden si cambiaron. Devuelve 1 si la creó."""
    if p.mission_id is None:
        fila = conn.execute(
            "insert into missions (crew_id, sumidero_id, case_id, orden) values (%s, %s, %s, %s)"
            " returning id, crew_id, case_id, sumidero_id, estado",
            (crew_id, p.sumidero_id, p.case_id, orden),
        ).fetchone()
        p.mission_id, p.crew_id, p.orden = str(fila["id"]), crew_id, orden
        cuadrillas._sincronizar(conn, fila)
        return 1
    if p.crew_id != crew_id or p.orden != orden:
        fila = conn.execute(
            "update missions set crew_id = %s, orden = %s where id = %s"
            " returning id, crew_id, case_id, sumidero_id, estado",
            (crew_id, orden, p.mission_id),
        ).fetchone()
        anterior = p.crew_id
        p.crew_id, p.orden = crew_id, orden
        cuadrillas._sincronizar(conn, fila)
        if anterior and anterior != crew_id:  # la cuadrilla que la perdió también actualiza su estado
            cuadrillas._sincronizar(conn, {**fila, "crew_id": anterior, "case_id": None})
    return 0


def _vincular_caso_del_reporte(conn: Connection, observation_id: str, caso_id: str, paradas: list[Parada]) -> None:
    """Vincula la parada de la rejilla al caso registrado por el reporte, antes de la llegada."""
    por_id = {p.mission_id: p for p in paradas if p.mission_id and p.sumidero_id and not p.case_id}
    if not por_id:
        return
    filas = conn.execute(
        """
        update missions m set case_id = ca.id
          from case_observations co
          join observations o on o.id = co.observation_id
          join cases ca on ca.id = co.case_id and ca.sumidero_id = o.sumidero_id
         where co.observation_id = %(observation_id)s and co.case_id = %(caso_id)s
           and ca.estado not in ('resuelto', 'descartado')
           and m.id = any(%(misiones)s::uuid[]) and m.sumidero_id = o.sumidero_id
           and m.case_id is null and m.estado in ('pendiente', 'en_camino')
        returning m.id, m.crew_id, m.case_id, m.sumidero_id, m.estado
        """,
        {"observation_id": observation_id, "caso_id": caso_id, "misiones": list(por_id)},
    ).fetchall()
    for fila in filas:
        por_id[str(fila["id"])].case_id = str(fila["case_id"])
        cuadrillas._sincronizar(conn, fila)


def _guardar_ruta(conn: Connection, c: Cuadrilla, paradas: list[Parada]) -> int | None:
    """Versión nueva en `routes` solo si cambió la secuencia de paradas. Devuelve la versión o None."""
    previa = conn.execute(
        "select version, paradas from routes where crew_id = %s order by version desc limit 1", (c.id,)
    ).fetchone()
    secuencia = [p.mission_id for p in paradas]
    if previa is None and not secuencia:
        return None
    if previa is not None and [x.get("mission_id") for x in previa["paradas"] or []] == secuencia:
        return None
    puntos = [(p.lat, p.lon) for p in paradas if p.lat is not None]
    if c.is_simulated and c.lat is not None:  # cuadrilla REAL: la geometría parte en su primera parada
        puntos = [(c.lat, c.lon), *puntos]
    try:
        geojson = routing.ruta(puntos[: routing.MAX_PUNTOS_RUTA]).geojson if puntos else SIN_RUTA
    except ValueError:
        geojson = routing.ruta_linea_recta(puntos).geojson
    version = (previa["version"] if previa else 0) + 1
    conn.execute(
        "insert into routes (crew_id, version, geojson, paradas) values (%s, %s, %s, %s)",
        (c.id, version, Jsonb(geojson),
         Jsonb([{**p.resumen(), "orden": i, "lat": p.lat, "lon": p.lon, "urgente": p.urgente}
                for i, p in enumerate(paradas, start=1)])),
    )
    return version


def para_observacion(plan: dict[str, Any], sumidero_id: str | None, caso_id: str | None) -> dict[str, Any]:
    """Resumen del plan para la respuesta de POST /observations.

    `crew_id` es la cuadrilla a la que quedó la rejilla (o el caso) del reporte; si no entró al
    plan, la primera cuadrilla cuya ruta cambió. `en_plan` dice si la rejilla quedó en alguna ruta.
    """
    crew_id, en_plan = None, False
    for cid, r in plan["cuadrillas"].items():
        for p in r["paradas"]:
            if (sumidero_id and p["sumidero_id"] == sumidero_id) or (caso_id and p["case_id"] == caso_id):
                crew_id, en_plan = cid, True
    if crew_id is None:
        crew_id = next((cid for cid, r in plan["cuadrillas"].items() if r["cambio"]), None)
    r = plan["cuadrillas"].get(crew_id, {}) if crew_id else {}
    return {"despachado": True, "crew_id": crew_id, "en_plan": en_plan,
            "siguiente_antes": r.get("siguiente_antes"), "siguiente_despues": r.get("siguiente_despues"),
            "ruta_version": r.get("ruta_version")}


def replanificar_seguro(motivo: str, observation_id: str | None = None, sumidero_id: str | None = None,
                        caso_id: str | None = None) -> dict[str, Any]:
    """`planificar` con su propia conexión, que NUNCA lanza: un fallo del despacho no puede perder
    el reporte ni el cierre que lo pidió. Devuelve el resumen de `para_observacion`."""
    try:
        with get_conn() as conn:
            plan = planificar(conn, motivo, observation_id, caso_id=caso_id)
        return para_observacion(plan, sumidero_id, caso_id)
    except Exception as e:  # se registra y se informa en la respuesta
        log.exception("Falló el despacho (%s, observación %s)", motivo, observation_id)
        return {"despachado": False, "motivo": "error_despacho", "error": type(e).__name__,
                "crew_id": None, "en_plan": False, "siguiente_antes": None, "siguiente_despues": None,
                "ruta_version": None}
