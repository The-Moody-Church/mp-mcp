/**
 * Regenerate docs/allowlisted-table-schema.json from the live MP REST API.
 *
 * Usage:
 *   npm run build:schema
 *
 * Reads:  config/table-access.json  (which tables to introspect)
 *         .env                      (MP_BASE_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET)
 * Writes: docs/allowlisted-table-schema.json
 *
 * The output mirrors the shape of the runtime `describe_table` tool:
 * { TableName: [{ name, type, fk_join_prefix?, lookup_table?, label_column? }, ...] }
 * — i.e. names + JS-introspected types + FK metadata. SQL type widths and
 * column descriptions from MP's data dictionary are NOT captured (the REST
 * row-introspection path doesn't expose them); the live MP UI's Data
 * Dictionary remains the source of truth for those.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAllowedTables } from "../src/config.js";
import { mpApiRequest } from "../src/transport.js";
import { FK_CATALOG, inferLookupTable } from "../src/utils/fk-catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const OUTPUT_PATH = join(PROJECT_ROOT, "docs", "allowlisted-table-schema.json");

interface FieldMetadata {
  name: string;
  type: string;
  fk_join_prefix?: string;
  lookup_table?: string;
  label_column?: string;
}

function require_env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
      `Run with \`node --env-file=.env\` (handled by \`npm run build:schema\`) ` +
      `or export it in your shell.`
    );
  }
  return value;
}

async function getServerToken(mpBaseUrl: string, clientId: string, clientSecret: string): Promise<string> {
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "http://www.thinkministry.com/dataplatform/scopes/all",
  });

  const res = await fetch(`${mpBaseUrl}/ministryplatformapi/oauth/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`client_credentials request failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

function describeColumns(sample: Record<string, unknown>, allowedTables: string[]): FieldMetadata[] {
  const columnNames = Object.keys(sample);
  // MP returns the primary key as the first column. Treat the first _ID
  // column as the PK so we don't tag it as a foreign key.
  const primaryKey = columnNames.find((k) => k.endsWith("_ID"));

  return columnNames.map((key) => {
    const value = sample[key];
    const type =
      value === null ? "null" :
      value instanceof Date ? "date" :
      Array.isArray(value) ? "array" :
      typeof value;

    const field: FieldMetadata = { name: key, type };
    if (key === primaryKey) return field;

    const catalogEntry = FK_CATALOG[key];
    if (catalogEntry) {
      field.fk_join_prefix = `${key}_Table`;
      field.lookup_table = catalogEntry.lookup_table;
      field.label_column = catalogEntry.label_column;
      return field;
    }

    if (key.endsWith("_ID")) {
      field.fk_join_prefix = `${key}_Table`;
      const lookup = inferLookupTable(key, allowedTables);
      if (lookup) field.lookup_table = lookup;
    }
    return field;
  });
}

async function main(): Promise<void> {
  const mpBaseUrl = require_env("MP_BASE_URL").replace(/\/+$/, "");
  const clientId = require_env("OIDC_CLIENT_ID");
  const clientSecret = require_env("OIDC_CLIENT_SECRET");

  const allowed = getAllowedTables("read");
  if (allowed.length === 0) {
    throw new Error("config/table-access.json has no read-allowlisted tables.");
  }

  console.log(`[build-schema] introspecting ${allowed.length} tables against ${mpBaseUrl}`);
  const token = await getServerToken(mpBaseUrl, clientId, clientSecret);

  const output: Record<string, FieldMetadata[]> = {};
  const empty: string[] = [];
  const failed: Array<{ table: string; error: string }> = [];

  for (const table of allowed) {
    try {
      const rows = await mpApiRequest(
        mpBaseUrl, token, "GET",
        `/tables/${encodeURIComponent(table)}`, { $top: 1 }
      ) as Record<string, unknown>[];

      if (rows.length === 0) {
        empty.push(table);
        output[table] = [];
        continue;
      }
      output[table] = describeColumns(rows[0], allowed);
      console.log(`  ok  ${table} (${output[table].length} columns)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ table, error: message });
      console.error(`  FAIL ${table}: ${message}`);
    }
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf-8");
  console.log(`\n[build-schema] wrote ${OUTPUT_PATH}`);

  if (empty.length > 0) {
    console.log(`[build-schema] ${empty.length} table(s) had no rows — columns left empty: ${empty.join(", ")}`);
  }
  if (failed.length > 0) {
    console.error(`[build-schema] ${failed.length} table(s) failed; check Client User permissions.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[build-schema] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
