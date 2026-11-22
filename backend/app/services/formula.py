"""Fórmula determinista de prioridad (docs/plan-desarrollo.md §6).

    P      probabilidad de que el sumidero se tape (§6.1)
    P_ef   P más el efecto en cadena de los sumideros aguas arriba (§6.2)
    C      consecuencia: agua que le llega y criticidad cercana (§6.3, §6.5)
    prioridad = P_ef × C (§6.4)

Este módulo es puro: no habla con la base ni con Claude. Con los mismos datos
devuelve siempre el mismo resultado. Los pesos vienen de `config/formula.yaml`.

Features que espera en `SumideroInput.features` (todas normalizadas 0-1 salvo área):
    arboles, feria, obras, suelo, pendiente, clima, dias_sin_limpieza, camara,
    area_aporte (m², valor crudo), criticidad (0-1)
Si falta una feature, cuenta como 0.
"""
from __future__ import annotations

import logging
import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from itertools import pairwise
from typing import Any

log = logging.getLogger(__name__)

# Feature del sumidero que corresponde a cada peso de p_pred
PESO_A_FEATURE = {
    "w_arb": "arboles",
    "w_feria": "feria",
    "w_obra": "obras",
    "w_suelo": "suelo",
    "w_pend": "pendiente",
    "w_clima": "clima",
    "w_dias": "dias_sin_limpieza",
    "w_cam": "camara",
}


@dataclass
class SumideroInput:
    id: str
    features: Mapping[str, float] = field(default_factory=dict)
    # Última foto evaluable y vigente de la rejilla: 'limpia' | 'parcial' | 'tapada' | None
    rejilla_observada: str | None = None
    # Confianza que Claude dio a esa foto: 'alta' | 'media' | 'baja' | None (clasificación antigua)
    confianza_foto: str | None = None
    # Reportes de texto (sin foto) vigentes que apuntan a una rejilla tapada o basura
    reportes_texto: int = 0
    # Confianza de cada uno de esos reportes, si la clasificación la trae (#124). Los reportes
    # sin confianza registrada (hoy `LecturaTexto` no la tiene) cuentan con factor 1.
    confianza_textos: Sequence[str | None] = ()
    # Fase Durante: nivel de agua observado reciente con mayor nivel · factor de confianza
    nivel_agua: str | None = None
    # Confianza de la clasificación que aportó ese nivel (None: texto o clasificación antigua)
    confianza_agua: str | None = None
    # Fase Durante: hay un caso urgente (personas en riesgo) asociado
    urgente: bool = False


@dataclass
class StreetChain:
    street_id: str
    sumidero_ids: Sequence[str]        # de mayor a menor elevación
    distancias_m: Sequence[float]      # distancia acumulada desde el primero


@dataclass
class Score:
    sumidero_id: str
    p_pred: float
    p_obs: float | None
    p: float
    p_ef: float
    c: float
    prioridad: float
    urgente: bool = False
    rank: int = 0
    # Aporte de cada factor, para la ficha y para que Claude explique (§5.4)
    detalle: dict[str, Any] = field(default_factory=dict)


def clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    """Acota a [lo, hi]. Un NaN cuenta como `lo` (dato inválido = sin aporte), no como máximo."""
    if x != x:  # NaN
        return lo
    return max(lo, min(hi, x))


def _f(features: Mapping[str, float], key: str) -> float:
    """Feature numérica; si falta, no es número o es NaN/infinito, cuenta como 0."""
    v = features.get(key)
    try:
        v = float(v)
    except (TypeError, ValueError):
        return 0.0
    return v if math.isfinite(v) else 0.0


# ---------------------------------------------------------------------------
# Paso 1: P (§6.1)
# ---------------------------------------------------------------------------
def p_pred(features: Mapping[str, float], cfg: Mapping[str, Any]) -> tuple[float, dict[str, float]]:
    """Probabilidad predicha solo con variables. Devuelve (P_pred, aportes por factor)."""
    aportes = {
        feat: cfg["p_pred"][w] * clamp(_f(features, feat))
        for w, feat in PESO_A_FEATURE.items()
        if w in cfg["p_pred"]
    }
    return clamp(sum(aportes.values())), aportes


def factor_confianza(confianza: str | None, cfg: Mapping[str, Any]) -> float:
    """Factor 0-1 de la confianza de Claude (#88, #124).

    Sin confianza registrada (clasificación antigua o texto) o sin tabla `confianza` en la
    config (p. ej. `formula_validacion.yaml`, congelada), el factor es 1: la observación pesa
    como antes de ponderar.
    """
    tabla = cfg.get("confianza") or {}
    if confianza not in tabla:
        return 1.0
    return clamp(float(tabla[confianza]))


