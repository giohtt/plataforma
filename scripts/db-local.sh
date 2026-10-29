#!/usr/bin/env bash
# PostgreSQL local SOLO para desarrollo y pruebas, con datos ficticios.
# Uso: scripts/db-local.sh iniciar | detener | estado
# Requiere los binarios de PostgreSQL 16 (initdb, pg_ctl) instalados en la máquina.
set -euo pipefail

PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
DIR="${DB_LOCAL_DIR:-$(pwd)/.db-local}"
PUERTO="${DB_LOCAL_PUERTO:-5433}"
USUARIO_SO="${DB_LOCAL_USUARIO_SO:-postgres}"

correr() {
  if [ "$(id -un)" = "root" ]; then su "$USUARIO_SO" -c "$*"; else bash -c "$*"; fi
}

case "${1:-}" in
  iniciar)
    mkdir -p "$DIR"
    [ "$(id -un)" = "root" ] && chown "$USUARIO_SO" "$DIR"
    if [ ! -f "$DIR/datos/PG_VERSION" ]; then
      correr "$PG_BIN/initdb -D '$DIR/datos' -U postgres -A trust --locale=C.UTF-8 >/dev/null"
    fi
    correr "$PG_BIN/pg_ctl -D '$DIR/datos' -o \"-p $PUERTO -k '$DIR' -c listen_addresses=127.0.0.1\" -l '$DIR/registro.log' -w start >/dev/null"
    echo "PostgreSQL local listo: postgres://postgres@127.0.0.1:$PUERTO/postgres"
    ;;
  detener)
    correr "$PG_BIN/pg_ctl -D '$DIR/datos' -m fast stop >/dev/null" && echo "PostgreSQL local detenido."
    ;;
  estado)
    correr "$PG_BIN/pg_ctl -D '$DIR/datos' status" || true
    ;;
  *)
    echo "Uso: $0 iniciar | detener | estado" >&2
    exit 1
    ;;
esac
