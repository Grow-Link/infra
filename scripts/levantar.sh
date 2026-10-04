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
set -a; source .env; set +a

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
esperar usuarios-service /api-usuarios/api/auth/usuarios
esperar cursos-service /api-cursos/api/habilidades
esperar trivia-service /api-trivia/api/salas/NOEXISTE

echo "2) Subiendo replicas: usuarios=$USUARIOS cursos=$CURSOS trivia=$TRIVIA"
docker compose up -d --no-recreate --scale usuarios-service="$USUARIOS" --scale cursos-service="$CURSOS" --scale trivia-service="$TRIVIA"

echo
echo "Listo. Abre $URL"
echo "Panel de RabbitMQ: http://localhost:15672 (usuario growlink)"
echo "Para ver el balanceo y la tolerancia a fallos: ./scripts/prueba-de-fuego.sh"
