# 0005. Un roadmap nuevo no vuelve a ofrecer lo que la persona ya completó

**Estado:** vigente · **Atributos:** integridad del jardín (reglas de negocio)

**Contexto.** Los exámenes de cualquier curso del catálogo se pueden presentar sin tener roadmap. El jardín da una semilla
por roadmap completado. Si un roadmap nuevo pudiera incluir cursos ya aprobados, se podría "ganar" semillas repitiendo
trabajo ya hecho.

**Decisión.** Al generar un roadmap, el catálogo que ven la IA y el respaldo excluye lo que la persona ya completó
(`RoadmapService.sinCompletados`). Un prerrequisito ya completado simplemente no existe para quien arma la ruta, así que
no bloquea al curso que lo necesitaba. Un roadmap solo cuenta como completado para el jardín si todos sus cursos se
completaron **después** de crearlo y ninguno ya pagó otra semilla (`RoadmapService.completados`).

**Consecuencias.**
- (+) No hay semillas por trabajo repetido, y el tiempo de la persona no se gasta en lo que ya sabe.
- (+) Si ya completó todo lo de un área, se le dice con un mensaje propio (422).
- (−) Lo aprobado antes no aparece dentro de la ruta; por eso la pantalla lo dice en «¿Por qué esta ruta?» y la ficha del
  curso avisa antes de presentar el examen. Sigue en el historial. (Se descartó meterlo como "hecho" dentro de la ruta:
  esa ruta nunca podría dar semilla.)
- Los exámenes sin roadmap se siguen permitiendo a propósito: el catálogo es navegable y esta regla ya cubre ese caso.
