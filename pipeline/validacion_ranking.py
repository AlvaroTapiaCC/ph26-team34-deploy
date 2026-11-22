"""Preparación de las cadenas para un sector de validación."""

from app.services.formula import StreetChain


def cadenas_del_sector(cadenas, ids):
    resultado, vistas = [], set()
    for cadena in cadenas:
        pares = [(sid, d) for sid, d in zip(cadena["sumidero_ids"], cadena["distancias_m"]) if sid in ids]
        clave = tuple(sid for sid, _ in pares)
        if len(pares) >= 2 and clave not in vistas:
            vistas.add(clave)
            resultado.append(StreetChain(cadena["street_id"], list(clave), [d for _, d in pares]))
    return resultado
