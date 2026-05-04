# Deploy Main Command

Pull the `:main` image (rebuilt on every push to `main`) and restart the mp-mcp container on TMC1. Layers `docker-compose.main.yml` on top of the base.

## Instructions

1. **Check CI status**: Run `gh run list --repo The-Moody-Church/mp-mcp --branch main --limit 1` and verify the most recent workflow completed successfully. If it's still in progress, wait and poll every 15 seconds until it completes (or fails). If it failed, stop and report the failure — do not deploy.

2. **Pull and restart with the main override**:
   ```bash
   ssh tmc1 "cd /srv/mp-mcp && docker compose -f docker-compose.yml -f docker-compose.main.yml pull && docker compose -f docker-compose.yml -f docker-compose.main.yml down && docker compose -f docker-compose.yml -f docker-compose.main.yml up -d"
   ```
   Verify the output shows the container was recreated and started.

3. **Verify container is running**:
   ```bash
   docker --context tmc1 inspect mp-mcp --format 'image: {{.Config.Image}} | started: {{.State.StartedAt}}'
   ```
   Confirm the image is `ghcr.io/the-moody-church/mp-mcp:main` and the start time is recent.

4. **Health check**:
   ```bash
   curl -s https://mcp.moodychurch.app/health
   ```
   Expect `{"status":"ok"}`.

5. **Check startup logs**:
   ```bash
   docker --context tmc1 logs mp-mcp --since 30s 2>&1 | tail -10
   ```
   Look for `mp-mcp server listening on port 3000`.

6. **Report result**: CI run status, image tag and start time, health check response.

## Arguments

- `$ARGUMENTS` - Optional. If `--skip-ci` is passed, skip the CI check and proceed directly to pull/restart.

## Notes

- `:main` rebuilds on every push to `main` — it tracks merged-but-untagged work and is more aggressive than `:latest`.
- The override file `/srv/mp-mcp/docker-compose.main.yml` only sets `services.mp-mcp.image: …:main`; everything else (env_file, ports, volumes) comes from the base.
- For the released image, use `/deploy`. For PR previews, use `/deploy-dev`.
