#!/usr/bin/env bash
# Levanta GrowLink completo con todas sus replicas.
#
# Por que no basta con "docker compose up": cada servicio, al arrancar sobre una base vacia, crea las
# tablas y mete los datos de prueba solo si todavia no hay nada. Si 3 replicas arrancan exactamente
# al mismo tiempo, las 3 ven la base vacia y los datos de prueba se duplican. Por eso aqui primero
# arranca UNA replica de cada servicio, se espera a que respondan, y despues se suben las demas.
#
#   cp .env.example .env
#   ./scripts/levantar.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Falta el archivo .env, copia el .env.example: cp .env.example .env" >&2
  exit 1
fi
# la llave de Claude se puede poner en el .env o como variable de entorno de tu terminal; si el
# .env la trae vacia, no se debe borrar la que ya estaba en el entorno
LLAVE_DEL_ENTORNO="${CLAUDE_API_KEY:-}"
set -a; source .env; set +a
if [[ -z "${CLAUDE_API_KEY:-}" && -n "$LLAVE_DEL_ENTORNO" ]]; then
  export CLAUDE_API_KEY="$LLAVE_DEL_ENTORNO"
fi
if [[ -n "${CLAUDE_API_KEY:-}" ]]; then
  echo "IA: ACTIVADA (se encontro CLAUDE_API_KEY, el roadmap se genera con Claude)"
else
  echo "IA: SIN LLAVE (CLAUDE_API_KEY vacia, el roadmap sale en modo de respaldo sin IA)"
fi

# cifrado entre el front y los servicios (S3): todas las replicas tienen que usar la MISMA llave privada, si no una
# peticion cifrada para una replica no la entiende otra. Si el .env no la trae, se crea una y se guarda ahi.
if [[ -z "${GROWLINK_CIFRADO_CLAVE_PRIVADA:-}" ]]; then
  LLAVE_NUEVA=""
  # openssl puede estar y aun asi fallar (p. ej. el de Git Bash en Windows sin su configuracion): con "set -e" eso
  # tumbaria el script, por eso cada intento tolera el fallo y el siguiente solo corre si el anterior no dio nada
  if command -v openssl >/dev/null 2>&1; then
    LLAVE_NUEVA=$(openssl genpkey -algorithm RSA -pkeyopt rsa_key_bits:2048 2>/dev/null | openssl pkcs8 -topk8 -nocrypt -outform DER 2>/dev/null | base64 | tr -d '\n' || true)
  fi
  if [[ -z "$LLAVE_NUEVA" ]] && command -v node >/dev/null 2>&1; then
    LLAVE_NUEVA=$(node -e "const c=require('crypto');process.stdout.write(c.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'der'},publicKeyEncoding:{type:'spki',format:'der'}}).privateKey.toString('base64'))" || true)
  fi
  if [[ -n "$LLAVE_NUEVA" ]]; then
    printf '\nGROWLINK_CIFRADO_CLAVE_PRIVADA=%s\n' "$LLAVE_NUEVA" >> .env
    export GROWLINK_CIFRADO_CLAVE_PRIVADA="$LLAVE_NUEVA"
    echo "Cifrado: se creo la llave compartida de las replicas y se guardo en .env"
  else
    echo "Cifrado: no se pudo crear la llave (hace falta openssl o node), cada replica usaria una distinta" >&2
  fi
fi

URL="${URL:-http://localhost:3000}"
USUARIOS="${USUARIOS_REPLICAS:-2}"
CURSOS="${CURSOS_REPLICAS:-2}"
TRIVIA="${TRIVIA_REPLICAS:-3}"

# espera a que algo responda por el nginx, cualquier respuesta que no sea un error del propio nginx
esperar() { # nombre, ruta
  local intento codigo
  for intento in $(seq 60); do
    codigo=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$URL$2" || true)
    if [[ "$codigo" =~ ^[234][0-9][0-9]$ ]]; then
      echo "  $1 listo"
      return 0
    fi
    sleep 3
  done
  echo "  $1 no respondio a tiempo, mira: docker compose logs $1" >&2
  return 1
}

echo "1) Primer arranque, una replica de cada servicio"
docker compose up -d --build --scale usuarios-service=1 --scale cursos-service=1 --scale trivia-service=1
# usuarios y cursos se esperan por su sonda de readiness: da 503 mientras arrancan y SOLO da 200 cuando ya terminaron
# de crear los datos de prueba (Spring la marca lista despues de los CommandLineRunner) y la base de datos responde.
# Antes se esperaba a que contestara cualquier ruta, que ya contesta antes de terminar de sembrar.
# trivia no tiene todavia esa sonda, por eso sigue esperando una ruta cualquiera.
esperar usuarios-service /api-usuarios/actuator/health/readiness
esperar cursos-service /api-cursos/actuator/health/readiness
esperar trivia-service /api-trivia/api/salas/NOEXISTE

echo "2) Subiendo replicas: usuarios=$USUARIOS cursos=$CURSOS trivia=$TRIVIA"
docker compose up -d --no-recreate --scale usuarios-service="$USUARIOS" --scale cursos-service="$CURSOS" --scale trivia-service="$TRIVIA"

echo
echo "Listo. Abre $URL"
echo "Panel de RabbitMQ: http://localhost:15672 (usuario growlink)"
echo "Para ver el balanceo y la tolerancia a fallos: ./scripts/prueba-de-fuego.sh"
