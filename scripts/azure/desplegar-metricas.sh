#!/usr/bin/env bash
# Pone en AZURE el Prometheus y el Grafana de los tableros (escenarios de observabilidad), sin Docker en ninguna maquina de
# nadie: dos contenedores en Azure Container Instances que leen su configuracion de ESTE repo (rama main) y los mismos
# tableros JSON que el docker compose.
#
#   az login                                     (una vez)
#   ./scripts/azure/desplegar-metricas.sh
#
# Que hace:
#   1. Le pone a usuarios, cursos y las tres copias de trivia el METRICAS_TOKEN (el mismo en las cinco). Si usuarios ya tiene
#      uno, lo reutiliza. Con ese token Prometheus lee /actuator/prometheus; sin el, 401.
#   2. Crea el contenedor de Prometheus (raspa las cinco apps, ver observabilidad/azure/prometheus.yml).
#   3. Crea el contenedor de Grafana (tableros de negocio, tecnico por instancia y seguridad, ver observabilidad/azure).
# Volver a correrlo recrea los dos contenedores (asi toman los cambios del repo: clonan main al arrancar).
#
# Los secretos (METRICAS_TOKEN y la clave de admin de Grafana) se generan aqui y NO se escriben en ningun archivo ni se
# muestran. Para entrar a Grafana como admin, pasar la clave: GRAFANA_ADMIN_PASSWORD=... ./scripts/azure/desplegar-metricas.sh
# (sin ella se crea una al azar y nadie la sabe: los tableros se ven igual, sin iniciar sesion, y solo se editan desde el repo).
#
# Avisos: los dos contenedores quedan con direccion publica y sin HTTPS (Container Instances no pone certificado). Prometheus
# solo muestra metricas de uso (no datos de personas) y Grafana deja ver los tableros sin sesion, solo lectura. Para una demo
# esta bien; para produccion habria que ponerlos detras de HTTPS y de autenticacion. Cuestan unos pocos dolares por dia.
set -euo pipefail
# Git Bash convierte rutas como /mnt/infra en rutas de Windows al llamar a az; con esto no
export MSYS_NO_PATHCONV=1

RG="${RG:-rg-growlink}"
REGION="${REGION:-canadacentral}"
REPO="${REPO:-https://github.com/Grow-Link/infra}"
RAMA="${RAMA:-main}"
APPS=(growlink-usuarios growlink-cursos growlink-trivia growlink-trivia-b growlink-trivia-c)
PROM_ETIQUETA="${PROM_ETIQUETA:-growlink-prometheus-ca}"
GRAFANA_ETIQUETA="${GRAFANA_ETIQUETA:-growlink-grafana-ca}"

secreto() { # un valor al azar de $1 bytes, en hexadecimal
  if command -v node >/dev/null 2>&1; then node -e "process.stdout.write(require('crypto').randomBytes($1).toString('hex'))"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

echo "1) METRICAS_TOKEN en las cinco apps"
TOKEN="$(az webapp config appsettings list -g "$RG" -n growlink-usuarios --query "[?name=='METRICAS_TOKEN'].value | [0]" -o tsv 2>/dev/null || true)"
if [[ -z "$TOKEN" || "$TOKEN" == "None" ]]; then TOKEN="$(secreto 24)"; echo "   token nuevo"; else echo "   se reutiliza el que ya tiene usuarios"; fi
for app in "${APPS[@]}"; do
  actual="$(az webapp config appsettings list -g "$RG" -n "$app" --query "[?name=='METRICAS_TOKEN'].value | [0]" -o tsv 2>/dev/null || true)"
  if [[ "$actual" == "$TOKEN" ]]; then echo "   $app: ya lo tiene"; continue; fi
  az webapp config appsettings set -g "$RG" -n "$app" --settings "METRICAS_TOKEN=$TOKEN" -o none
  echo "   $app: listo (se reinicia)"
done

crear() { # nombre, imagen, etiqueta DNS, puerto, cpu, memoria, linea de comando, variables seguras..., (resto: --environment-variables ...)
  local nombre="$1" imagen="$2" etiqueta="$3" puerto="$4" cpu="$5" mem="$6" comando="$7"; shift 7
  az container delete -g "$RG" -n "$nombre" --yes -o none 2>/dev/null || true
  az container create -g "$RG" -n "$nombre" -l "$REGION" --image "$imagen" --os-type Linux --cpu "$cpu" --memory "$mem" \
    --ip-address Public --dns-name-label "$etiqueta" --ports "$puerto" --protocol TCP --restart-policy Always \
    --gitrepo-url "$REPO" --gitrepo-revision "$RAMA" --gitrepo-mount-path /mnt/infra \
    --command-line "$comando" "$@" \
    --query "ipAddress.fqdn" -o tsv
}

echo "2) Prometheus"
crear growlink-prometheus prom/prometheus:v3.15.1 "$PROM_ETIQUETA" 9090 0.5 1 \
  "/bin/sh -c 'printf %s \"\$METRICAS_TOKEN\" > /tmp/metricas-token && exec /bin/prometheus --config.file=/mnt/infra/observabilidad/azure/prometheus.yml --storage.tsdb.path=/prometheus --storage.tsdb.retention.time=3d'" \
  --secure-environment-variables "METRICAS_TOKEN=$TOKEN"
PROM_URL="http://${PROM_ETIQUETA}.${REGION}.azurecontainer.io:9090"

echo "3) Grafana"
ADMIN="${GRAFANA_ADMIN_PASSWORD:-$(secreto 16)}"
crear growlink-grafana grafana/grafana:13.2.5 "$GRAFANA_ETIQUETA" 3000 0.5 1.5 \
  "/run.sh" \
  --environment-variables \
    "PROMETHEUS_URL=$PROM_URL" \
    "GF_PATHS_PROVISIONING=/mnt/infra/observabilidad/azure/grafana/provisioning" \
    "GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH=/mnt/infra/observabilidad/grafana/dashboards/negocio.json" \
    "GF_AUTH_ANONYMOUS_ENABLED=true" "GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer" \
    "GF_ANALYTICS_REPORTING_ENABLED=false" "GF_ANALYTICS_CHECK_FOR_UPDATES=false" "GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false" \
  --secure-environment-variables "GF_SECURITY_ADMIN_PASSWORD=$ADMIN"
TOKEN=""; ADMIN=""

echo
echo "Listo. En un par de minutos:"
echo "  Grafana (tableros, sin iniciar sesion): http://${GRAFANA_ETIQUETA}.${REGION}.azurecontainer.io:3000"
echo "  Prometheus (consultas y alertas):       ${PROM_URL}  (y /alerts)"
