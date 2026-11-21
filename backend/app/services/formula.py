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

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

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
    # Reportes de texto (sin foto) vigentes que apuntan a una rejilla tapada o basura
    reportes_texto: int = 0
    # Fase Durante: peor nivel de agua observado reciente
    nivel_agua: str | None = None
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
    return max(lo, min(hi, x))


def _f(features: Mapping[str, float], key: str) -> float:
    v = features.get(key)
    return 0.0 if v is None else float(v)


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


def p_final(s: SumideroInput, cfg: Mapping[str, Any]) -> tuple[float, float, float | None, dict[str, Any]]:
    """P que usa la fórmula. Devuelve (P, P_pred, P_obs, detalle).

    Lo confirmado manda: si hay una foto evaluable vigente, P = valor observado.
    Si no, P_pred más el aporte de los reportes de texto (pesan menos que una foto).
    """
    pp, aportes = p_pred(s.features, cfg)
    detalle: dict[str, Any] = {"aportes": aportes}

    obs_map = cfg["observado"]
    if s.rejilla_observada in ("limpia", "parcial", "tapada"):
        p_obs = float(obs_map[s.rejilla_observada])
        detalle["fuente_p"] = "foto"
        return p_obs, pp, p_obs, detalle

    rt = cfg["reportes_texto"]
    extra = min(rt["max_aporte"], rt["factor"] * rt["aporte_por_reporte"] * max(0, s.reportes_texto))
    if extra:
        detalle["aporte_reportes_texto"] = extra
    detalle["fuente_p"] = "prediccion"
    return clamp(pp + extra), pp, None, detalle


# ---------------------------------------------------------------------------
# Paso 2: efecto en cadena (§6.2)
# ---------------------------------------------------------------------------
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
        ids, dist = list(ch.sumidero_ids), list(ch.distancias_m)
        for i, sid in enumerate(ids):
            if sid not in p:
                continue
            acc = sum(
                p[ids[j]] * math.exp(-abs(dist[i] - dist[j]) / lam)
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
) -> float:
    """C = norm(área) · (1 + w_crit · criticidad). En Durante: C · (1 + w_agua · nivel_agua)."""
    c = clamp(area_norm) * (1 + cfg["consecuencia"]["w_crit"] * clamp(criticidad))
    if modo == "durante" and nivel_agua:
        nivel = cfg["durante"]["nivel_agua"].get(nivel_agua, 0.0)
        c *= 1 + cfg["durante"]["w_agua"] * nivel
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
        c = consecuencia(area_norm[s.id], _f(s.features, "criticidad"), cfg, s.nivel_agua, modo)
        det = {**det, "aporte_cadena": aporte_cadena.get(s.id, 0.0), "area_norm": area_norm[s.id],
               "criticidad": _f(s.features, "criticidad")}
        if modo == "durante" and s.nivel_agua:
            det["nivel_agua"] = s.nivel_agua
        urgente = modo == "durante" and s.urgente
        scores.append(Score(s.id, pp, po, p[s.id], p_ef[s.id], c, p_ef[s.id] * c, urgente, detalle=det))

    scores.sort(key=lambda x: (not x.urgente, -x.prioridad, x.sumidero_id))
    for i, sc in enumerate(scores, start=1):
        sc.rank = i
    return scores
