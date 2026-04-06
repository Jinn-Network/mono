# Docker Worker Operations

`yarn worker` uses Docker Compose by default. This provides auto-restart, health monitoring, resource limits, and log rotation.

## Prerequisites

- Docker Engine 24+ with Compose V2 (`docker compose version`)
- Setup complete (`.operate/` exists with service config + keys)

If Docker is not installed, `yarn worker` falls back to bare mode with a warning.

## Commands

| Command | Purpose |
|---------|---------|
| `yarn worker` | Start worker (Docker, detached) |
| `yarn worker --single` | Run one job in Docker, then exit |
| `yarn worker:dev` | Bare tsx, no Docker (development) |
| `docker compose logs -f` | Follow logs |
| `docker compose ps` | Check health status |
| `docker compose down` | Stop the worker |
| `docker compose up -d --build` | Rebuild after code updates |

## What Docker provides

| Feature | `yarn worker:dev` | `yarn worker` (Docker) |
|---------|-------------------|------------------------|
| Auto-restart on crash | No | Yes (`unless-stopped`) |
| Health monitoring | No | Yes (HTTP /health every 30s) |
| Memory limit | None | 4GB |
| Log rotation | No | Yes (50MB x 5 files) |
| Chrome shared memory | System default | 2GB (`shm_size`) |
| Non-root execution | No | Yes (`jinn` user) |

## Data persistence

Two named volumes preserve state across restarts:
- `node-data` → `/home/jinn` — wallet keystore, Gemini auth
- `jinn-repos` → `/app/jinn-repos` — cached repo clones

Backup wallet from container:
```bash
docker compose cp worker:/home/jinn/.operate ./operate-backup
```

## Foreground mode

To see logs interactively instead of detaching:
```bash
docker compose up    # Ctrl-C to stop
```
