# 0001. Tres servicios, cada uno con su propia base de datos

**Estado:** vigente · **Atributos:** modificabilidad, escalabilidad

**Contexto.** El proyecto lo desarrolla un equipo en paralelo (usuarios, cursos y trivia en tiempo real). Con un solo
proyecto y una sola base, cada cambio de esquema o de lógica obligaba a coordinarse con todos, y la trivia (WebSocket,
mucha concurrencia) tiene necesidades de escalado distintas a las del catálogo.

**Decisión.** Tres servicios (`usuarios-service`, `cursos-service`, `trivia-service`), cada uno dueño de sus datos y sin
acceder a la base de los otros. Solo se hablan por HTTP.

**Consecuencias.**
- (+) Cada persona del equipo trabaja y despliega su servicio sin pisar a las demás; cada servicio se escala solo.
- (+) Un fallo en uno no tumba a los otros si se manejan bien las llamadas entre ellos (ver 0006).
- (−) No hay llaves foráneas entre servicios: `Roadmap.usuarioId` es un número que apunta a otra base y nadie lo valida
  por nosotros. Se compensa validando la identidad con el JWT (`exigirPropio`).
- (−) Los datos de una pantalla pueden salir de varios servicios: el front los une (por ejemplo, el perfil sale de usuarios
  y se manda a cursos al pedir el roadmap).
