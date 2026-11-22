"""
Predicción congelada de la prueba de campo (issue #22, docs/plan-desarrollo.md §8.1).

Uso (desde la raíz del repo, después de 03_terreno.py y 04_variables.py):
    pip install -r pipeline/requirements.txt
    python pipeline/05_prediccion.py                  # zona MUT (la predicción congelada)
    python pipeline/05_prediccion.py --sufijo replay  # sector del replay (issue #87)

Salidas (en data/validacion/):
    prediccion_congelada.csv        ranking de las rejillas de la zona MUT
    prediccion_congelada.meta.json  pesos usados, parámetros, centro del MUT y sha256 de todo
    prediccion_<sufijo>.csv/.meta.json  lo mismo para otra zona (--sufijo distinto de mut)

Cómo calcula:
  - Usa backend/config/formula_validacion.yaml (sin días desde la limpieza ni cámara) y la
    fórmula de backend/app/services/formula.py, la misma que usa la API.
  - Una variable con peso en la configuración pero sin dato en las entradas queda con peso 0.
    Los pesos restantes se reescalan para que sigan sumando 1, y la metadata anota cuáles
    faltaron y los pesos efectivos.
  - Solo entran las rejillas de la zona (columna en_zona_<sufijo> del terreno). Las cadenas calle abajo se recortan a esas rejillas
    (las de fuera de la zona no tienen variables), conservando las distancias reales.
  - No hay fotos: todo es predicción ("lo confirmado manda" no aplica todavía).

Después del congelamiento no se vuelve a correr ni se tocan los pesos.
"""

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import yaml

SCRIPT_VERSION = "1.1.0"
REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from app.services.formula import PESO_A_FEATURE, StreetChain, SumideroInput, calcular_ranking  # noqa: E402


def sha256(ruta):
    return hashlib.sha256(Path(ruta).read_bytes()).hexdigest()


