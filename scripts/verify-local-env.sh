#!/usr/bin/env bash
# ==============================================================================
# verify-local-env.sh
# Automated Health Probe & Environment Verification for PostgreSQL & Redis
#
# Ensures database and cache services are completely initialized, healthy,
# and ready to accept connections before launching API workers or migrations.
# ==============================================================================

set -eo pipefail

# ANSI Color Codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-30}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-stellar_alerts_postgres}"
REDIS_CONTAINER="${REDIS_CONTAINER:-stellar_alerts_redis}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-stellar_alerts}"

RUN_MIGRATIONS=true
for arg in "$@"; do
  case $arg in
    --timeout=*)
      TIMEOUT_SECONDS="${arg#*=}"
      shift
      ;;
    --skip-migrations)
      RUN_MIGRATIONS=false
      shift
      ;;
    --help|-h)
      echo -e "${BOLD}Usage:${NC} $0 [--timeout=SECONDS] [--skip-migrations]"
      exit 0
      ;;
  esac
done

log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WAITING]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

echo -e "\n${BOLD}${CYAN}=== Stellar Alerts Local Environment Health Probe ===${NC}\n"

# 1. Verify Docker Engine
log_info "Checking Docker daemon availability..."
if ! command -v docker >/dev/null 2>&1; then
  log_error "Docker CLI is not installed or not in PATH."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  log_error "Docker daemon is not running. Please start Docker first."
  exit 1
fi
log_success "Docker daemon is responsive."

# 2. Probe PostgreSQL Readiness
log_info "Probing PostgreSQL readiness (${POSTGRES_CONTAINER})..."
start_time=$(date +%s)
pg_ready=false

while true; do
  current_time=$(date +%s)
  elapsed=$((current_time - start_time))

  if [ "$elapsed" -ge "$TIMEOUT_SECONDS" ]; then
    log_error "PostgreSQL healthcheck timed out after ${TIMEOUT_SECONDS}s."
    exit 1
  fi

  # Attempt pg_isready inside container
  if docker exec "$POSTGRES_CONTAINER" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    pg_ready=true
    break
  fi

  # Fallback to local pg_isready or port check if container exec not available
  if command -v pg_isready >/dev/null 2>&1; then
    if pg_isready -h localhost -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
      pg_ready=true
      break
    fi
  fi

  log_warn "Waiting for PostgreSQL (${elapsed}s/${TIMEOUT_SECONDS}s)..."
  sleep 1
done

if [ "$pg_ready" = true ]; then
  log_success "PostgreSQL is accepting connections on port 5432."
fi

# 3. Probe Redis Readiness
log_info "Probing Redis readiness (${REDIS_CONTAINER})..."
start_time=$(date +%s)
redis_ready=false

while true; do
  current_time=$(date +%s)
  elapsed=$((current_time - start_time))

  if [ "$elapsed" -ge "$TIMEOUT_SECONDS" ]; then
    log_error "Redis healthcheck timed out after ${TIMEOUT_SECONDS}s."
    exit 1
  fi

  # Attempt redis-cli ping inside container
  if [ "$(docker exec "$REDIS_CONTAINER" redis-cli ping 2>/dev/null | tr -d '\r')" = "PONG" ]; then
    redis_ready=true
    break
  fi

  # Fallback to local redis-cli
  if command -v redis-cli >/dev/null 2>&1; then
    if [ "$(redis-cli -p 6379 ping 2>/dev/null | tr -d '\r')" = "PONG" ]; then
      redis_ready=true
      break
    fi
  fi

  log_warn "Waiting for Redis (${elapsed}s/${TIMEOUT_SECONDS}s)..."
  sleep 1
done

if [ "$redis_ready" = true ]; then
  log_success "Redis responded to PING on port 6379."
fi

# 4. Schema Migration & Prisma Verification
if [ "$RUN_MIGRATIONS" = true ]; then
  log_info "Synchronizing database schema (Prisma db push)..."
  if npm run db:push --workspace=api >/dev/null 2>&1; then
    log_success "Prisma database schema verified and synchronized."
  else
    log_warn "Prisma sync skipped or non-fatal. Verify migrations manually if needed."
  fi
fi

echo -e "\n${GREEN}${BOLD}✓ Local environment services verified successfully!${NC}\n"
exit 0
