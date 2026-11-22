import type { EstadoConsulta, Expuestos } from "./transporte";

export interface CargaTransporteDemo {
  datos: Expuestos | null;
  estado: EstadoConsulta;
}

export async function cargarTransporteDemo(publicar: (carga: CargaTransporteDemo) => void) {
  publicar({ datos: null, estado: "cargando" });
  try {
    const respuesta = await fetch("/data/demo-san-carlos-transporte.json", { cache: "no-store" });
    if (!respuesta.ok) throw new Error(String(respuesta.status));
    const datos: Expuestos = await respuesta.json();
    if (!datos || !Array.isArray(datos.expuestos) || !Array.isArray(datos.en_riesgo)) throw new Error("Transporte inválido");
    publicar({ datos, estado: "ok" });
  } catch {
    publicar({ datos: null, estado: "error" });
  }
}
