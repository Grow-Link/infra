# 0007. La identidad la pone Microsoft Entra ID; el rol lo pone GrowLink

**Estado:** vigente (usuarios-service; cursos-service y trivia-service resuelven la identidad con `GET /api/usuarios/me`) ·
**Atributos:** seguridad, interoperabilidad, modificabilidad

**Contexto.** El login era de demostración: se elegía un usuario sembrado, sin contraseña (lo pendiente de 0002). Para
abrirlo a personas reales hacía falta saber quién entra sin guardar contraseñas propias. La app quedó registrada en
Microsoft Entra ID como **multi-tenant** (cuentas de cualquier directorio organizacional y cuentas personales de
Microsoft), y eso trae tres problemas: el `iss` del token cambia según el tenant de quien entra, así que no se puede
comparar con un valor fijo; el `sub` de Entra es un texto opaco, no el `usuarioId` numérico con el que están hechas las
tablas de los tres servicios; y el rol (USUARIO, PUBLICADOR, ADMIN) es un asunto de GrowLink, no de Microsoft.

**Decisión.**
- **Un interruptor, `AUTH_MODE`**, igual en los tres servicios: `legacy` (por defecto, el login de demostración) u
  `oidc`. Un valor mal escrito **no deja arrancar**: caer callado a `legacy` sería desplegar con el login viejo creyendo
  que ya está el de Microsoft.
- **Verificación del token en usuarios-service** (`OidcTokenVerificador`, `JwksKeyLocator`): solo RS256, `kid` y `exp`
  obligatorios, emisor y audiencia (`AUTH_AUDIENCE` acepta una lista: `api://<client-id>` o el `<client-id>` pelado).
  Las llaves se bajan del JWKS del emisor y se guardan; un `kid` desconocido recarga el JWKS como mucho una vez por
  minuto, para que un `kid` inventado no sirva para golpear al emisor.
- **Multi-tenant sin aflojar la validación** (`ValidadorDeEmisor`, `AUTH_MULTI_TENANT=true`): el `iss` tiene que encajar
  entero en `https://login.microsoftonline.com/<guid>/v2.0`, el claim `tid` tiene que ser ese mismo GUID y, si
  `AUTH_ALLOWED_TENANTS` trae algo, estar en la lista (un GUID mal escrito ahí no deja arrancar).
- **El usuario local se reconoce por el `sub`**, no por el correo (columna única `proveedor_sub`): el correo se puede
  cambiar y el de una cuenta borrada se le puede dar a otra persona. Se crea en el primer ingreso; si varias peticiones
  del primer ingreso llegan a la vez, la restricción única decide y las demás leen el que quedó (`UsuarioLocalCreador`).
- **El rol es de GrowLink.** Se arranca como USUARIO con `rolElegido=false`; la persona escoge USUARIO o PUBLICADOR
  (`PUT /api/usuarios/me/rol`) y puede cambiar. ADMIN no se escoge: lo da la lista `AUTH_ADMIN_EMAILS`, que se revisa en
  cada ingreso; pedirlo sin estar en la lista da 403 y queda contado (ver 0011).
- **usuarios-service es el dueño de la identidad.** cursos-service y trivia-service no traducen el token por su cuenta:
  le preguntan `GET /api/usuarios/me` reenviando el mismo token y reciben `usuarioId` y `rol`. cursos-service guarda la
  respuesta 60 s (`AUTH_IDENTITY_CACHE_SECONDS`) para no preguntar en cada petición.
- **Nada hacia adentro cambia:** el filtro de cada modo deja lo mismo en el contexto de seguridad (el id numérico y
  `ROLE_<rol>`), así que ningún controlador sabe con qué modo entró la persona.

**Consecuencias.**
- (+) GrowLink no guarda contraseñas; la recuperación de cuenta, el segundo factor y el bloqueo por intentos son de
  Microsoft.
- (+) Una rotación de llaves de Microsoft no obliga a redesplegar: se lee del JWKS.
- (+) El modo `legacy` sigue sirviendo para la demostración y para las pruebas, sin depender de Microsoft.
- (−) usuarios-service queda en el camino de las peticiones de los otros dos servicios: si se cae, cursos-service
  responde 503 cuando se le vence la identidad guardada (nunca acepta el token "a medias" ni lee el rol del token).
- (−) Un cambio de rol tarda hasta 60 s en verse en cursos-service.
- (−) Cualquiera con una cuenta de Microsoft puede entrar como USUARIO y escogerse PUBLICADOR: es la decisión de
  producto. Si hiciera falta cerrarlo, `AUTH_ALLOWED_TENANTS` limita las organizaciones.
- (−) Quitar un correo de `AUTH_ADMIN_EMAILS` no le baja el rol a esa persona (se hace a mano en la base), para no
  quedarse sin administradores por una variable mal copiada en un despliegue.
- (−) Dos modos que mantener hasta que se retire `legacy`.
