import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve paths relative to project root (one level up from src/)
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

export interface TablePermissions {
  read: boolean;
  write: boolean;
}

export type TableAccess = Record<string, TablePermissions>;

let cachedTableAccess: TableAccess | null = null;

export function loadTableAccess(): TableAccess {
  if (cachedTableAccess) return cachedTableAccess;

  const configPath = join(PROJECT_ROOT, "config", "table-access.json");
  try {
    const raw = readFileSync(configPath, "utf-8");
    cachedTableAccess = JSON.parse(raw) as TableAccess;
    return cachedTableAccess;
  } catch (err) {
    throw new Error(
      `Failed to load table-access.json from ${configPath}. ` +
        `Copy config/table-access.example.json to config/table-access.json and configure it. ` +
        `Error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function isTableAllowed(table: string, operation: "read" | "write"): boolean {
  const access = loadTableAccess();
  const perms = access[table];
  if (!perms) return false;
  return perms[operation] === true;
}

export function getAllowedTables(operation: "read" | "write"): string[] {
  const access = loadTableAccess();
  return Object.entries(access)
    .filter(([, perms]) => perms[operation] === true)
    .map(([table]) => table);
}

export interface AppConfig {
  mpBaseUrl: string;
  oidcClientId: string;
  oidcClientSecret: string;
  publicUrl: string;
  port: number;
  sessionSecret: string;
  allowedUserGroupIds: number[];
}

export function loadAppConfig(): AppConfig {
  const required = (name: string): string => {
    const val = process.env[name];
    if (!val) throw new Error(`Missing required environment variable: ${name}`);
    return val;
  };

  // Parse comma-separated group IDs. If not set, no restriction (empty = allow all).
  const groupIdsRaw = process.env.ALLOWED_USER_GROUP_IDS || "";
  const allowedUserGroupIds = groupIdsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !isNaN(n));

  return {
    mpBaseUrl: required("MP_BASE_URL").replace(/\/+$/, ""),
    oidcClientId: required("OIDC_CLIENT_ID"),
    oidcClientSecret: required("OIDC_CLIENT_SECRET"),
    publicUrl: required("PUBLIC_URL").replace(/\/+$/, ""),
    port: parseInt(process.env.PORT || "3000", 10),
    sessionSecret: required("SESSION_SECRET"),
    allowedUserGroupIds,
  };
}
