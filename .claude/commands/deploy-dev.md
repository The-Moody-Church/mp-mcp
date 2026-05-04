# Deploy Dev Command

Pull the `:dev` image (rebuilt on every push to a non-`main` branch) and restart the mp-mcp container on TMC1. Layers `docker-compose.dev.yml` on top of the base. Use this to test PR previews before merging.

## Instructions

1. **Skip CI check by default.** `:dev` is single-tenant — it tracks whichever non-`main` branch was pushed most recently — so a CI check on `main` doesn't apply. If you want to verify a specific branch's build before deploying, do that manually with `gh run list --branch <branch>` first.

2. **Pull and restart with the dev override**:
   ```bash
   ssh tmc1 "cd /srv/mp-mcp && docker compose -f docker-compose.yml -f docker-compose.dev.yml pull && docker compose -f docker-compose.yml -f docker-compose.dev.yml down && docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d"
   ```
   Verify the output shows the container was recreated and started.

3. **Verify container is running**:
   ```bash
   docker --context tmc1 inspect mp-mcp --format 'image: {{.Config.Image}} | started: {{.State.StartedAt}}'
   ```
   Confirm the image is `ghcr.io/the-moody-church/mp-mcp:dev` and the start time is recent.

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

6. **Report result**: image tag and start time, health check response, and which PR / branch the `:dev` build was last triggered from (if obvious from `gh run list --workflow "Build, Scan, and Push Docker Image" --event push --limit 5`).

## Notes

- `:dev` is for testing — production traffic flowing through TMC1 will hit whatever's running, so confirm with the team before deploying an experimental branch onto prod hardware.
- Returning to canonical state: `/deploy` (back to `:latest`) or `/deploy-main` (back to `:main`).
- The override file `/srv/mp-mcp/docker-compose.dev.yml` only sets `services.mp-mcp.image: …:dev`; everything else comes from the base.
