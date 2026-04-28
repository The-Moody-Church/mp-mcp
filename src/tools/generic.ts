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
// Curated FK metadata: column name → { lookup_table, label_column }.
// Authoritative for the columns it covers — the model gets the canonical
// label column instead of guessing (e.g., Metric_ID → Metric_Title, not
// Metric_Name; Participant_Engagement_ID → Engagement_Level, not
// Participant_Engagement). Also covers non-_ID FK columns (Primary_Contact,
// Parent_Group, etc.) that wouldn't otherwise be flagged as foreign keys
// by the _ID-suffix heuristic. Columns not in the catalog fall back to
// inferLookupTable for _ID-suffixed names.
const FK_CATALOG: Record<string, { lookup_table: string; label_column: string }> = {
  Address_ID: { lookup_table: "Addresses", label_column: "City" },
  Building_ID: { lookup_table: "Buildings", label_column: "Building_Name" },
  Care_Person: { lookup_table: "Contacts", label_column: "Display_Name" },
  Congregation_ID: { lookup_table: "Congregations", label_column: "Congregation_Name" },
  Contact_ID: { lookup_table: "Contacts", label_column: "Display_Name" },
  Contact_Status_ID: { lookup_table: "Contact_Statuses", label_column: "Contact_Status" },
  Descended_From: { lookup_table: "Groups", label_column: "Group_Name" },
  Event_ID: { lookup_table: "Events", label_column: "Event_Title" },
  Event_Type_ID: { lookup_table: "Event_Types", label_column: "Event_Type" },
  Gender_ID: { lookup_table: "Genders", label_column: "Gender" },
  Group_ID: { lookup_table: "Groups", label_column: "Group_Name" },
  Group_Role_ID: { lookup_table: "Group_Roles", label_column: "Role_Title" },
  Group_Focus_ID: { lookup_table: "Group_Focuses", label_column: "Group_Focus" },
  Group_Type_ID: { lookup_table: "Group_Types", label_column: "Group_Type" },
  Household_ID: { lookup_table: "Households", label_column: "Household_Name" },
  Household_Position_ID: { lookup_table: "Household_Positions", label_column: "Household_Position" },
  Household_Source_ID: { lookup_table: "Household_Sources", label_column: "Household_Source" },
  Life_Stage_ID: { lookup_table: "Life_Stages", label_column: "Life_Stage" },
  Marital_Status_ID: { lookup_table: "Marital_Statuses", label_column: "Marital_Status" },
  Meeting_Day_ID: { lookup_table: "Meeting_Days", label_column: "Meeting_Day" },
  Meeting_Frequency_ID: { lookup_table: "Meeting_Frequencies", label_column: "Meeting_Frequency" },
  Member_Status_ID: { lookup_table: "Member_Statuses", label_column: "Member_Status" },
  Metric_ID: { lookup_table: "Metrics", label_column: "Metric_Title" },
  Milestone_ID: { lookup_table: "Milestones", label_column: "Milestone_Title" },
  Ministry_ID: { lookup_table: "Ministries", label_column: "Ministry_Name" },
  Offsite_Meeting_Address: { lookup_table: "Addresses", label_column: "City" },
  Parent_Group: { lookup_table: "Groups", label_column: "Group_Name" },
  Participant_ID: { lookup_table: "Participants", label_column: "Display_Name" },
  Participant_Engagement_ID: { lookup_table: "Participant_Engagement", label_column: "Engagement_Level" },
  Participant_Type_ID: { lookup_table: "Participant_Types", label_column: "Participant_Type" },
  Participation_Status_ID: { lookup_table: "Participation_Statuses", label_column: "Participation_Status" },
  Prefix_ID: { lookup_table: "Prefixes", label_column: "Prefix" },
  Primary_Contact: { lookup_table: "Contacts", label_column: "Display_Name" },
  Priority_ID: { lookup_table: "Priorities", label_column: "Priority_Name" },
  Program_ID: { lookup_table: "Programs", label_column: "Program_Name" },
  Program_Type_ID: { lookup_table: "Program_Types", label_column: "Program_Type" },
  Room_ID: { lookup_table: "Rooms", label_column: "Room_Name" },
  Service_Type_ID: { lookup_table: "Service_Types", label_column: "Service_Type" },
  Suffix_ID: { lookup_table: "Suffixes", label_column: "Suffix" },
};

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
        "Foreign-key columns include `fk_join_prefix` (use as " +
        "`{prefix}.{ColumnOnLookupTable}` in $select), `lookup_table`, and — " +
        "when known — `label_column` (the canonical human-readable column on " +
        "the lookup table; use this directly with the prefix to avoid guessing). " +
        "Both _ID-suffixed columns and known non-_ID FKs (e.g., Primary_Contact, " +
        "Parent_Group) are flagged.",
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
        if (key === primaryKey) return field;

        // Catalog hit beats inference — covers known label columns and
        // non-_ID FKs (Primary_Contact, Parent_Group, ...).
        const catalogEntry = FK_CATALOG[key];
        if (catalogEntry) {
          field.fk_join_prefix = `${key}_Table`;
          field.lookup_table = catalogEntry.lookup_table;
          field.label_column = catalogEntry.label_column;
          return field;
        }

        // Fallback for _ID-suffixed columns we haven't catalogued: emit the
        // join prefix and best-guess lookup table, but no label_column —
        // signaling to the caller that the lookup-side column is unknown.
        if (key.endsWith("_ID")) {
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
        "Count rows grouped by a column. " +
        "For a single-hop FK join (`<col>_ID_Table.<label>`) returns `{ groups: [{ id, label, count }, ...], total }` — " +
        "the underlying ID is selected alongside the label so labels can be cross-checked against IDs and " +
        "ambiguous label columns can't silently merge buckets. For other columns returns `{ groups: [{ value, count }, ...], total }`. " +
        "Implemented by selecting just the group-by column(s) server-side and counting in-memory, so the payload " +
        "to the model is tiny regardless of row count. Capped at 50,000 matching rows; if the cap is hit, the " +
        "response includes `capped: true`.\n\n" +
        "Use FK joins in `group_by` to bucket by human-readable values, e.g.:\n" +
        "  group_by='Engagement_Level_ID_Table.Engagement_Level'\n" +
        "  group_by='Contact_Status_ID_Table.Contact_Status'",
      inputSchema: {
        table: z.string().describe("The MP table name"),
        group_by: z.string().describe(
          "Column to group by. Use an FK join (e.g., Gender_ID_Table.Gender) " +
          "to bucket by the lookup label rather than the raw ID — the ID is " +
          "returned alongside the label so the result is unambiguous."
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
        // Detect a single-hop FK join: "Foo_ID_Table.Bar". Bucketing by the
        // FK ID (instead of the label) defends against label-column collisions
        // where MP resolves the join to the wrong source table — labels can
        // collide silently, IDs can't.
        const fkMatch = group_by.match(/^([A-Za-z0-9_]+)_ID_Table\.([A-Za-z0-9_]+)$/);
        const fkIdCol = fkMatch ? `${fkMatch[1]}_ID` : null;
        const labelKey = fkMatch
          ? fkMatch[2]
          : group_by.includes(".") ? group_by.split(".").pop()! : group_by;
        const selectFields = fkIdCol ? `${fkIdCol},${group_by}` : group_by;

        // For FK mode: id → { label, count }. Bucket key is the ID (or
        // "(null)" when the FK is missing); label is captured from the first
        // row seen for that ID.
        const fkBuckets = new Map<string, { id: number | null; label: unknown; count: number }>();
        // For non-FK mode: existing label-keyed counts.
        const counts = new Map<string, number>();
        let total = 0;
        let pages = 0;
        let capped = false;
        for (let skip = 0; pages < COUNT_MAX_PAGES; skip += COUNT_PAGE_SIZE) {
          const qs: Record<string, string | number | undefined> = {
            $select: selectFields,
            $top: COUNT_PAGE_SIZE,
          };
          if (skip) qs["$skip"] = skip;
          if (filter) qs["$filter"] = filter;
          const page = await mpApiRequest(mpBaseUrl, accessToken, "GET",
            `/tables/${encodeURIComponent(safeName)}`, qs
          ) as Record<string, unknown>[];
          for (const row of page) {
            if (fkIdCol) {
              const idRaw = row[fkIdCol];
              const id = typeof idRaw === "number" ? idRaw : null;
              const key = id === null ? "(null)" : String(id);
              const existing = fkBuckets.get(key);
              if (existing) {
                existing.count += 1;
              } else {
                fkBuckets.set(key, { id, label: row[labelKey] ?? null, count: 1 });
              }
            } else {
              const raw = row[labelKey];
              const key = raw === null || raw === undefined ? "(null)" : String(raw);
              counts.set(key, (counts.get(key) ?? 0) + 1);
            }
            total += 1;
          }
          pages += 1;
          if (page.length < COUNT_PAGE_SIZE) break;
          if (pages === COUNT_MAX_PAGES) {
            capped = true;
            break;
          }
        }

        const groups = fkIdCol
          ? [...fkBuckets.values()]
              .map(({ id, label, count }) => ({ id, label, count }))
              .sort((a, b) => b.count - a.count)
          : [...counts.entries()]
              .map(([value, count]) => ({ value, count }))
              .sort((a, b) => b.count - a.count);
        const result: Record<string, unknown> = { groups, total };
        if (capped) result.capped = true;
        console.log(`[tool] group_by_count returning buckets=${groups.length} total=${total} capped=${capped} fk=${!!fkIdCol}`);
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
