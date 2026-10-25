# 0002. La sesión es un JWT firmado y los servicios no guardan estado

**Estado:** vigente · **Atributos:** escalabilidad, disponibilidad

**Contexto.** Para repartir la carga hacen falta varias réplicas por servicio. Si una réplica guardara la sesión (o el
estado de una partida) en su memoria, la siguiente petición de la misma persona podría caer en otra réplica que no la
conoce, y una réplica caída se llevaría esa información.

**Decisión.** `usuarios-service` emite un JWT firmado (usuario y rol) y los demás servicios lo validan con el mismo
secreto compartido (`GROWLINK_JWT_SECRET`). Nada de la sesión vive en memoria; el estado de las salas, las partidas y los
roadmaps está en la base de datos, y los candados que protegen la concurrencia son de la base (`UPDATE` atómico, bloqueo
de fila), no de la memoria del proceso.

**Consecuencias.**
- (+) Cualquier réplica atiende cualquier petición; se suben o bajan réplicas sin migrar sesiones.
- (+) Una réplica que cae no pierde nada de las personas.
- (−) Un secreto compartido: hay que ponerlo igual en los tres servicios y protegerlo. Un token no se puede "cerrar" antes
  de que venza (dura 24 h por defecto).
- (−) Solo se puede usar lo que sirva en cualquier réplica: por eso el límite de uso de la IA cuenta por réplica (ver
  `LimiteDeGeneraciones`) en lugar de compartir un contador.
- Pendiente: el login es de demostración (se elige un usuario sembrado, sin contraseña).
