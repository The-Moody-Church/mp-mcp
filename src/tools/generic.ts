import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAllowedTables, isTableAllowed } from "../config.js";
import { mpApiRequest } from "../transport.js";
import { validatePathSegment } from "../utils/filter-sanitize.js";
import { getAuthFromExtra } from "./auth.js";

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
      const tables = getAllowedTables("read");
      return {
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
    }
  );

  // ── describe_table ───────────────────────────────────────────────────────

  server.registerTool(
    "describe_table",
    {
      title: "Describe Table",
      description:
        "Get the field names and types for a Ministry Platform table.",
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

      const fields = Object.keys(sample[0]).map((key) => ({
        name: key,
        sampleValue: sample[0][key],
        type: typeof sample[0][key],
      }));

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
        "search_groups, get_group_roster, search_events, get_event_attendance) for common queries — " +
        "they handle FK joins and disambiguation correctly. Only use query_table for ad-hoc queries " +
        "those tools can't handle.\n\n" +
        "Use $select with FK joins (replace _ID with _ID_Table.ColumnName). " +
        "Prefix ambiguous columns with table name (e.g., Group_Participants.Start_Date, " +
        "Event_Participants.Participation_Status_ID, Contacts.Contact_ID). " +
        "Do NOT use DATEADD(), GETDATE(), or other SQL functions in $filter — use literal dates " +
        "like '2026-04-13' instead. Returns up to 1000 records.",
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
      const safeName = validatePathSegment(table, "table");
      if (!isTableAllowed(safeName, "read")) {
        const allowed = getAllowedTables("read");
        return {
          content: [{ type: "text" as const, text: `Table "${safeName}" is not in the allowlist. Available tables: ${allowed.join(", ")}` }],
          isError: true,
        };
      }

      const { mpBaseUrl, accessToken } = getAuthFromExtra(extra);
      const qs: Record<string, string | number | boolean | undefined> = {};
      if (select) qs["$select"] = select;
      if (filter) qs["$filter"] = filter;
      if (orderby) qs["$orderby"] = orderby;
      if (top !== undefined) qs["$top"] = top;
      if (skip !== undefined) qs["$skip"] = skip;
      if (distinct) qs["$distinct"] = true;

      const data = await mpApiRequest(mpBaseUrl, accessToken, "GET",
        `/tables/${encodeURIComponent(safeName)}`, qs
      );

      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
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
        id: z.number().int().describe("The record's primary key ID"),
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
