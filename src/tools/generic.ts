import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAllowedTables, isTableAllowed } from "../config.js";
import { mpApiRequest } from "../transport.js";
import { validatePathSegment } from "../utils/filter-sanitize.js";
import { getAuthFromExtra } from "./auth.js";

// Page size used for server-side pagination when counting rows. MP caps $top
// at 1000, so this is the largest page we can request.
const COUNT_PAGE_SIZE = 1000;

// Hard cap on the number of pages we'll walk for a single count, to keep a
// pathological count from hammering MP. 50 pages × 1000 rows = 50k rows max.
const COUNT_MAX_PAGES = 50;

/**
 * Heuristic lookup-table inference for FK columns.
 * Given a column like "Contact_Status_ID", try common pluralizations and
 * return the first one that exists in the read allowlist.
 */
function inferLookupTable(columnName: string, allowedTables: string[]): string | null {
  if (!columnName.endsWith("_ID")) return null;
  const stem = columnName.slice(0, -3);
  if (!stem) return null;

  const allowedSet = new Set(allowedTables);
  // Common MP pluralization patterns, in order of likelihood.
  const candidates = [
    `${stem}s`,           // Group → Groups, Contact → Contacts
    `${stem}es`,          // Status → Statuses
    stem,                 // Already-plural or self-named tables
    `${stem.replace(/y$/, "ies")}`, // Ministry → Ministries
  ];
  for (const candidate of candidates) {
    if (allowedSet.has(candidate)) return candidate;
  }
  return null;
}

