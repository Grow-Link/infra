# 0012. Un cortacircuito delante de la IA que arma los roadmaps

**Estado:** vigente (cursos-service, en `main`) · **Atributos:** disponibilidad (tolerancia a fallos), costo

**Contexto.** El roadmap lo propone una IA externa (0003: la IA propone, el servidor valida, y hay un respaldo algorítmico).
Si la IA se cae, se demora o contesta cualquier cosa, seguir preguntándole petición tras petición le cuesta tiempo a quien
espera y dinero a la cuenta, y no arregla nada: el respaldo existe justamente para ese caso.

**Decisión.** Un cortacircuito (`CortacircuitoDeLaIa`, con Resilience4j) delante de la llamada a la IA:
- **Se abre tras 3 fallos seguidos** (`roadmap.ia.cortacircuito.fallos`). Cuenta como fallo que la llamada reviente, que tarde
  más de 10 s (`demora-segundos`), o que conteste algo que no sirve (no pasa la validación contra el catálogo real).
- **Abierto, no llama a la IA durante 60 s** (`espera-segundos`) y responde con el algoritmo de respaldo, que no sale a internet.
- **Al cumplirse ese tiempo deja pasar una sola petición de prueba**: si funciona, se cierra; si falla, otros 60 s.
- **Cada réplica tiene el suyo**, sin estado compartido (0002), igual que el tope de generaciones.
- **Se usa la API a mano** (permiso y reporte) y no la anotación, porque el resultado de una llamada no se conoce cuando
  termina: una respuesta puede llegar sin error y descubrirse inválida después, al validarla.
- **El estado queda a la vista** como métrica (`/actuator/metrics`, solo ADMIN) y el origen de cada roadmap (IA o respaldo) se
  cuenta, así que «la IA está apagada» se ve en el tablero de negocio.

**Consecuencias.**
- (+) Con la IA caída, el roadmap sale igual y rápido (sin esperar 10 s por intento): se muestra en D2 quitando la llave de la IA.
- (+) La cuenta de la IA no se gasta en intentos que se sabe que fallan.
- (−) Con N réplicas, cada una necesita sus propios 3 fallos para abrirse.
- (−) El respaldo arma roadmaps menos personalizados que la IA: es el precio de seguir funcionando.
