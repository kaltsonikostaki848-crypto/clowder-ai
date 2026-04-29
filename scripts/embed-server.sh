#!/usr/bin/env bash
# scripts/embed-server.sh
# Start Cat Cafe embedding sidecar.
#
# Two modes (auto-selected):
#   1) Proxy mode — set EMBED_PROXY_UPSTREAM_URL + EMBED_PROXY_UPSTREAM_KEY
#      in .env, this script forwards :9880 to a remote OpenAI-compatible
#      embeddings endpoint (DashScope, together.ai, etc.) via Node proxy.
#   2) Native MLX mode — if scripts/embed-api.py exists and no proxy env set,
#      run Python/MLX process locally (Apple Silicon GPU).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT="${EMBED_PORT:-9880}"

# Load .env if present (start-dev.sh sources envs, but support direct invocation too)
if [ -f "$REPO_ROOT/.env" ] && [ -z "${EMBED_PROXY_UPSTREAM_URL:-}" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

if [ -n "${EMBED_PROXY_UPSTREAM_URL:-}" ] && [ -n "${EMBED_PROXY_UPSTREAM_KEY:-}" ]; then
  echo "=== Starting embedding proxy ==="
  echo "  Upstream: $EMBED_PROXY_UPSTREAM_URL"
  echo "  Model:    ${EMBED_PROXY_UPSTREAM_MODEL:-text-embedding-v4}"
  echo "  Port:     $PORT"
  echo ""
  exec env EMBED_PROXY_PORT="$PORT" node "$SCRIPT_DIR/embed-proxy.mjs"
fi

if [ -f "$SCRIPT_DIR/embed-api.py" ]; then
  echo "=== Starting native MLX embedding server ==="
  echo "  Port: $PORT"

  VENV_DIR="${HOME}/.cat-cafe/embed-venv"
  PLATFORM="$(uname -s)"
  ARCH="$(uname -m)"

  if [ ! -d "$VENV_DIR" ]; then
    echo "  Creating venv: $VENV_DIR ..."
    python3 -m venv "$VENV_DIR"
  fi
  source "$VENV_DIR/bin/activate"

  if [ "$PLATFORM" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
    if ! python3 -c "import mlx_embeddings" 2>/dev/null; then
      echo "  Installing: mlx + mlx-embeddings ..."
      pip install --quiet mlx mlx-embeddings fastapi uvicorn numpy
    fi
  else
    if ! python3 -c "import sentence_transformers" 2>/dev/null; then
      echo "  Installing: sentence-transformers + torch ..."
      pip install --quiet sentence-transformers torch fastapi uvicorn numpy
    fi
  fi

  exec python3 "$SCRIPT_DIR/embed-api.py" --port "$PORT"
fi

echo "ERROR: no embedding backend configured." >&2
echo "  Either set EMBED_PROXY_UPSTREAM_URL + EMBED_PROXY_UPSTREAM_KEY in .env (remote)," >&2
echo "  or install scripts/embed-api.py (local MLX)." >&2
exit 1
