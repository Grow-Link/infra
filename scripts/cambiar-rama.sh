#!/usr/bin/env bash
# Cambia de rama los 4 repos de GrowLink a la vez, para construir con docker compose
# una de las tres versiones: main (lo actual), avance o final.
#
#   ./scripts/cambiar-rama.sh avance
#
# Se niega a cambiar si algun repo tiene cambios sin guardar, para no perder trabajo.
set -euo pipefail

RAMA="${1:-}"
if [[ ! "$RAMA" =~ ^(main|avance|final)$ ]]; then
  echo "Uso: $0 main|avance|final" >&2
  exit 1
fi

RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
REPOS=(usuarios-service cursos-service trivia-service GrowLink-FRONTEND infra)

for repo in "${REPOS[@]}"; do
  if [[ -n "$(git -C "$RAIZ/$repo" status --porcelain)" ]]; then
    echo "$repo tiene cambios sin guardar, haz commit o stash antes de cambiar de rama" >&2
    exit 1
  fi
done

for repo in "${REPOS[@]}"; do
  git -C "$RAIZ/$repo" checkout -q "$RAMA"
  echo "$repo -> $(git -C "$RAIZ/$repo" branch --show-current)"
done
