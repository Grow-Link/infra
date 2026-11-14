# 0008. El front cifra lo que manda y los servicios lo descifran, encima de HTTPS

**Estado:** vigente (usuarios, cursos, trivia y front, en `main`) · **Atributos:** seguridad (confidencialidad)

**Contexto.** HTTPS ya protege el canal entre el navegador y Azure, pero el profesor pidió que la información viaje cifrada
de extremo a extremo entre el front y el backend: el front cifra, el backend descifra, responde cifrado y el front lo
descifra. Era un requisito explícito y también una defensa en profundidad: si el tráfico se descifrara en algún punto
intermedio (un proxy, un balanceador), el cuerpo seguiría siendo ilegible.

**Decisión.**
- **Una llave por petición.** El front crea una llave AES-256-GCM nueva para cada petición, cifra el cuerpo con ella (IV de
  12 bytes al frente) y la manda envuelta con la **llave pública RSA del servicio** (RSA-OAEP con SHA-256) en la
  cabecera `X-GL-Clave`. El servicio la desenvuelve con su llave privada, descifra, responde y cifra la respuesta con la
  **misma** llave AES (otro IV). Todo con Web Crypto del navegador y la JCE de Java, sin librerías.
- **La llave pública se pide una vez** (`GET /api/seguridad/clave-publica`, sin sesión) y se recuerda. La **privada** vive solo
  en la configuración de los servicios (`GROWLINK_CIFRADO_CLAVE_PRIVADA`) y es **la misma en todas las instancias**:
  si cada una tuviera la suya, una petición cifrada para una instancia no la entendería otra (con el balanceador de
  trivia, eso pasaría a diario).
- **Un solo punto de salida en el front** (`send`, en `backendSession.ts`) y **un filtro en cada servicio**
  (`CifradoFilter`, justo antes de Spring Security): los controladores y las pantallas no cambian.
- **No es obligatorio** (`GROWLINK_CIFRADO_OBLIGATORIO=false`). Las llamadas entre servicios, Prometheus y Azure no cifran,
  y exigirlo las rompería. El front cifra siempre; si no puede (el servicio no tiene la llave pública, el navegador no tiene
  Web Crypto, el cuerpo no es texto) la petición sale como antes.

**Consecuencias.**
- (+) Lo que se ve en el canal es ilegible, incluso en las herramientas del navegador: es la evidencia del escenario S3.
- (+) Una petición alterada se rechaza (la etiqueta de GCM lo detecta) y queda contada y en el log.
- (−) **No protege del navegador comprometido ni de quien tenga la llave privada**, y no reemplaza a HTTPS: lo complementa.
- (−) **El WebSocket de la trivia no lleva este cifrado extra**, solo `wss`. Es el límite honesto de esta versión.
- (−) Las llamadas servicio a servicio dentro de Azure van sin este cifrado (solo HTTPS).
- (−) Cada petición cuesta una operación RSA en el front y otra en el servicio; con los volúmenes de este proyecto no se nota.
