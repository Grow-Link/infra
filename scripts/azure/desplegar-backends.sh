#!/usr/bin/env bash
# Construye y sube a Azure los tres backends desde la rama main de sus repos (que tienen que estar clonados junto a infra, como
# pide el compose). Trivia se sube a sus TRES copias, de una en una: mientras una se actualiza, el balanceador del front manda
# el trafico a las otras dos (por eso no se cortan las partidas de las demas).
#
#   az login                                    (una vez)
#   ./scripts/azure/desplegar-backends.sh                 todo
#   ./scripts/azure/desplegar-backends.sh trivia          solo las tres copias de trivia
#   ./scripts/azure/desplegar-backends.sh usuarios cursos varios a la vez
#
# Los backends tambien tienen un flujo de despliegue en GitHub (cd.yml) que hace lo mismo con una sola app; esta es la forma de
# subir las tres copias de trivia juntas. Tarda unos minutos por app: Azure espera a que el servicio responda su salud.
set -euo pipefail
cd "$(dirname "$0")/../../.."          # la carpeta que contiene a infra y a los servicios
RG="${RG:-rg-growlink}"

declare -A REPO=( [usuarios]=usuarios-service [cursos]=cursos-service [trivia]=trivia-service )
declare -A APPS=( [usuarios]="growlink-usuarios" [cursos]="growlink-cursos" [trivia]="growlink-trivia growlink-trivia-b growlink-trivia-c" )
QUE=("$@"); [[ ${#QUE[@]} -eq 0 ]] && QUE=(usuarios cursos trivia)

for servicio in "${QUE[@]}"; do
  carpeta="${REPO[$servicio]:-}"
  [[ -z "$carpeta" ]] && { echo "no conozco '$servicio' (usuarios, cursos o trivia)" >&2; exit 1; }
  echo "=== $servicio: construyendo desde $carpeta ($(git -C "$carpeta" log --oneline -1 | cut -c1-60))"
  if [[ -n "$(git -C "$carpeta" status --porcelain)" ]]; then echo "   AVISO: $carpeta tiene cambios sin subir; se despliega lo que hay en el disco"; fi
  (cd "$carpeta" && CLAUDE_API_KEY= mvn -q -B -DskipTests package)
  jar="$(ls "$carpeta"/target/*.jar | grep -v original | head -1)"
  for app in ${APPS[$servicio]}; do
    echo "=== $app: subiendo $(basename "$jar")"
    az webapp deploy -g "$RG" -n "$app" --src-path "$jar" --type jar --timeout 1500 2>&1 | grep -v WARNING | tail -2
    echo "=== $app: terminado"
  done
done
echo TODO_LISTO
