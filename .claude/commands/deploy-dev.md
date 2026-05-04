# Deploy Dev Command

Pull the `:dev` image (rebuilt on every push to a non-`main` branch) and restart the mp-mcp container on TMC1. Layers `docker-compose.dev.yml` on top of the base. Use this to test PR previews before merging.

## Instructions

1. **Check CI status**: `:dev` rebuilds on every push to any non-`main` branch — it's single-tenant, so whichever non-`main` branch was pushed most recently is what `:dev` points to right now. Find that build:
   ```bash
   gh run list --repo The-Moody-Church/mp-mcp --workflow "Build, Scan, and Push Docker Image" --event push --limit 20 --json databaseId,headBranch,conclusion,status,createdAt,displayTitle --jq '[.[] | select(.headBranch != "main")] | .[0]'
   ```
   Verify `conclusion` is `success`. If `status` is `in_progress` or `queued`, wait and poll every 15 seconds until it completes. If it failed, stop and report — do not deploy. Note the `headBranch` so the user knows which branch they're about to deploy onto prod hardware.

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

6. **Report result**: image tag and start time, health check response, and the branch/PR the `:dev` build was triggered from (already known from step 1).

## Notes

- `:dev` is for testing — production traffic flowing through TMC1 will hit whatever's running, so confirm with the team before deploying an experimental branch onto prod hardware.
- Returning to canonical state: `/deploy` (back to `:latest`) or `/deploy-main` (back to `:main`).
- The override file `/srv/mp-mcp/docker-compose.dev.yml` only sets `services.mp-mcp.image: …:dev`; everything else comes from the base.