def elegir_agua(
    lecturas: Iterable[tuple[str, str | None]], cfg: Mapping[str, Any]
) -> tuple[str, str | None] | None:
    """Entre lecturas (nivel_agua, confianza) vigentes, la que más sube C (§6.5, #124).

    Gana el mayor nivel · factor de confianza; en un empate, el nivel más alto y después la
    confianza más alta. Niveles fuera de `durante.nivel_agua` se ignoran.
    """
    niveles = cfg["durante"]["nivel_agua"]
    mejor, clave_mejor = None, None
    for nivel, conf in lecturas:
        if nivel not in niveles:
            continue
        v, f = float(niveles[nivel]), factor_confianza(conf, cfg)
        clave = (v * f, v, f)
        if clave_mejor is None or clave > clave_mejor:
            mejor, clave_mejor = (nivel, conf), clave
    return mejor


def p_final(s: SumideroInput, cfg: Mapping[str, Any]) -> tuple[float, float, float | None, dict[str, Any]]:
    """P que usa la fórmula. Devuelve (P, P_pred, P_obs, detalle).

    Lo confirmado manda: si hay una foto evaluable vigente, P se acerca al valor observado
    según la confianza de Claude: P = P_pred + factor·(P_obs − P_pred). Con confianza alta o
    sin confianza registrada (factor 1), P = P_obs.
    Si no hay foto, P_pred más el aporte de los reportes de texto (pesan menos que una foto).
    Cada reporte aporta en proporción al factor de su confianza (1 si no la trae).
    """
    pp, aportes = p_pred(s.features, cfg)
    detalle: dict[str, Any] = {"aportes": aportes}

    obs_map = cfg["observado"]
    if s.rejilla_observada in ("limpia", "parcial", "tapada"):
        p_obs = float(obs_map[s.rejilla_observada])
        detalle["fuente_p"] = "foto"
        # Las clasificaciones históricas sin confianza conservan el peso original.
        factor = factor_confianza(s.confianza_foto, cfg)
        detalle["confianza_foto"] = s.confianza_foto
        detalle["factor_confianza_foto"] = factor
        p = p_obs if factor == 1 else pp + factor * (p_obs - pp)
        return p, pp, p_obs, detalle

    rt = cfg["reportes_texto"]
    n = max(0, s.reportes_texto)
    confs = list(s.confianza_textos)[:n]
    factores = [factor_confianza(c, cfg) for c in confs] + [1.0] * (n - len(confs))
    extra = min(rt["max_aporte"], rt["factor"] * rt["aporte_por_reporte"] * sum(factores))
    if extra:
        detalle["aporte_reportes_texto"] = extra
    if any(c is not None for c in confs):
        detalle["factores_confianza_texto"] = factores
    detalle["fuente_p"] = "prediccion"
    return clamp(pp + extra), pp, None, detalle


# ---------------------------------------------------------------------------
# Paso 2: efecto en cadena (§6.2)
# ---------------------------------------------------------------------------
def distancias_validas(ch: StreetChain) -> list[float] | None:
    """Distancias de la cadena como float, o None si la cadena es inválida.

    Válida = mismo largo de ids y distancias, distancias numéricas, finitas y no
    decrecientes (de arriba a abajo). El cálculo usa ESTA lista convertida, así la
    validación y el cálculo nunca ven valores distintos (p. ej. números guardados como texto).
    """
    ids, dist = list(ch.sumidero_ids), list(ch.distancias_m)
    if len(ids) != len(dist):
        return None
    try:
        d = [float(x) for x in dist]
    except (TypeError, ValueError):
        return None
    if all(math.isfinite(x) for x in d) and all(b >= a for a, b in pairwise(d)):
        return d
    return None


def cadena_valida(ch: StreetChain) -> bool:
    return distancias_validas(ch) is not None


def efecto_cadena(
    p: Mapping[str, float],
    chains: Iterable[StreetChain],
    cfg: Mapping[str, Any],
    confirmados: set[str] | None = None,
) -> tuple[dict[str, float], dict[str, float]]:
    """P_ef(i) = min(P(i) + α·Σ_{j aguas arriba} P(j)·e^(-d_ij/λ), P(i) + tope), máximo 1.

    Aguas arriba usa P (no P_ef) para no acumular dos veces. Un sumidero con foto
    confirmada mantiene su P fija (lo confirmado manda), pero sí empuja a los de abajo.
    Si un sumidero aparece en varias calles, se queda con el mayor aporte.
    Devuelve (P_ef, aporte de la cadena por sumidero).
    """
    alpha, lam, tope = cfg["cadena"]["alpha"], cfg["cadena"]["lambda_m"], cfg["cadena"]["tope"]
    confirmados = confirmados or set()
    aporte: dict[str, float] = {}
    for ch in chains:
        ids, dist = list(ch.sumidero_ids), distancias_validas(ch)
        if dist is None:
            # Datos mal cargados: se ignora esta calle (sin efecto en cadena) en vez de romper
            # el recálculo. Se registra para corregir el pipeline.
            log.warning("street_chain %s inválida (largos %d/%d o distancias no crecientes); se ignora",
                        ch.street_id, len(ids), len(list(ch.distancias_m)))
            continue
        for i, sid in enumerate(ids):
            if sid not in p:
                continue
            acc = sum(
                p[ids[j]] * math.exp(-(dist[i] - dist[j]) / lam)
                for j in range(i)
                if ids[j] in p
            )
            aporte[sid] = max(aporte.get(sid, 0.0), alpha * acc)

    p_ef: dict[str, float] = {}
    for sid, pi in p.items():
        if sid in confirmados:
            p_ef[sid] = pi
            continue
        p_ef[sid] = clamp(min(pi + aporte.get(sid, 0.0), pi + tope))
    return p_ef, aporte


