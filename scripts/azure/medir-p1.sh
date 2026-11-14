#!/usr/bin/env bash
# Mide el escenario P1 (muchos jugadores respondiendo a la vez) EN AZURE, con 1 copia de trivia y con las 3, pasando por el
# balanceador del front. Cada medicion da p50, p95 y p99 de la respuesta, del reparto de cada pregunta y de unirse, y los errores.
#
#   az login                                     (con una cuenta que pueda cambiar el grupo rg-growlink)
#   ./scripts/azure/medir-p1.sh                  las dos mediciones, de principio a fin (unos 25 a 35 minutos)
#   ./scripts/azure/medir-p1.sh restaurar        solo deja todo como estaba (si algo se interrumpio)
#
# Variables opcionales: ETAPAS (jugadores a la vez en cada etapa, por defecto 10,25,50,75,100), POR_SALA (10), PREGUNTAS (10).
# Hace falta Node 22 o mas nuevo y los repos clonados como pide el README (este script esta en infra/scripts/azure).
#
# QUE CAMBIA EN AZURE MIENTRAS CORRE (y se deshace solo al terminar, aunque falle o se pare con Ctrl+C):
#   - Las tres copias de trivia pasan a AUTH_MODE=legacy. Los jugadores de mentira de la prueba no tienen cuenta de Microsoft,
#     y con el login de Microsoft no hay forma de sacar tokens para cien personas. Mientras tanto, NADIE puede jugar trivia con
#     su cuenta de Microsoft: no correrlo cuando alguien este probando la app ni durante la demo.
#   - Para medir "1 copia" se le dice al front que mande todo a la copia A (TRIVIA_URL_2 y TRIVIA_URL_3 = TRIVIA_URL), asi las
#     dos mediciones pasan por el mismo nginx y solo cambia cuantas copias hay detras.
# Cada cambio reinicia una app (1 a 3 minutos). Las partidas de mentira quedan en la base de datos (cuentan en los tableros de
# negocio); el resultado de cada medicion se guarda en infra/scripts/carga/resultados/ (esa carpeta no se sube a git).
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."                       # infra
RG="${RG:-rg-growlink}"
FRONT_APP="${FRONT_APP:-growlink-front}"
TRIVIA_APPS=(growlink-trivia growlink-trivia-b growlink-trivia-c)
FRONT_HOST="$(az webapp show -g "$RG" -n "$FRONT_APP" --query defaultHostName -o tsv)"
FRONT="https://$FRONT_HOST"
FECHA="$(date +%Y-%m-%dT%H-%M-%S)"

ajuste_del_front() { az webapp config appsettings list -g "$RG" -n "$FRONT_APP" --query "[?name=='$1'].value | [0]" -o tsv; }
URL1="$(ajuste_del_front TRIVIA_URL)"; URL2="$(ajuste_del_front TRIVIA_URL_2)"; URL3="$(ajuste_del_front TRIVIA_URL_3)"
[[ -n "$URL1" && -n "$URL2" && -n "$URL3" ]] || { echo "El front no tiene TRIVIA_URL, TRIVIA_URL_2 y TRIVIA_URL_3: no hay tres copias que medir" >&2; exit 1; }

esperar_trivia() { # espera a que las tres copias contesten su salud
  local app host i
  for app in "${TRIVIA_APPS[@]}"; do
    host="$(az webapp show -g "$RG" -n "$app" --query defaultHostName -o tsv)"
    for i in $(seq 90); do
      [[ "$(curl -s -m 15 -o /dev/null -w '%{http_code}' "https://$host/actuator/health/readiness" || true)" == "200" ]] && break
      sleep 10
    done
    echo "   $app lista"
  done
}
esperar_front() {
  local i
  for i in $(seq 90); do
    [[ "$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$FRONT/" || true)" == "200" ]] && return 0
    sleep 10
  done
  echo "   el front no contesta" >&2; return 1
}
modo_de_trivia() { # legacy | oidc
  local app
  for app in "${TRIVIA_APPS[@]}"; do az webapp config appsettings set -g "$RG" -n "$app" --settings "AUTH_MODE=$1" -o none; done
  echo "   AUTH_MODE=$1 en las tres copias; esperando a que reinicien"
  sleep 60
  esperar_trivia
}
urls_del_front() { # TRIVIA_URL_2 y TRIVIA_URL_3
  az webapp config appsettings set -g "$RG" -n "$FRONT_APP" --settings "TRIVIA_URL_2=$1" "TRIVIA_URL_3=$2" -o none
  echo "   front reiniciando con otras copias de trivia"
  sleep 45
  esperar_front
  sleep 15
}
restaurar() {
  trap - EXIT INT TERM
  echo "== Dejando Azure como estaba (oidc y las tres copias en el front)"
  urls_del_front "$URL2" "$URL3" || echo "   AVISO: revisar a mano TRIVIA_URL_2 y TRIVIA_URL_3 del front" >&2
  modo_de_trivia oidc || echo "   AVISO: revisar a mano AUTH_MODE=oidc en las tres copias de trivia" >&2
  echo "== Listo, restaurado"
}

if [[ "${1:-}" == "restaurar" ]]; then restaurar; exit 0; fi

command -v node >/dev/null || { echo "Hace falta Node 22 o mas nuevo" >&2; exit 1; }
[[ -d scripts/carga/node_modules ]] || (cd scripts/carga && npm ci --no-audit --no-fund)
mkdir -p scripts/carga/resultados

trap restaurar EXIT INT TERM

medir() { # nombre
  echo "== Midiendo: $1"
  (cd scripts/carga && \
    ETAPAS="${ETAPAS:-10,25,50,75,100}" POR_SALA="${POR_SALA:-10}" PREGUNTAS="${PREGUNTAS:-10}" \
    URL_TRIVIA="$FRONT/api-trivia" WS_TRIVIA="wss://$FRONT_HOST/ws-trivia" \
    SALIDA="resultados/p1-$1-$FECHA.json" node carga-trivia.mjs) | tee "scripts/carga/resultados/p1-$1-$FECHA.txt"
}

echo "== 1) Las tres copias de trivia a modo legacy (se reinician)"
modo_de_trivia legacy

echo "== 2) Medicion con UNA copia (el front manda todo a la copia A)"
urls_del_front "$URL1" "$URL1"
medir 1-copia

echo "== 3) Medicion con las TRES copias (balanceador completo)"
urls_del_front "$URL2" "$URL3"
medir 3-copias

echo
echo "Resultados guardados en infra/scripts/carga/resultados/ (p1-1-copia-* y p1-3-copias-*, .txt para leerlos y .json con todo)."
echo "Mientras corria, el tablero 'Tecnico por instancia' de Grafana mostro la carga por copia: conviene tomarle capturas."
