#!/usr/bin/env bash
# Prueba D1 con gente conectada: juega partidas de mentira por el balanceador del front y, en pleno juego, APAGA una copia de trivia
# (growlink-trivia-d). Comprueba que a quienes estaban en esa copia no los saca el servidor de su sala: se reconectan solos y terminan.
#
#   az login
#   ./scripts/azure/probar-falla-de-copia.sh              unos 15 a 20 minutos
#   ./scripts/azure/probar-falla-de-copia.sh restaurar    solo deja todo como estaba (si algo se interrumpio)
#
# QUE CAMBIA EN AZURE MIENTRAS CORRE (y se deshace solo al terminar, aunque falle o se pare con Ctrl+C):
#   - Las tres copias de trivia pasan a AUTH_MODE=legacy (los jugadores de mentira no tienen cuenta de Microsoft). Mientras tanto NADIE
#     puede jugar trivia con su cuenta de Microsoft, y las copias aceptan conexiones sin token: no correrlo cuando alguien este probando
#     ni durante la demo.
#   - Se apaga growlink-trivia-d en pleno juego y al final se vuelve a encender.
# Variables opcionales: JUGADORES (12), POR_SALA (4), PREGUNTAS (10), DURACION (15), PREGUNTA_FALLA (3), COPIA_A_APAGAR (growlink-trivia-d).
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."                       # infra
RG="${RG:-rg-growlink}"
FRONT_APP="${FRONT_APP:-growlink-front}"
APAGAR="${COPIA_A_APAGAR:-growlink-trivia-d}"
TRIVIA_APPS=(growlink-trivia growlink-trivia-d growlink-trivia-c)
FRONT_HOST="$(az webapp show -g "$RG" -n "$FRONT_APP" --query defaultHostName -o tsv)"
FRONT="https://$FRONT_HOST"
FECHA="$(date +%Y-%m-%dT%H-%M-%S)"

esperar_trivia() {
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
modo_de_trivia() { # legacy | oidc
  local app
  for app in "${TRIVIA_APPS[@]}"; do az webapp config appsettings set -g "$RG" -n "$app" --settings "AUTH_MODE=$1" -o none; done
  echo "   AUTH_MODE=$1 en las tres copias; esperando a que reinicien"
  sleep 60
  esperar_trivia
}
restaurar() {
  trap - EXIT INT TERM
  echo "== Dejando Azure como estaba (copia encendida y AUTH_MODE=oidc)"
  az webapp start -g "$RG" -n "$APAGAR" -o none || echo "   AVISO: encender $APAGAR a mano" >&2
  modo_de_trivia oidc || echo "   AVISO: revisar a mano AUTH_MODE=oidc en las tres copias de trivia" >&2
  echo "== Listo, restaurado"
}

if [[ "${1:-}" == "restaurar" ]]; then restaurar; exit 0; fi

command -v node >/dev/null || { echo "Hace falta Node 22 o mas nuevo" >&2; exit 1; }
[[ -d scripts/carga/node_modules ]] || (cd scripts/carga && npm ci --no-audit --no-fund)
mkdir -p scripts/carga/resultados
trap restaurar EXIT INT TERM

echo "== 1) Las tres copias de trivia a modo legacy (se reinician)"
modo_de_trivia legacy

echo "== 2) Partidas de mentira con falla de $APAGAR en pleno juego"
set +e
(cd scripts/carga && \
  URL_TRIVIA="$FRONT/api-trivia" WS_TRIVIA="wss://$FRONT_HOST/ws-trivia" \
  COMANDO_FALLA="az webapp stop -g $RG -n $APAGAR" \
  node falla-de-copia.mjs) | tee "scripts/carga/resultados/falla-de-copia-$FECHA.txt"
codigo=${PIPESTATUS[0]}
set -e
echo "Resultado guardado en infra/scripts/carga/resultados/falla-de-copia-$FECHA.txt (codigo $codigo)"
exit "$codigo"