# ---------------------------------------------------------------------------
# Paso 3: consecuencia (§6.3) y ajuste Durante (§6.5)
# ---------------------------------------------------------------------------
def normalizar_areas(areas: Mapping[str, float], modo: str = "log") -> dict[str, float]:
    """Normaliza el área de aporte a 0-1 dividiendo por el máximo.

    'log' (por defecto) usa log(1+área): las áreas tienen colas largas y sin esto
    unos pocos sumideros enormes dejarían al resto cerca de 0.
    """
    tr = (lambda a: math.log1p(max(0.0, a))) if modo == "log" else (lambda a: max(0.0, a))
    vals = {k: tr(v or 0.0) for k, v in areas.items()}
    mx = max(vals.values(), default=0.0)
    return {k: (v / mx if mx > 0 else 0.0) for k, v in vals.items()}


def consecuencia(
    area_norm: float,
    criticidad: float,
    cfg: Mapping[str, Any],
    nivel_agua: str | None = None,
    modo: str = "antes",
    factor_agua: float = 1.0,
) -> float:
    """C = área_efectiva · (1 + w_crit · criticidad).

    En Durante: C · (1 + w_agua · nivel_agua · factor_agua), con factor_agua el de la confianza
    de Claude en la clasificación que aportó el nivel (#124; 1 si no la trae).

    área_efectiva = piso + (1 - piso) · norm(área). El piso evita que un sumidero sin área
    de aporte (dato faltante o 0) quede con C = 0 y, por lo tanto, con prioridad 0 aunque
    tenga una rejilla tapada confirmada o infraestructura crítica al lado.
    """
    piso = clamp(cfg["consecuencia"].get("piso_area", 0.0))
    area_ef = piso + (1 - piso) * clamp(area_norm)
    c = area_ef * (1 + cfg["consecuencia"]["w_crit"] * clamp(criticidad))
    if modo == "durante" and nivel_agua:
        nivel = cfg["durante"]["nivel_agua"].get(nivel_agua, 0.0)
        c *= 1 + cfg["durante"]["w_agua"] * nivel * clamp(factor_agua)
    return c


# ---------------------------------------------------------------------------
# Paso 4: prioridad y ranking (§6.4)
# ---------------------------------------------------------------------------
def calcular_ranking(
    sumideros: Sequence[SumideroInput],
    chains: Iterable[StreetChain],
    cfg: Mapping[str, Any],
    modo: str = "antes",
) -> list[Score]:
    """Calcula P, P_ef, C y prioridad para todos y devuelve la tabla de misiones ordenada.

    En modo Durante, los urgentes (personas en riesgo) van primero (§6.5).
    Empates se rompen por id para que el orden sea siempre el mismo.
    """
    if modo not in ("antes", "durante"):
        raise ValueError(f"modo inválido: {modo}")

    p: dict[str, float] = {}
    pre: dict[str, tuple[float, float | None, dict[str, Any]]] = {}
    confirmados: set[str] = set()
    for s in sumideros:
        pi, pp, po, det = p_final(s, cfg)
        p[s.id], pre[s.id] = pi, (pp, po, det)
        if po is not None:
            confirmados.add(s.id)

    p_ef, aporte_cadena = efecto_cadena(p, chains, cfg, confirmados)
    area_mode = cfg["consecuencia"].get("normalizacion_area", "log")
    area_norm = normalizar_areas({s.id: _f(s.features, "area_aporte") for s in sumideros}, area_mode)

    scores: list[Score] = []
    for s in sumideros:
        pp, po, det = pre[s.id]
        factor_agua = factor_confianza(s.confianza_agua, cfg)
        c = consecuencia(area_norm[s.id], _f(s.features, "criticidad"), cfg, s.nivel_agua, modo, factor_agua)
        det = {**det, "aporte_cadena": aporte_cadena.get(s.id, 0.0), "area_norm": area_norm[s.id],
               "criticidad": _f(s.features, "criticidad")}
        if _f(s.features, "area_aporte") <= 0:
            det["area_faltante"] = True  # C usa solo el piso: revisar el dato en el pipeline
        if modo == "durante" and s.nivel_agua:
            det["nivel_agua"] = s.nivel_agua
            det["confianza_agua"] = s.confianza_agua
            det["factor_confianza_agua"] = factor_agua
        urgente = modo == "durante" and s.urgente
        scores.append(Score(s.id, pp, po, p[s.id], p_ef[s.id], c, p_ef[s.id] * c, urgente, detalle=det))

    scores.sort(key=lambda x: (not x.urgente, -x.prioridad, x.sumidero_id))
    for i, sc in enumerate(scores, start=1):
        sc.rank = i
    return scores
