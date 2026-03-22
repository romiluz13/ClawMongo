#!/bin/bash
# ClawMongo Preview Quick Start
# One command to start MongoDB with mongot + auto-embeddings
#
# Usage:
#   ./docker/mongodb/start-preview.sh              # Start (no auto-embed)
#   VOYAGE_API_KEY=key ./docker/mongodb/start-preview.sh  # Start with auto-embed
#   ./docker/mongodb/start-preview.sh stop          # Stop
#   ./docker/mongodb/start-preview.sh clean         # Stop + delete data

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.preview.yml"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

case "${1:-start}" in
  start|up)
    echo -e "${GREEN}Starting ClawMongo (mongodb-atlas-local:preview)...${NC}"
    docker compose -f "$COMPOSE_FILE" up -d

    echo ""
    echo "Waiting for healthcheck..."
    # Wait for container to be healthy (up to 90s)
    TIMEOUT=90
    ELAPSED=0
    while [ $ELAPSED -lt $TIMEOUT ]; do
      STATUS=$(docker inspect --format='{{.State.Health.Status}}' clawmongo-preview 2>/dev/null || echo "missing")
      if [ "$STATUS" = "healthy" ]; then
        break
      fi
      sleep 3
      ELAPSED=$((ELAPSED + 3))
      echo "  Status: $STATUS ($ELAPSED/${TIMEOUT}s)"
    done

    if [ "$STATUS" = "healthy" ]; then
      echo ""
      echo -e "${GREEN}ClawMongo MongoDB is ready.${NC}"
      echo ""
      echo "Connection string: mongodb://localhost:${MONGODB_PORT:-27017}/?directConnection=true"
      echo ""
      echo "Features:"
      echo "  + mongod + mongot (single container)"
      echo "  + Atlas Search + Vector Search"
      echo "  + ACID transactions (replica set)"
      echo "  + Change streams"
      if [ -n "${VOYAGE_API_KEY:-}" ]; then
        echo -e "  + ${GREEN}Auto-embeddings enabled (Voyage AI)${NC}"
      else
        echo -e "  - ${YELLOW}Auto-embeddings disabled (set VOYAGE_API_KEY to enable)${NC}"
      fi
      echo ""
      echo "Next: clawmongo setup"
    else
      echo -e "${RED}Container did not become healthy within ${TIMEOUT}s.${NC}"
      echo "Check: docker logs clawmongo-preview"
      exit 1
    fi
    ;;

  stop|down)
    echo "Stopping ClawMongo..."
    docker compose -f "$COMPOSE_FILE" down
    echo -e "${GREEN}Stopped.${NC}"
    ;;

  clean)
    echo -e "${RED}Stopping and removing ALL data...${NC}"
    read -p "Are you sure? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      docker compose -f "$COMPOSE_FILE" down -v
      echo -e "${GREEN}All data removed.${NC}"
    else
      echo "Aborted."
    fi
    ;;

  status)
    docker compose -f "$COMPOSE_FILE" ps
    ;;

  logs)
    docker compose -f "$COMPOSE_FILE" logs -f
    ;;

  *)
    echo "Usage: $0 {start|stop|clean|status|logs}"
    exit 1
    ;;
esac
