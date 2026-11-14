# 0014. SonarCloud en el CI de los cuatro repos, y una puerta de calidad que puede frenar el despliegue

**Estado:** vigente · **Atributos:** mantenibilidad (inspección continua), seguridad

**Contexto.** El enunciado pide un escenario de mantenibilidad con inspección continua mediante análisis estático, un paso de
SonarCloud o SonarQube dentro del pipeline, y ofrece un bono de 0,5 puntos si Sonar queda en «A / verde» con al menos 40 % de
cobertura de pruebas unitarias en el front y 80 % en el backend.

**Decisión.**
- **El análisis corre en el CI** de usuarios, cursos, trivia y front (`ci.yml`), después de las pruebas, leyendo el informe de
  cobertura que ya dejaron (JaCoCo en Java, lcov de Vitest en el front). Necesita el secreto `SONAR_TOKEN` del repositorio:
  sin él el paso se omite con un aviso y el flujo no se rompe.
- **El despliegue espera al CI** (`cd.yml` corre con `workflow_run`, solo si CI terminó bien): un cambio que no compila o no
  pasa las pruebas no llega a Azure. A mano (`workflow_dispatch`) se puede desplegar igual, para una emergencia.
- **La puerta de calidad de Sonar solo frena el despliegue si se enciende** (`SONAR_ESPERAR_PUERTA=true`). Se dejó apagada hasta
  que los hallazgos pendientes estén revisados: encendida antes, bloquearía todos los despliegues.
- **Los hallazgos se arreglan o se documentan, no se silencian**: lo que es un problema real se corrige (promesas sin manejar,
  contraseña escrita en el código, acciones de GitHub sin versión fija, contenedor corriendo como root); lo que es un falso
  positivo se documenta (`docs/sonarcloud-hallazgos.md`) y se marca en SonarCloud con su justificación, por decisión del
  equipo. No se usa `NOSONAR` para callar alertas de seguridad.
- **La cobertura del front se mide con exclusiones declaradas** (páginas y componentes de presentación, listadas en
  `sonar-project.properties` y en `vitest.config.ts`, las mismas en los dos): hoy es de 76 %.

**Consecuencias.**
- (+) Cada cambio se inspecciona antes de desplegarse y el resultado queda en un tablero público, con evidencia para M1.
- (+) Las contraseñas ya no viajan en el código: se pasan por variable de entorno (`SPRING_DATASOURCE_PASSWORD`).
- (−) La nota «A» exige cero vulnerabilidades, incluso las de severidad menor: queda pendiente marcar como seguras las
  alertas de CSRF (APIs con token, sin cookies), que es una decisión del equipo.
- (−) La puerta apagada significa que, por ahora, Sonar informa pero no frena.
