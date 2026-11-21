"""Simulador de la línea de tiempo de la demo (issue #46).

Reproduce `data/demo_timeline.json` con un reloj propio. El estado se calcula a partir del
tiempo transcurrido (no hay hilos), así que la demo es repetible: el mismo timeline y los
mismos instantes dan siempre la misma secuencia de eventos.

Cada evento que vence se entrega al `sink`. Hoy el sink por defecto solo lo guarda en memoria
(MOCK): cuando existan POST /observations (#28) y las cuadrillas (#33), basta con pasar un
sink que los llame, sin tocar el reloj ni los endpoints.
"""
from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from app.config import REPO_DIR

TIMELINE_PATH = REPO_DIR / "data" / "demo_timeline.json"

Evento = dict[str, Any]
Sink = Callable[[Evento], None]


def cargar_timeline(path: Path = TIMELINE_PATH) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    data["eventos"] = sorted(data["eventos"], key=lambda e: e["t"])
    return data


class Simulador:
    def __init__(self, timeline: dict[str, Any] | None = None, reloj: Callable[[], float] = time.monotonic, sink: Sink | None = None):
        self._timeline = timeline or cargar_timeline()
        self._reloj = reloj
        self._sink = sink
        self._lock = threading.RLock()
        self._reset()

    def _reset(self) -> None:
        self.estado = "detenida"          # detenida | corriendo | pausada | terminada
        self._acumulado = 0.0              # segundos simulados antes del último start
        self._desde: float | None = None   # instante del reloj en que arrancó
        self._siguiente = 0                # índice del próximo evento del timeline
        self.aplicados: list[Evento] = []
        self._en_vivo = 0

    def _transcurrido(self) -> float:
        extra = self._reloj() - self._desde if self._desde is not None else 0.0
        return self._acumulado + extra

    def _emitir(self, evento: Evento) -> None:
        self.aplicados.append(evento)
        if self._sink:
            self._sink(evento)

    def _avanzar(self) -> None:
        if self.estado != "corriendo":
            return
        t = self._transcurrido()
        eventos = self._timeline["eventos"]
        while self._siguiente < len(eventos) and eventos[self._siguiente]["t"] <= t:
            self._emitir(eventos[self._siguiente])
            self._siguiente += 1
        if self._siguiente >= len(eventos) and t >= self._timeline.get("duracion_s", 0):
            self._acumulado, self._desde = t, None
            self.estado = "terminada"

    def start(self) -> dict[str, Any]:
        with self._lock:
            if self.estado == "terminada":
                self._reset()
            if self.estado in ("detenida", "pausada"):
                self._desde = self._reloj()
                self.estado = "corriendo"
            return self.status()

    def stop(self) -> dict[str, Any]:
        with self._lock:
            self._avanzar()
            if self.estado == "corriendo":
                self._acumulado, self._desde = self._transcurrido(), None
                self.estado = "pausada"
            return self.status()

    def reset(self) -> dict[str, Any]:
        with self._lock:
            self._reset()
            return self.status()

    def disparar(self, payload: Evento) -> Evento:
        """Inyecta un reporte en vivo, fuera del timeline (no altera su repetibilidad)."""
        with self._lock:
            self._en_vivo += 1
            evento = {"t": round(self._transcurrido(), 3), "tipo": "reporte", "en_vivo": True, "payload": {"id_en_vivo": self._en_vivo, **payload}}
            self._emitir(evento)
            return evento

    def status(self) -> dict[str, Any]:
        with self._lock:
            self._avanzar()
            return {
                "estado": self.estado,
                "t": round(self._transcurrido(), 3),
                "duracion_s": self._timeline.get("duracion_s"),
                "eventos_aplicados": len(self.aplicados),
                "eventos_total": len(self._timeline["eventos"]),
                "eventos": list(self.aplicados),
            }


_instancia: Simulador | None = None
_lock = threading.Lock()


def get_simulador() -> Simulador:
    global _instancia
    with _lock:
        if _instancia is None:
            _instancia = Simulador()
        return _instancia
