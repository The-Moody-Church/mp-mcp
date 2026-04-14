# Deploy Command

Pull the latest Docker image and restart the mp-mcp container on TMC1 after verifying CI has completed.

## Instructions

1. **Check CI status**: Run `gh run list --repo The-Moody-Church/mp-mcp --branch main --limit 1` and verify the most recent workflow completed successfully. If it's still in progress, wait and poll every 15 seconds until it completes (or fails). If it failed, stop and report the failure — do not deploy.

2. **Pull the new image**: SSH into TMC1 and pull + recreate:
   ```bash
   ssh ironside@192.168.5.222 "cd /srv/mp-mcp && docker compose pull && docker compose down && docker compose up -d"
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
   Expect `{"status":"ok","version":"0.1.0"}`.

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

- The Docker context `tmc1` is configured at `ssh://ironside@192.168.5.222`
- The compose file is at `/srv/mp-mcp/docker-compose.yml` on the remote host
- The image is `ghcr.io/the-moody-church/mp-mcp:latest`
- Use `docker --context tmc1` for inspection commands but `ssh ironside@192.168.5.222` for compose commands (compose needs the local file path)
- Use `docker compose down && docker compose up -d` (not `restart`) to ensure the new image is used