def git_head():
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    except Exception:  # noqa: BLE001
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sufijo", default="mut", help="zona calculada por 03 y 04 con el mismo --sufijo")
    ap.add_argument("--config", default="backend/config/formula_validacion.yaml")
    ap.add_argument("--terreno", default=None, help="por defecto data/terreno_<sufijo>.csv")
    ap.add_argument("--variables", default=None, help="por defecto data/variables_<sufijo>.csv")
    ap.add_argument("--cadenas", default=None, help="por defecto data/street_chains_<sufijo>.json")
    ap.add_argument("--rejillas", default="data/rejillas.geojson")
    ap.add_argument("--salida", default=None,
                    help="por defecto data/validacion/prediccion_congelada.csv (mut) o prediccion_<sufijo>.csv")
    a = ap.parse_args()
    a.terreno = a.terreno or f"data/terreno_{a.sufijo}.csv"
    a.variables = a.variables or f"data/variables_{a.sufijo}.csv"
    a.cadenas = a.cadenas or f"data/street_chains_{a.sufijo}.json"
    a.salida = a.salida or ("data/validacion/prediccion_congelada.csv" if a.sufijo == "mut"
                            else f"data/validacion/prediccion_{a.sufijo}.csv")

    cfg = yaml.safe_load(Path(a.config).read_text(encoding="utf-8"))
    ter = pd.read_csv(a.terreno)
    var = pd.read_csv(a.variables)
    meta_ter = json.loads(Path(a.terreno).with_name(f"terreno_{a.sufijo}.meta.json").read_text(encoding="utf-8"))
    meta_var = json.loads(Path(a.variables).with_name(f"variables_{a.sufijo}.meta.json").read_text(encoding="utf-8"))
    if meta_ter["zona"] != meta_var["zona"]:
        raise SystemExit("Terreno y variables se calcularon con zonas distintas.")
    col_zona = meta_ter["zona"].get("columna", "en_zona_mut")

    zona = ter[ter[col_zona] & ~ter["fuera_de_red"]].merge(var, on="ID_IDE", how="left", validate="1:1")
    sin_var = zona[zona["arboles"].isna()]["ID_IDE"].tolist()
    if sin_var:
        raise SystemExit(f"Rejillas sin variables: {sin_var}")
    fuera = ter[ter[col_zona] & ter["fuera_de_red"]]["ID_IDE"].tolist()

    # Variables disponibles y pesos efectivos
    columnas = set(zona.columns) | {"area_aporte"}  # area_aporte viene como area_aporte_m2
    pesos_cfg = dict(cfg["p_pred"])
    faltantes = sorted(w for w, f in PESO_A_FEATURE.items() if pesos_cfg.get(w, 0) > 0 and f not in columnas)
    pesos = {w: (0.0 if w in faltantes else float(v)) for w, v in pesos_cfg.items()}
    total = sum(pesos.values())
    if total <= 0:
        raise SystemExit("No queda ninguna variable con peso.")
    pesos = {w: v / total for w, v in pesos.items()}
    cfg_ef = {**cfg, "p_pred": pesos}
    print("Variables sin dato (peso 0):", [PESO_A_FEATURE[w] for w in faltantes] or "ninguna")
    print("Pesos efectivos:", {w: round(v, 6) for w, v in pesos.items()})

    feats_p = [f for w, f in PESO_A_FEATURE.items() if f in columnas and f != "area_aporte"]
    entradas = []
    for _, r in zona.iterrows():
        f = {k: float(r[k]) for k in feats_p}
        f["area_aporte"] = float(r["area_aporte_m2"])
        f["criticidad"] = float(r["criticidad"])
        entradas.append(SumideroInput(r["ID_IDE"], f))

    ids = set(zona["ID_IDE"])
    cadenas, vistas = [], set()
    for c in json.loads(Path(a.cadenas).read_text(encoding="utf-8")):
        par = [(s, d) for s, d in zip(c["sumidero_ids"], c["distancias_m"]) if s in ids]
        clave = tuple(s for s, _ in par)
        if len(par) >= 2 and clave not in vistas:
            vistas.add(clave)
            cadenas.append(StreetChain(c["street_id"], [s for s, _ in par], [d for _, d in par]))
    print(f"Rejillas: {len(entradas)}; cadenas dentro de la zona: {len(cadenas)}")

    scores = calcular_ranking(entradas, cadenas, cfg_ef, "antes")

    import geopandas as gpd

    rej = gpd.read_file(a.rejillas)
    rej = rej[rej["ID_IDE"].isin(ids)]
    pos = {r.ID_IDE: (round(r.geometry.x, 6), round(r.geometry.y, 6)) for r in rej.itertuples()}
    info = zona.set_index("ID_IDE")
    n = len(scores)
    filas = []
    for s in scores:
        r = info.loc[s.sumidero_id]
        filas.append({
            "rank": s.rank,
            "ID_IDE": s.sumidero_id,
            "lon": pos[s.sumidero_id][0],
            "lat": pos[s.sumidero_id][1],
            "calle": r["calle"],
            "comuna": r["comuna_x"] if "comuna_x" in r else r.get("comuna"),
            "mitad_alta": s.rank <= (n + 1) // 2,
            "p_pred": round(s.p_pred, 6),
            "p_ef": round(s.p_ef, 6),
            "aporte_cadena": round(s.detalle.get("aporte_cadena", 0.0), 6),
            "c": round(s.c, 6),
            "prioridad": round(s.prioridad, 6),
            **{k: r[k] for k in feats_p},
            "area_aporte_m2": r["area_aporte_m2"],
            "area_norm": round(s.detalle.get("area_norm", 0.0), 6),
            "criticidad": r["criticidad"],
            "criticidad_motivo": r["criticidad_motivo"] if isinstance(r["criticidad_motivo"], str) else "",
            "d_feria_m": r["d_feria_m"],
        })
    salida = Path(a.salida)
    salida.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(filas).to_csv(salida, index=False)

    meta = {
        "generado_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "git_head_al_generar": git_head(),
        "regla": "Predicción hecha antes de fotografiar. Después de este commit no se cambian pesos ni datos.",
        f"zona_{a.sufijo}": {**meta_ter["zona"], "rejillas_en_zona": int(ter[col_zona].sum()),
                     "rejillas_rankeadas": n, "fuera_de_red_excluidas": fuera},
        "formula": {
            "config": a.config, "sha256_config": sha256(a.config),
            "codigo": "backend/app/services/formula.py", "sha256_codigo": sha256(REPO / "backend/app/services/formula.py"),
            "modo": "antes",
            "pesos_config": pesos_cfg,
            "variables_sin_dato_peso_0": {w: PESO_A_FEATURE[w] for w in faltantes},
            "pesos_efectivos": {w: round(v, 6) for w, v in pesos.items()},
            "reescalado": f"pesos con dato divididos por {round(total, 6)} para sumar 1",
            "cadena": cfg["cadena"], "consecuencia": cfg["consecuencia"],
        },
        "parametros_entradas": {"terreno": meta_ter["parametros"], "variables": meta_var["variables"]},
        "cadenas": {"usadas": len(cadenas), "regla": "cadenas de 03_terreno recortadas a las rejillas de la zona"},
        "entradas": {k: {"ruta": v, "sha256": sha256(v)} for k, v in
                     {"terreno": a.terreno, "variables": a.variables, "cadenas": a.cadenas, "rejillas": a.rejillas}.items()},
        "metas_entradas": {"terreno": meta_ter["script"], "variables": meta_var["script"]},
        "salida": {"archivo": salida.name, "sha256": sha256(salida)},
        "script": {"ruta": "pipeline/05_prediccion.py", "version": SCRIPT_VERSION, "sha256": sha256(__file__)},
    }
    ruta_meta = salida.with_name(salida.stem + ".meta.json")
    ruta_meta.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(pd.DataFrame(filas)[["rank", "ID_IDE", "calle", "p_ef", "c", "prioridad"]].head(10).to_string(index=False))
    print(f"Guardado {salida} y {ruta_meta}")


if __name__ == "__main__":
    main()