export function registerGenericTools(server: McpServer): void {
  // ── list_tables ──────────────────────────────────────────────────────────

  server.registerTool(
    "list_tables",
    {
      title: "List Tables",
      description:
        "List all Ministry Platform tables available through this MCP server. " +
        "Returns table names and their read/write permissions.",
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      console.log(`[tool] list_tables called`);
      try {
        const tables = getAllowedTables("read");
        const result = {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              tables.map((t) => ({
                table: t,
                read: isTableAllowed(t, "read"),
                write: isTableAllowed(t, "write"),
              })),
              null, 2
            ),
          }],
        };
        console.log(`[tool] list_tables returning ${tables.length} tables`);
        return result;
      } catch (err) {
        console.error(`[tool] list_tables threw:`, err);
        throw err;
      }
    }
  );

  // ── describe_table ───────────────────────────────────────────────────────

  server.registerTool(
    "describe_table",
    {
      title: "Describe Table",
      description:
        "Get the field names and types for a Ministry Platform table. " +
        "For columns ending in _ID, also returns an `fk_join_prefix` (use it " +
        "as `{prefix}.{ColumnOnLookupTable}` in $select) and, when the " +
        "inferred lookup table is in the allowlist, a `lookup_table` hint.",
      inputSchema: {
        table: z.string().describe("The MP table name (e.g., 'Contacts', 'Events')"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ table }, extra) => {
      const safeName = validatePathSegment(table, "table");
      if (!isTableAllowed(safeName, "read")) {
        const allowed = getAllowedTables("read");
        return {
          content: [{ type: "text" as const, text: `Table "${safeName}" is not in the allowlist. Available tables: ${allowed.join(", ")}` }],
          isError: true,
        };
      }

      const { mpBaseUrl, accessToken } = getAuthFromExtra(extra);
      const sample = await mpApiRequest(mpBaseUrl, accessToken, "GET",
        `/tables/${encodeURIComponent(safeName)}`, { $top: 1 }
      ) as Record<string, unknown>[];

      if (sample.length === 0) {
        return { content: [{ type: "text" as const, text: `Table "${safeName}" exists but has no records.` }] };
      }

      const allowed = getAllowedTables("read");
      const columnNames = Object.keys(sample[0]);
      // MP returns the table's primary key as the first column. Treat the
      // first _ID column as the PK so we don't tag it as a foreign key.
      const primaryKey = columnNames.find((k) => k.endsWith("_ID"));
      const fields = columnNames.map((key) => {
        const value = sample[0][key];
        const type =
          value === null ? "null" :
          value instanceof Date ? "date" :
          Array.isArray(value) ? "array" :
          typeof value;

        const field: Record<string, unknown> = { name: key, type };
        if (key.endsWith("_ID") && key !== primaryKey) {
          field.fk_join_prefix = `${key}_Table`;
          const lookup = inferLookupTable(key, allowed);
          if (lookup) field.lookup_table = lookup;
        }
        return field;
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(fields, null, 2) }] };
    }
  );

  // ── query_table ──────────────────────────────────────────────────────────

  server.registerTool(
    "query_table",
    {
      title: "Query Table",
      description:
        "Low-level query tool. PREFER the domain tools (find_people, get_person_details, " +
        "search_groups, get_group_roster, search_events, get_event_attendance) and the " +
        "aggregation tools (count_rows, group_by_count) for common queries — they handle " +
        "FK joins, disambiguation, and counting correctly. Only use query_table for ad-hoc " +
        "queries those tools can't handle.\n\n" +
        "Use $select with FK joins (replace _ID with _ID_Table.ColumnName). " +
        "Prefix ambiguous columns with table name (e.g., Group_Participants.Start_Date, " +
        "Event_Participants.Participation_Status_ID, Contacts.Contact_ID). " +
        "Do NOT use DATEADD(), GETDATE(), or other SQL functions in $filter — use literal dates " +
        "like '2026-04-13' instead.\n\n" +
        "Returns up to 1000 records wrapped as " +
        "`{ data, row_count, has_more, next_skip }`. When `has_more` is true, re-issue " +
        "with `skip = next_skip` (or use count_rows if you only need a total).",
      inputSchema: {
        table: z.string().describe("The MP table name"),
        select: z.string().optional().describe("Comma-separated columns with FK joins"),
        filter: z.string().optional().describe("SQL WHERE clause"),
        orderby: z.string().optional().describe("Column(s) to sort by"),
        top: z.number().int().min(1).max(1000).optional().describe("Max records (default 1000)"),
        skip: z.number().int().min(0).optional().describe("Records to skip"),
        distinct: z.boolean().optional().describe("Distinct records only"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ table, select, filter, orderby, top, skip, distinct }, extra) => {
      console.log(`[tool] query_table called table=${table}`);
      try {
        const safeName = validatePathSegment(table, "table");
        if (!isTableAllowed(safeName, "read")) {
          const allowed = getAllowedTables("read");
          console.log(`[tool] query_table denied — ${safeName} not in allowlist`);
          return {
            content: [{ type: "text" as const, text: `Table "${safeName}" is not in the allowlist. Available tables: ${allowed.join(", ")}` }],
            isError: true,
          };
        }

        const { mpBaseUrl, accessToken } = getAuthFromExtra(extra);
        const effectiveTop = top ?? 1000;
        const effectiveSkip = skip ?? 0;
        const qs: Record<string, string | number | boolean | undefined> = {};
        if (select) qs["$select"] = select;
        if (filter) qs["$filter"] = filter;
        if (orderby) qs["$orderby"] = orderby;
        qs["$top"] = effectiveTop;
        if (effectiveSkip) qs["$skip"] = effectiveSkip;
        if (distinct) qs["$distinct"] = true;

        console.log(`[tool] query_table calling mpApiRequest for ${safeName}`);
        const data = await mpApiRequest(mpBaseUrl, accessToken, "GET",
          `/tables/${encodeURIComponent(safeName)}`, qs
        );
        const records = Array.isArray(data) ? data : [];
        const hasMore = records.length === effectiveTop;
        const response = {
          data: records,
          row_count: records.length,
          has_more: hasMore,
          next_skip: hasMore ? effectiveSkip + records.length : null,
        };
        console.log(`[tool] query_table returning records=${records.length} has_more=${hasMore}`);
        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (err) {
        console.error(`[tool] query_table threw:`, err);
        throw err;
      }
    }
  );

  // ── count_rows ───────────────────────────────────────────────────────────

  server.registerTool(
    "count_rows",
    {
      title: "Count Rows",
      description:
        "Return the number of rows in a table matching an optional filter. " +
        "Returns just `{ count: N }` instead of the rows themselves — use this " +
        "instead of query_table when you only need a total. Walks pages of " +
        "1000 rows server-side, capped at 50,000 rows; if the cap is hit, " +
        "the response includes `capped: true`.",
      inputSchema: {
        table: z.string().describe("The MP table name"),
        filter: z.string().optional().describe(
          "SQL WHERE clause. Same syntax as query_table.filter — use FK joins " +
          "like Contact_Status_ID_Table.Contact_Status='Active', and literal " +
          "ISO dates instead of DATEADD/GETDATE."
        ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ table, filter }, extra) => {
      console.log(`[tool] count_rows called table=${table}`);
      try {
        const safeName = validatePathSegment(table, "table");
        if (!isTableAllowed(safeName, "read")) {
          const allowed = getAllowedTables("read");
          return {
            content: [{ type: "text" as const, text: `Table "${safeName}" is not in the allowlist. Available tables: ${allowed.join(", ")}` }],
            isError: true,
          };
        }

        const { mpBaseUrl, accessToken } = getAuthFromExtra(extra);
        // Probe the first row to discover the primary key column. We use it
        // as the only $select to keep response payloads tiny while paging.
        const probe = await mpApiRequest(mpBaseUrl, accessToken, "GET",
          `/tables/${encodeURIComponent(safeName)}`, { $top: 1 }
        ) as Record<string, unknown>[];
        if (probe.length === 0) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ count: 0 }, null, 2) }] };
        }
        const idColumn = Object.keys(probe[0]).find((k) => k.endsWith("_ID")) ?? Object.keys(probe[0])[0];

        let total = 0;
        let pages = 0;
        let capped = false;
        for (let skip = 0; pages < COUNT_MAX_PAGES; skip += COUNT_PAGE_SIZE) {
          const qs: Record<string, string | number | undefined> = {
            $select: idColumn,
            $top: COUNT_PAGE_SIZE,
          };
          if (skip) qs["$skip"] = skip;
          if (filter) qs["$filter"] = filter;
          const page = await mpApiRequest(mpBaseUrl, accessToken, "GET",
            `/tables/${encodeURIComponent(safeName)}`, qs
          ) as Record<string, unknown>[];
          total += page.length;
          pages += 1;
          if (page.length < COUNT_PAGE_SIZE) break;
          if (pages === COUNT_MAX_PAGES) {
            capped = true;
            break;
          }
        }

        const result: Record<string, unknown> = { count: total };
        if (capped) result.capped = true;
        console.log(`[tool] count_rows returning count=${total} pages=${pages} capped=${capped}`);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error(`[tool] count_rows threw:`, err);
        throw err;
      }
    }
  );

  // ── group_by_count ───────────────────────────────────────────────────────

  server.registerTool(
    "group_by_count",
    {
      title: "Group By Count",
      description:
        "Count rows grouped by a column. Returns `{ groups: [{ value, count }, ...], total }`. " +
        "Implemented by selecting just the group-by column server-side and " +
        "counting in-memory, so payload to the model is tiny regardless of row count. " +
        "Capped at 50,000 matching rows; if the cap is hit, the response includes `capped: true`.\n\n" +
        "Use FK joins in `group_by` to bucket by human-readable values, e.g.:\n" +
        "  group_by='Engagement_Level_ID_Table.Engagement_Level'\n" +
        "  group_by='Contact_Status_ID_Table.Contact_Status'",
      inputSchema: {
        table: z.string().describe("The MP table name"),
        group_by: z.string().describe(
          "Column to group by. Use an FK join (e.g., Gender_ID_Table.Gender) " +
          "to bucket by the lookup label rather than the raw ID."
        ),
        filter: z.string().optional().describe("SQL WHERE clause (same syntax as query_table.filter)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ table, group_by, filter }, extra) => {
      console.log(`[tool] group_by_count called table=${table} group_by=${group_by}`);
      try {
        const safeName = validatePathSegment(table, "table");
        if (!isTableAllowed(safeName, "read")) {
          const allowed = getAllowedTables("read");
          return {
            content: [{ type: "text" as const, text: `Table "${safeName}" is not in the allowlist. Available tables: ${allowed.join(", ")}` }],
            isError: true,
          };
        }

        const { mpBaseUrl, accessToken } = getAuthFromExtra(extra);
        // The grouping column may be an FK join like "Foo_ID_Table.Bar" — the
        // value comes back from MP keyed by just the trailing column name.
        const responseKey = group_by.includes(".")
          ? group_by.split(".").pop()!
          : group_by;

        const counts = new Map<string, number>();
        let total = 0;
        let pages = 0;
        let capped = false;
        for (let skip = 0; pages < COUNT_MAX_PAGES; skip += COUNT_PAGE_SIZE) {
          const qs: Record<string, string | number | undefined> = {
            $select: group_by,
            $top: COUNT_PAGE_SIZE,
          };
          if (skip) qs["$skip"] = skip;
          if (filter) qs["$filter"] = filter;
          const page = await mpApiRequest(mpBaseUrl, accessToken, "GET",
            `/tables/${encodeURIComponent(safeName)}`, qs
          ) as Record<string, unknown>[];
          for (const row of page) {
            const raw = row[responseKey];
            const key = raw === null || raw === undefined ? "(null)" : String(raw);
            counts.set(key, (counts.get(key) ?? 0) + 1);
            total += 1;
          }
          pages += 1;
          if (page.length < COUNT_PAGE_SIZE) break;
          if (pages === COUNT_MAX_PAGES) {
            capped = true;
            break;
          }
        }

        const groups = [...counts.entries()]
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => b.count - a.count);
        const result: Record<string, unknown> = { groups, total };
        if (capped) result.capped = true;
        console.log(`[tool] group_by_count returning buckets=${groups.length} total=${total} capped=${capped}`);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error(`[tool] group_by_count threw:`, err);
        throw err;
      }
    }
  );

  // ── birth_date_range_for_age ─────────────────────────────────────────────

  server.registerTool(
    "birth_date_range_for_age",
    {
      title: "Birth Date Range for Age",
      description:
        "Compute the Date_of_Birth range that corresponds to an age range " +
        "as of today (or a specified anchor date). Returns the inclusive " +
        "min/max ISO dates plus a ready-to-use SQL filter snippet. Use this " +
        "instead of computing date math by hand — `Age` is a calculated " +
        "column and isn't filterable directly.",
      inputSchema: {
        min_age: z.number().int().min(0).max(150).optional().describe("Minimum age (inclusive). Omit for no lower bound."),
        max_age: z.number().int().min(0).max(150).optional().describe("Maximum age (inclusive). Omit for no upper bound."),
        as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Anchor date YYYY-MM-DD (default: today UTC)."),
        column: z.string().optional().describe("Column name to use in the filter snippet (default: Date_of_Birth)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ min_age, max_age, as_of, column }) => {
      if (min_age === undefined && max_age === undefined) {
        return {
          content: [{ type: "text" as const, text: "Provide at least one of min_age or max_age." }],
          isError: true,
        };
      }
      if (min_age !== undefined && max_age !== undefined && min_age > max_age) {
        return {
          content: [{ type: "text" as const, text: `min_age (${min_age}) cannot be greater than max_age (${max_age}).` }],
          isError: true,
        };
      }

      const anchor = as_of ?? new Date().toISOString().slice(0, 10);
      const [yStr, mStr, dStr] = anchor.split("-");
      const y = Number(yStr), m = Number(mStr), d = Number(dStr);
      const pad = (n: number) => String(n).padStart(2, "0");
      const fmt = (yy: number, mm: number, dd: number) => `${yy}-${pad(mm)}-${pad(dd)}`;

      // Someone with age N as of the anchor was born on or before
      // (anchor - N years), and after (anchor - (N+1) years).
      // → max DOB for age >= N is (anchor - N years)
      // → min DOB for age <= N is (anchor - (N+1) years) + 1 day
      const column_ = column ?? "Date_of_Birth";
      const filterParts: string[] = [];
      let dob_max: string | null = null;
      let dob_min: string | null = null;

      if (min_age !== undefined) {
        dob_max = fmt(y - min_age, m, d);
        filterParts.push(`${column_} <= '${dob_max}'`);
      }
      if (max_age !== undefined) {
        // Born strictly after (anchor - (max_age + 1) years).
        // Use a strict > on that boundary date to capture "still age max_age".
        dob_min = fmt(y - (max_age + 1), m, d);
        filterParts.push(`${column_} > '${dob_min}'`);
      }
      filterParts.push(`${column_} IS NOT NULL`);

      const result = {
        as_of: anchor,
        min_age: min_age ?? null,
        max_age: max_age ?? null,
        date_of_birth_min_exclusive: dob_min,
        date_of_birth_max_inclusive: dob_max,
        filter: filterParts.join(" AND "),
        notes:
          "Use the `filter` snippet directly with query_table / count_rows / group_by_count. " +
          "Add `Date_of_Death IS NULL` if you want to exclude deceased contacts.",
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── get_record ───────────────────────────────────────────────────────────

  server.registerTool(
    "get_record",
    {
      title: "Get Record",
      description:
        "Get a single record from a Ministry Platform table by its ID.",
      inputSchema: {
        table: z.string().describe("The MP table name"),
        id: z.number().int().positive().describe("The record's primary key ID"),
        select: z.string().optional().describe("Comma-separated columns to return"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ table, id, select }, extra) => {
      const safeName = validatePathSegment(table, "table");
      if (!isTableAllowed(safeName, "read")) {
        const allowed = getAllowedTables("read");
        return {
          content: [{ type: "text" as const, text: `Table "${safeName}" is not in the allowlist. Available tables: ${allowed.join(", ")}` }],
          isError: true,
        };
      }

      const { mpBaseUrl, accessToken } = getAuthFromExtra(extra);
      const qs: Record<string, string | undefined> = {};
      if (select) qs["$select"] = select;

      const data = await mpApiRequest(mpBaseUrl, accessToken, "GET",
        `/tables/${encodeURIComponent(safeName)}/${id}`, qs
      );

      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
