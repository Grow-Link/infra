# 0004. Se guardan las propuestas validadas de la IA, con una clave que incluye el catálogo

**Estado:** vigente · **Atributos:** rendimiento, costo

**Contexto.** Medido con la IA real y sin caché, 5 llamadas idénticas dieron 4 rutas distintas, y cada una cuesta dinero y
segundos. El parámetro `temperature` que antes servía para fijar la respuesta ya no existe en los modelos nuevos
(responden 400).

**Decisión.** Se guarda la propuesta de la IA **después de validarla**, con una clave (SHA-256) de todo lo que influye en
la respuesta: meta normalizada, áreas, nivel, tope de horas, versión del prompt y el catálogo disponible completo. Solo
se guarda lo que salió de la IA (no lo del respaldo). Peticiones idénticas simultáneas comparten un candado por clave
para que cuesten una sola llamada.

**Consecuencias.**
- (+) La misma entrada da siempre la misma ruta, al instante y sin costo; si un curso cambia, la clave cambia y se
  vuelve a preguntar.
- (−) La tabla crece (una fila por combinación) y no caduca; subir la versión del prompt invalida todo lo guardado.
- (−) El candado es por réplica; entre réplicas lo cubre la restricción de unicidad de la base.
