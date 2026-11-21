"""Cuadrillas, misiones y rutas (plan §7.2 y §9.5, issue #33).

Reglas:
- Privacidad: la posición de una cuadrilla REAL solo se entrega con permiso de admin; las
  simuladas se muestran siempre (son las de la demo). Las paradas de las rutas usan la
  ubicación pública (sumidero o `casos_publicos`), nunca el GPS de un reporte (#57).
- Concurrencia: cada cambio de estado es un UPDATE atómico condicionado al estado actual; si
  dos peticiones compiten, una gana y la otra recibe `TransicionInvalida` (409).
- Auditoría: cambios de estado y cierres quedan en `events` (insumo del informe, #43).
"""
from __future__ import annotations

from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb

from app.services import routing

# Santiago metropolitano, con margen: una posición fuera de aquí es un error del GPS o de la app
BBOX_LON = (-71.0, -70.3)
BBOX_LAT = (-33.8, -33.2)

ESTADOS = ("pendiente", "en_camino", "en_sitio", "cerrada", "cancelada")
# estado nuevo -> estados desde los que se puede llegar. "cerrada" solo por cerrar_mision (con foto).
TRANSICIONES: dict[str, tuple[str, ...]] = {
    "pendiente": ("en_camino",),               # deshacer "voy en camino"
    "en_camino": ("pendiente",),
    "en_sitio": ("en_camino",),
    "cancelada": ("pendiente", "en_camino", "en_sitio"),
}
CERRABLE_DESDE = ("en_camino", "en_sitio")
ACTIVAS = ("pendiente", "en_camino", "en_sitio")


class NoEncontrado(LookupError):
    pass


class TransicionInvalida(RuntimeError):
    def __init__(self, actual: str, nuevo: str):
        super().__init__(f"No se puede pasar de '{actual}' a '{nuevo}'")
        self.actual, self.nuevo = actual, nuevo


class PosicionInvalida(ValueError):
    pass


def validar_posicion(lat: float, lon: float) -> None:
    if not (BBOX_LAT[0] <= lat <= BBOX_LAT[1] and BBOX_LON[0] <= lon <= BBOX_LON[1]):
        raise PosicionInvalida("La posición está fuera de Santiago: revisa el GPS (lat, lon)")


def _evento(conn: Connection, tipo: str, payload: dict[str, Any]) -> None:
    conn.execute("insert into events (tipo, payload) values (%s, %s)", (tipo, Jsonb(payload)))


# ---------------------------------------------------------------------------
# Cuadrillas
# ---------------------------------------------------------------------------
def listar(conn: Connection, ver_privado: bool) -> list[dict[str, Any]]:
    filas = conn.execute(
        """
        select c.id, c.nombre, c.equipamiento, c.estado, c.is_simulated,
               st_y(c.geom_actual) as lat, st_x(c.geom_actual) as lon,
               (select count(*) from missions m where m.crew_id = c.id and m.estado = any(%s)) as carga
          from crews c order by c.id
        """,
        (list(ACTIVAS),),
    ).fetchall()
    for f in filas:
        if not (f["is_simulated"] or ver_privado):
            f["lat"] = f["lon"] = None
            f["posicion_oculta"] = True
    return filas


def actualizar_posicion(conn: Connection, crew_id: str, lat: float, lon: float) -> dict[str, Any]:
    validar_posicion(lat, lon)
    with conn.transaction():
        fila = conn.execute(
            "update crews set geom_actual = st_setsrid(st_point(%s, %s), 4326) where id = %s returning id",
            (lon, lat, crew_id),
        ).fetchone()
        if fila is None:
            raise NoEncontrado(f"Cuadrilla {crew_id} no existe")
        conn.execute("insert into crew_positions (crew_id, geom) values (%s, st_setsrid(st_point(%s, %s), 4326))",
                     (crew_id, lon, lat))
    return {"crew_id": crew_id, "lat": lat, "lon": lon}


