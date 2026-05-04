# Deploy Command

Pull the latest released image (`:latest`) and restart the mp-mcp container on TMC1 after verifying CI has completed. Uses the base compose file only — no overrides.

## Instructions

1. **Check CI status**: `:latest` only rebuilds when a release tag (matching `v*`) is pushed — main-branch pushes don't move it. Find the most recent tag-push run:
   ```bash
   gh run list --repo The-Moody-Church/mp-mcp --workflow "Build, Scan, and Push Docker Image" --event push --limit 30 --json databaseId,headBranch,conclusion,status,createdAt,displayTitle --jq '[.[] | select(.headBranch | test("^v[0-9]"))] | .[0]'
   ```
   Verify `conclusion` is `success`. If `status` is `in_progress` or `queued`, wait and poll every 15 seconds until it completes. If it failed, stop and report. Note the tag in `headBranch` so the user knows which release version they're about to deploy.

2. **Pull the new image**: SSH into TMC1 and pull + recreate:
   ```bash
   ssh tmc1 "cd /srv/mp-mcp && docker compose pull && docker compose down && docker compose up -d"
   ```
   Verify the output shows the container was recreated and started.

3. **Verify container is running**: Run:
   ```bash
   docker --context tmc1 ps --filter name=mp-mcp --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
   ```
   Confirm the container shows "Up" with a recent start time.

4. **Health check**: Verify the server is responding:
   ```bash
   curl -s https://mcp.moodychurch.app/health
   ```
   Expect `{"status":"ok"}`.

5. **Check startup logs**: Check for clean startup:
   ```bash
   docker --context tmc1 logs mp-mcp --since 30s 2>&1 | tail -10
   ```
   Look for `mp-mcp server listening on port 3000`.

6. **Report result**: Show the user:
   - CI run status and duration
   - Container status (up/down, uptime)
   - Health check response

## Arguments

- `$ARGUMENTS` - Optional. If `--skip-ci` is passed, skip the CI check and proceed directly to pull/restart. Useful when you've already verified CI passed.

## Notes

- The `tmc1` SSH alias (in `~/.ssh/config`) and the `tmc1` Docker context both resolve to the production host. The alias keeps the actual host/user out of this file.
- The compose file is at `/srv/mp-mcp/docker-compose.yml` on the remote host; the base file pins `image: ghcr.io/the-moody-church/mp-mcp:latest`.
- Use `docker --context tmc1` for inspection commands but `ssh tmc1` for compose commands (compose needs the local file path).
- Use `docker compose down && docker compose up -d` (not `restart`) to ensure the new image is used.
- For the bleeding-edge `main` branch image, use `/deploy-main`. For PR previews on `:dev`, use `/deploy-dev`.
