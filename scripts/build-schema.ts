/**
 * Regenerate docs/allowlisted-table-schema.json from MP's metadata endpoint.
 *
 * Usage:
 *   npm run build:schema
 *
 * Reads:  config/table-access.json  (which tables to introspect)
 *         .env                      (MP_BASE_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET)
 * Writes: docs/allowlisted-table-schema.json
 *
 * Mechanism: GET /ministryplatformapi/tables?$search=<table> per allowlisted
 * table, parsing the column metadata MP returns inline (Name, DataType, Size,
 * IsRequired, IsPrimaryKey, IsForeignKey, ReferencedTable, ReferencedColumn,
 * IsReadOnly, IsComputed). The label_column for FK columns — i.e. which
 * column on the lookup table is the canonical display value — is overlaid
 * from FK_CATALOG since MP doesn't surface that.
 *
 * The runtime `describe_table` tool still uses $top=1 row introspection +
 * FK_CATALOG since it has to answer per-call without round-tripping for
 * metadata. That divergence is intentional.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAllowedTables } from "../src/config.js";
import { mpApiRequest } from "../src/transport.js";
import { FK_CATALOG } from "../src/utils/fk-catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const OUTPUT_PATH = join(PROJECT_ROOT, "docs", "allowlisted-table-schema.json");

interface ColumnMetadata {
  Name: string;
  DataType: string;
  IsRequired: boolean;
  Size: number;
  IsPrimaryKey?: boolean;
  IsForeignKey?: boolean;
  ReferencedTable?: string;
  ReferencedColumn?: string;
  IsReadOnly?: boolean;
  IsComputed?: boolean;
  HasDefault?: boolean;
}

interface TableMetadata {
  Table_Name: string;
  Display_Name?: string;
  Description?: string;
  Columns?: ColumnMetadata[];
}

interface FieldOutput {
  name: string;
  type: string;
  pk?: true;
  required?: true;
  read_only?: true;
  computed?: true;
  fk_join_prefix?: string;
  lookup_table?: string;
  label_column?: string;
}

function require_env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
      `Run with \`npm run build:schema\` (uses --env-file=.env) or export it in your shell.`
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

// MP returns abstract types ("String", "Integer32", "DateTime") rather than
// raw SQL types. Append Size for types where it's meaningful; -1 means MAX.
function formatType(col: ColumnMetadata): string {
  if (col.Size === -1) return `${col.DataType}(max)`;
  if (col.Size > 0) return `${col.DataType}(${col.Size})`;
  return col.DataType;
}

function mapColumns(columns: ColumnMetadata[]): FieldOutput[] {
  return columns
    .filter((c) => c.DataType !== "Separator")
    .map((c) => {
      const field: FieldOutput = {
        name: c.Name,
        type: formatType(c),
      };
      if (c.IsPrimaryKey) field.pk = true;
      if (c.IsRequired) field.required = true;
      if (c.IsReadOnly) field.read_only = true;
      if (c.IsComputed) field.computed = true;

      if (c.IsForeignKey && c.ReferencedTable) {
        field.fk_join_prefix = `${c.Name}_Table`;
        field.lookup_table = c.ReferencedTable;
        const labelColumn = FK_CATALOG[c.Name]?.label_column;
        if (labelColumn) field.label_column = labelColumn;
      }
      return field;
    });
}

async function fetchTableMetadata(
  mpBaseUrl: string, token: string, table: string
): Promise<TableMetadata | null> {
  // $search is a substring match across the metadata table names; filter
  // the response to the exact match so e.g. "Groups" doesn't pick up
  // "Group_Participants" too.
  const results = await mpApiRequest(
    mpBaseUrl, token, "GET", "/tables", { $search: table }
  ) as TableMetadata[];
  return results.find((t) => t.Table_Name === table) ?? null;
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

  const output: Record<string, FieldOutput[]> = {};
  const missingMetadata: string[] = [];
  const failed: Array<{ table: string; error: string }> = [];

  // mpApiRequest's concurrency limiter (6 in flight) handles parallelism;
  // Promise.all here just lets the limiter saturate.
  const results = await Promise.all(allowed.map(async (table) => {
    try {
      const meta = await fetchTableMetadata(mpBaseUrl, token, table);
      if (!meta) return { table, status: "not_found" as const };
      if (!meta.Columns || meta.Columns.length === 0) {
        return { table, status: "no_columns" as const };
      }
      return { table, status: "ok" as const, fields: mapColumns(meta.Columns) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { table, status: "error" as const, message };
    }
  }));

  for (const r of results) {
    if (r.status === "ok") {
      output[r.table] = r.fields;
      console.log(`  ok    ${r.table} (${r.fields.length} columns)`);
    } else if (r.status === "not_found") {
      missingMetadata.push(r.table);
      console.error(`  miss  ${r.table} — no metadata returned (Client User likely lacks read access)`);
    } else if (r.status === "no_columns") {
      missingMetadata.push(r.table);
      console.error(`  empty ${r.table} — metadata response had no Columns array`);
    } else {
      failed.push({ table: r.table, error: r.message });
      console.error(`  FAIL  ${r.table}: ${r.message}`);
    }
  }

  // Write in allowlist order so the file diff stays stable across runs.
  const ordered: Record<string, FieldOutput[]> = {};
  for (const t of allowed) {
    if (output[t]) ordered[t] = output[t];
  }
  writeFileSync(OUTPUT_PATH, JSON.stringify(ordered, null, 2) + "\n", "utf-8");
  console.log(`\n[build-schema] wrote ${OUTPUT_PATH} (${Object.keys(ordered).length} tables)`);

  if (missingMetadata.length > 0 || failed.length > 0) {
    console.error(`[build-schema] ${missingMetadata.length} missing, ${failed.length} failed.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[build-schema] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
