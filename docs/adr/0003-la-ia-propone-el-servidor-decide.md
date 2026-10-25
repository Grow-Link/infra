# 0003. La IA propone, el servidor valida, y hay un respaldo algorítmico

**Estado:** vigente · **Atributos:** disponibilidad, seguridad

**Contexto.** El roadmap lo arma una IA (Claude). Una IA puede inventar cursos, repetirlos, desordenar prerrequisitos,
pasarse del tiempo, contestar distinto a la misma pregunta, tardar o no estar disponible. Además recibe texto que escribe
una persona.

**Decisión.**
1. La IA solo recibe el catálogo activo y devuelve ids: **lo que propone se valida** (`esPropuestaValida`, horas reales
   del catálogo) antes de guardarse.
2. Si la IA falla, devuelve algo inválido o se pasa del tiempo (tras una sola corrección), se usa un **algoritmo de
   respaldo** determinista (puntuación por palabras + prerrequisitos + orden topológico).
3. Si la IA dice que la meta no es viable, **no** se cae al respaldo: se le explica a la persona (422).
4. La meta va entre etiquetas `<meta>` como dato, nunca como instrucción.
5. El roadmap guarda quién lo armó (`generadoPor`) y la pantalla lo dice.

**Consecuencias.**
- (+) El sistema siempre devuelve una ruta válida o un mensaje claro; nunca una ruta inventada.
- (+) Se puede probar y demostrar sin llave de IA.
- (−) El respaldo compara texto, no significado: es más pobre que la IA.
- (−) Cada validación extra es código que mantener (ver `docs/arquitectura-roadmap-catalogo-publicador.md`).