def _paradas(conn: Connection, crew_id: str) -> list[dict[str, Any]]:
    """Misiones activas en orden, con ubicación PÚBLICA (sumidero o casos_publicos)."""
    return conn.execute(
        """
        select m.id as mission_id, m.orden, m.estado, m.sumidero_id, m.case_id,
               coalesce(s.calle, 'Caso reportado') as nombre,
               st_y(coalesce(s.geom, cp.geom)) as lat, st_x(coalesce(s.geom, cp.geom)) as lon
          from missions m
          left join sumideros s on s.id = m.sumidero_id
          left join casos_publicos cp on cp.id = m.case_id
         where m.crew_id = %s and m.estado = any(%s)
         order by m.orden nulls last, m.asignada_at
        """,
        (crew_id, list(ACTIVAS)),
    ).fetchall()


def ultimo_cambio(conn: Connection, crew_id: str) -> dict[str, Any] | None:
    """Último cambio de ruta de la cuadrilla (evento `replan` del despacho, #32) y qué lo causó.

    Lo usa la app de cuadrilla (#38) para avisar "cambió tu siguiente parada" con su motivo.
    Privacidad (#104): de la observación que lo causó solo salen su tipo, fuente y la
    clasificación en categorías; nunca el texto, la foto ni la ubicación del reporte.
    """
    fila = conn.execute(
        """
        select e.ts, e.payload->>'motivo' as motivo, e.payload->'ruta_version' as ruta_version,
               e.payload->'siguiente_antes' as siguiente_antes,
               e.payload->'siguiente_despues' as siguiente_despues,
               o.tipo as obs_tipo, o.fuente as obs_fuente, o.is_simulated as obs_simulada,
               c.resultado->>'rejilla' as rejilla, c.resultado->>'nivel_agua' as nivel_agua,
               c.resultado->'material' as material
          from events e
          left join observations o on o.id::text = e.payload->>'observation_id'
          left join lateral (
                select resultado from classifications cl where cl.observation_id = o.id
                 order by cl.created_at desc, cl.id desc limit 1
          ) c on true
         where e.tipo = 'replan' and e.payload->>'crew_id' = %s
         order by e.id desc
         limit 1
        """,
        (crew_id,),
    ).fetchone()
    if fila is None:
        return None
    observacion = None
    if fila["obs_tipo"] is not None:
        observacion = {"tipo": fila["obs_tipo"], "fuente": fila["obs_fuente"], "is_simulated": fila["obs_simulada"],
                       "rejilla": fila["rejilla"], "nivel_agua": fila["nivel_agua"],
                       "material": fila["material"] if isinstance(fila["material"], list) else []}
    return {"hora": fila["ts"], "motivo": fila["motivo"], "ruta_version": fila["ruta_version"],
            "siguiente_antes": fila["siguiente_antes"], "siguiente_despues": fila["siguiente_despues"],
            "observacion": observacion}


def ruta(conn: Connection, crew_id: str, ver_privado: bool = False) -> dict[str, Any]:
    """Ruta vigente: la última versión guardada por el despacho (#32) o, si no hay, una calculada
    al vuelo desde la posición de la cuadrilla por sus misiones activas (sin guardarla).

    Privacidad (misma regla que `listar`): para una cuadrilla REAL sin permiso de admin no se usa
    su posición ni la ruta guardada (puede partir en su posición); se calcula desde la primera
    parada y se marca `posicion_oculta: true`."""
    crew = conn.execute("select id, is_simulated, st_y(geom_actual) as lat, st_x(geom_actual) as lon"
                        " from crews where id = %s", (crew_id,)).fetchone()
    if crew is None:
        raise NoEncontrado(f"Cuadrilla {crew_id} no existe")
    oculta = not (crew["is_simulated"] or ver_privado)
    extra = {"posicion_oculta": True} if oculta else {}
    cambio = ultimo_cambio(conn, crew_id)
    paradas = _paradas(conn, crew_id)
    if not oculta:
        guardada = conn.execute(
            "select version, geojson, paradas, computed_at from routes where crew_id = %s"
            " order by version desc limit 1",
            (crew_id,),
        ).fetchone()
        if guardada:
            return {"crew_id": crew_id, "origen": "despacho", **guardada, "misiones": paradas,
                    "ultimo_cambio": cambio}

    puntos = [(p["lat"], p["lon"]) for p in paradas if p["lat"] is not None]
    if crew["lat"] is not None and not oculta:
        puntos = [(crew["lat"], crew["lon"]), *puntos]
    if not puntos:
        return {"crew_id": crew_id, "origen": "sin_misiones", "version": None, "geojson": None,
                "paradas": [], "misiones": [], "ultimo_cambio": cambio, **extra}
    r = routing.ruta(puntos).to_dict()
    return {"crew_id": crew_id, "origen": "calculada", "version": None, **r, "misiones": paradas,
            "ultimo_cambio": cambio, **extra}


