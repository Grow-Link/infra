#!/usr/bin/env bash
# Prueba de fuego: balanceo y tolerancia a fallos.
#
# Para cada servicio:
#   1. manda varias peticiones y cuenta que replica atendio cada una (header X-Instancia)
#   2. mata una replica a la fuerza (docker kill) y vuelve a mandar peticiones
#   3. revisa que ninguna peticion haya fallado, nginx tiene que mandarlas a las replicas vivas
#   4. vuelve a levantar la replica que se cayo
#
# Se corre con todo levantado (./scripts/levantar.sh).
set -uo pipefail
cd "$(dirname "$0")/.."

URL="${URL:-http://localhost:3000}"
PETICIONES="${PETICIONES:-30}"
if [[ -f .env ]]; then set -a; source .env; set +a; fi

# servicio:ruta que existe aunque no haya sesion (el estado no importa, solo que lo atienda alguien)
SERVICIOS=(
  "usuarios-service:/api-usuarios/api/auth/usuarios:${USUARIOS_REPLICAS:-2}"
  "cursos-service:/api-cursos/api/habilidades:${CURSOS_REPLICAS:-2}"
  "trivia-service:/api-trivia/api/salas/NOEXISTE:${TRIVIA_REPLICAS:-3}"
)

FALLOS_TOTALES=0

# manda las peticiones, imprime cuantas atendio cada replica y devuelve cuantas fallaron
repartir() { # ruta
  local fallos=0 i cabeceras estado instancia
  local lista
  lista=$(mktemp)
  for i in $(seq "$PETICIONES"); do
    cabeceras=$(curl -s -m 5 -o /dev/null -D - "$URL$1" | tr -d '\r' || true)
    estado=$(printf '%s' "$cabeceras" | head -1 | awk '{print $2}')
    instancia=$(printf '%s' "$cabeceras" | grep -i '^x-instancia:' | awk '{print $2}')
    # 2xx, 3xx y 4xx cuentan como atendida, 5xx o nada es una falla
    if [[ ! "$estado" =~ ^[234][0-9][0-9]$ ]]; then
      fallos=$((fallos + 1))
      echo "sin-respuesta" >> "$lista"
    else
      echo "${instancia:-sin-header}" >> "$lista"
    fi
  done
  sort "$lista" | uniq -c | awk '{printf "    %s peticiones -> %s\n", $1, $2}'
  rm -f "$lista"
  echo "    fallas: $fallos de $PETICIONES"
  return "$fallos"
}

for entrada in "${SERVICIOS[@]}"; do
  IFS=: read -r servicio ruta replicas <<< "$entrada"
  echo "=== $servicio ($replicas replicas)"

  echo "  Antes de tumbar nada:"
  repartir "$ruta"

  caido=$(docker compose ps -q "$servicio" | head -1)
  if [[ -z "$caido" ]]; then
    echo "  No encontre ninguna replica de $servicio, esta levantado el compose?" >&2
    exit 1
  fi
  echo "  Matando una replica a la fuerza (${caido:0:12})"
  docker kill "$caido" > /dev/null

  echo "  Con una replica menos:"
  repartir "$ruta"
  fallos=$?
  FALLOS_TOTALES=$((FALLOS_TOTALES + fallos))

  echo "  Levantando la replica de nuevo"
  docker compose up -d --no-recreate --scale "$servicio=$replicas" > /dev/null 2>&1
  sleep 15
  echo "  Despues de recuperarse:"
  repartir "$ruta" > /dev/null
  echo
done

if [[ "$FALLOS_TOTALES" -eq 0 ]]; then
  echo "RESULTADO: ninguna peticion fallo mientras se caia una replica de cada servicio."
else
  echo "RESULTADO: $FALLOS_TOTALES peticiones fallaron mientras se caian replicas." >&2
  exit 1
fi
