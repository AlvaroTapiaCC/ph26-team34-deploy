# Cómo se eligieron los pesos de prioridad

La versión 1 ordena las rejillas por probabilidad efectiva de obstrucción multiplicada por consecuencia. Los valores son decisiones de diseño del equipo a falta de un historial local etiquetado. Las fuentes de la tabla sustentan las entradas; las magnitudes de los pesos se eligieron a criterio. Por ejemplo, una foto clasificada como tapada recibe 0,95 en la escala de la fórmula. Interpretar ese valor como una frecuencia observada exigiría una calibración con casos reales. [Configuración de la demo](../backend/config/formula.yaml) · [Cálculo](../backend/app/services/formula.py) · [Plan, §6](plan-desarrollo.md)

## Obstrucción antes de recibir una foto

Cada entrada varía entre 0 y 1. El peso es el máximo que esa entrada aporta a la suma.

| Clave | Peso | Entrada y procedencia | Razón del valor |
|---|---:|---|---|
| w_arb | 0,22 | Fracción de cobertura arbórea en 15 m, ESA WorldCover clase 10 | Es el mayor peso individual por el aporte directo de hojas junto a la rejilla. |
| w_feria | 0,14 | Proximidad a un mercado cartografiado en OpenStreetMap (OSM), hasta 300 m | Representa residuos concentrados en un punto; la ubicación por sí sola no indica actividad ese día. |
| w_obra | 0,08 | Construcción cartografiada en OSM a 100 m o menos | Señal indirecta de sedimento. La presencia de una obra aporta menos que la vegetación inmediata. |
| w_suelo | 0,08 | Fracción de suelo desnudo en 100 m, WorldCover clase 60 | Misma escala que obras por ser otra fuente potencial de sedimento cuyo arrastre depende de la lluvia. |
| w_pend | 0,14 | Pendiente normalizada del tramo, pipeline de terreno MUT | El arrastre puede concentrar material incluso con poca vegetación local; se le da peso intermedio. |
| w_clima | 0,10 | Lluvia y viento resumidos para el escenario | Modulan la movilización de material y son condiciones compartidas por muchas rejillas. |
| w_dias | 0,14 | Tiempo desde la última limpieza, historial simulado | Representa acumulación entre visitas. El tope dias_sin_limpieza_max de 90 días satura el aporte a los tres meses. |
| w_cam | 0,10 | Señal de hojas o basura en la calzada obtenida de una cámara | La cámara observa material cercano; una foto directa de la rejilla tiene mayor autoridad. |

## Evidencia y propagación

| Parámetros | Fuente y decisión |
|---|---|
| observado.tapada 0,95; parcial 0,60; limpia 0,05 | La última foto evaluable acerca la predicción a este valor según la confianza de Claude. Los extremos dejan margen para error y la clase parcial conserva prioridad intermedia. |
| confianza.alta 1,0; media 0,7; baja 0,4 | Factores de la alineación del equipo. P = P_pred + factor · (P_obs − P_pred): una foto de confianza alta fija P y una baja mueve el 40 % de la diferencia. Una clasificación sin confianza registrada usa factor 1. Solo rige en `formula.yaml`; `formula_validacion.yaml` quedó congelado antes de este cambio. |
| observado.vigencia_horas 72 | La hora de captura limita el uso de la foto a tres días para permitir que nuevas condiciones cambien el ranking. |
| reportes_texto.factor 0,5; aporte_por_reporte 0,3; max_aporte 0,5 | Cada reporte textual vigente aporta 0,15. El cuarto alcanza el tope de 0,5 para limitar la influencia de avisos repetidos. |
| tipos_que_suben_p | Las clases de texto rejilla_tapada y basura describen obstrucción. Un anegamiento aporta evidencia sobre el nivel de agua. |
| cadena.alpha 0,35; lambda_m 150; tope 0,30 | Las cadenas y distancias del pipeline de terreno ordenan las rejillas calle abajo. Cada señal aguas arriba empieza con el 35 % de su valor y a 150 m conserva cerca del 37 % de ese aporte. El máximo conjunto de 0,30 evita que una cadena larga domine el diagnóstico local. |

## Consecuencia y operación durante la lluvia

| Parámetros | Fuente y decisión |
|---|---|
| normalizacion_area log; piso_area 0,15 | El área de aporte estimada por terreno tiene valores muy dispares. El logaritmo conserva diferencias entre áreas pequeñas. El piso da consecuencia positiva incluso cuando falta el área. |
| w_crit 1,0; radio_crit_m 200 | Se toma la mayor criticidad de infraestructura cercana dentro de un entorno peatonal de 200 m. Con criticidad máxima, la consecuencia se duplica. |
| metro 1,0; paso_bajo_nivel 1,0 | Las ubicaciones de OSM representan accesos o tramos deprimidos donde el agua puede interrumpir la circulación. Ambos reciben el máximo de la escala. |
| hospital 0,9; colegio 0,6 | La infraestructura de OSM aproxima exposición. Se prioriza el acceso continuo de urgencia al hospital; el colegio recibe peso intermedio por la concentración de personas. |
| punto_critico_gobierno 0,8 | La identificación oficial de un punto vulnerable justifica una prioridad alta cuando existe una capa compatible. La corrida congelada MUT omitió esa capa. |
| w_agua 1,0; nivel_agua | La clasificación visual multiplica la consecuencia por 1,0 con sin_agua (0), 1,3 con cuneta (0,3), 1,6 con hasta_vereda (0,6) y 2 con sobre_vereda (1). Los escalones distinguen la extensión visible del agua sin estimar profundidad. |
| vigencia_agua_horas 6; vigencia_urgente_horas 6 | La hora de observación y la del caso urgente limitan el efecto a seis horas porque el agua y la exposición de personas pueden cambiar dentro del día. |
| caso_radio_m 75; caso_ventana_min 60 | Las coordenadas y horas de los reportes permiten agrupar varios avisos de un incidente cercano en una hora y reducen la duplicación entre cuadras o episodios distintos. |

## Qué se validó en la zona MUT

La demo marca dias_sin_limpieza en features_simuladas. La configuración de validación también excluye camara. Al poner w_dias y w_cam en cero, los seis pesos restantes se dividen por 0,76 para conservar sus proporciones. En la corrida sobre las 46 rejillas también faltó clima. El pipeline le asignó peso efectivo cero y volvió a normalizar los cinco disponibles. Así, el peso efectivo de árboles fue 0,333333 frente al 0,289474 del archivo de validación y al 0,22 de la demo. Para reproducir el ranking hay que usar los pesos efectivos y los insumos identificados por sus hashes. [Configuración de validación](../backend/config/formula_validacion.yaml) · [Metadatos de la corrida del PR 81](https://github.com/platanus-hack/platanus-hack-26-cl-team-34/blob/datos/prediccion-congelada/data/validacion/prediccion_congelada.meta.json)