# ---------------------------------------------------------------------------
# Misiones
# ---------------------------------------------------------------------------
def _estado_actual(conn: Connection, mission_id: str) -> str:
    fila = conn.execute("select estado from missions where id = %s", (mission_id,)).fetchone()
    if fila is None:
        raise NoEncontrado(f"Misión {mission_id} no existe")
    return fila["estado"]


def _sincronizar(conn: Connection, mision: dict[str, Any]) -> None:
    """Refleja el avance en la cuadrilla y en el caso asociado."""
    if mision["crew_id"]:
        conn.execute(
            """
            update crews set estado = case
              when exists (select 1 from missions where crew_id = %(c)s and estado = 'en_sitio') then 'en_sitio'
              when exists (select 1 from missions where crew_id = %(c)s and estado = 'en_camino') then 'en_ruta'
              else 'disponible' end
             where id = %(c)s
            """,
            {"c": mision["crew_id"]},
        )
    if mision["case_id"]:
        nuevo_caso = {"en_camino": "en_curso", "en_sitio": "en_curso", "cerrada": "resuelto",
                      "pendiente": "asignado", "cancelada": "abierto"}[mision["estado"]]
        conn.execute(
            "update cases set estado = %s, cerrado_at = case when %s = 'resuelto' then now() else null end"
            " where id = %s and estado <> 'descartado'",
            (nuevo_caso, nuevo_caso, mision["case_id"]),
        )


def cambiar_estado(conn: Connection, mission_id: str, nuevo: str) -> dict[str, Any]:
    if nuevo not in TRANSICIONES:
        raise TransicionInvalida("?", nuevo)
    with conn.transaction():
        mision = conn.execute(
            "update missions set estado = %s where id = %s and estado = any(%s)"
            " returning id, crew_id, case_id, sumidero_id, estado",
            (nuevo, mission_id, list(TRANSICIONES[nuevo])),
        ).fetchone()
        if mision is None:
            raise TransicionInvalida(_estado_actual(conn, mission_id), nuevo)
        _sincronizar(conn, mision)
        _evento(conn, "mision_estado", {"mission_id": str(mission_id), "estado": nuevo, "crew_id": mision["crew_id"]})
    return mision


def cerrar_mision(conn: Connection, mission_id: str, foto_ruta: str) -> dict[str, Any]:
    """Cierra la misión registrando la foto (ya subida). La verificación con Claude es #42:
    hasta entonces `verificado = false`."""
    with conn.transaction():
        mision = conn.execute(
            "update missions set estado = 'cerrada', cerrada_at = now() where id = %s and estado = any(%s)"
            " returning id, crew_id, case_id, sumidero_id, estado",
            (mission_id, list(CERRABLE_DESDE)),
        ).fetchone()
        if mision is None:
            raise TransicionInvalida(_estado_actual(conn, mission_id), "cerrada")
        cierre = conn.execute(
            "insert into closures (mission_id, foto_url, verificado) values (%s, %s, false)"
            " returning id, mission_id, foto_url, verificado, created_at",
            (mission_id, foto_ruta),
        ).fetchone()
        _sincronizar(conn, mision)
        _evento(conn, "mision_cerrada", {"mission_id": str(mission_id), "closure_id": str(cierre["id"]),
                                         "crew_id": mision["crew_id"], "verificado": False})
    return {"mision": mision, "cierre": cierre}


def existe_mision(conn: Connection, mission_id: str) -> None:
    _estado_actual(conn, mission_id)
