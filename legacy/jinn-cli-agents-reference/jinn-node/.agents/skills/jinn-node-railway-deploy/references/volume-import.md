# Import `.operate` and `.gemini` into Railway Volume

Run from local `jinn-node/` where `.operate/` exists.

**Recommended:** Use `bash scripts/deploy-railway.sh` which handles import automatically. This reference is for manual troubleshooting only.

**Prerequisites:**
- `railway ssh` requires a running container. On first-time deployment, deploy with an idle start command first (the deploy script does this automatically).
- Railway SSH uses WebSocket and does NOT forward stdin pipes. Use base64 encoding instead of `tar | railway ssh` piping.

## Create remote directories

```bash
railway ssh -- 'mkdir -p /home/jinn/.operate /home/jinn/.gemini'
```

## Import `.operate` (excluding deployment venvs)

`.operate/services/*/deployment/` contains Python venvs (~179MB per service) that get recreated at runtime. Exclude only `deployment/` — the service config files (`config.json`, `keys.json`) must be preserved.

```bash
payload=$(tar czf - --exclude='services/*/deployment' .operate | base64)
railway ssh -- "echo '$payload' | base64 -d | tar xzf - -C /home/jinn"
```

## Import `.gemini` (if using Gemini CLI OAuth)

Exclude bulky subdirectories that get recreated at runtime (`antigravity` ~1.1G, `antigravity-browser-profile` ~344M, `extensions` ~60M, `tmp`). Only the OAuth tokens and settings JSON files (~8KB) are needed:

```bash
payload=$(tar czf - -C "$HOME" --exclude='antigravity' --exclude='antigravity-browser-profile' --exclude='tmp' --exclude='extensions' .gemini | base64)
railway ssh -- "echo '$payload' | base64 -d | tar xzf - -C /home/jinn"
```

## Fix volume ownership

The Railway container runs SSH as root, but the worker runs as `jinn`. Fix permissions after import:

```bash
railway ssh -- 'chown -R jinn:jinn /home/jinn'
```

## Verify import

```bash
railway ssh -- 'ls -la /home/jinn/.operate /home/jinn/.gemini'
railway ssh -- 'ls /home/jinn/.operate/services/sc-*/config.json'
```

## Notes

- `railway ssh` requires Railway CLI auth and a running deployment.
- **Do NOT use `bash -lc` wrappers** — quoting breaks through Railway's SSH WebSocket transport. Pass commands directly.
- **Do NOT pipe stdin** (e.g., `tar | railway ssh`) — Railway SSH doesn't forward stdin. Use base64 encoding as shown above.
- **Fallback:** If `railway ssh` fails, use the Railway dashboard shell (Project > Service > Shell tab).
- **Large directories** (>1.5MB tar): Too large for base64 command args. Use an intermediary (e.g., presigned S3 URL + wget from inside the container).
