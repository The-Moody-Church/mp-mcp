import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getAllowedTables, isTableAllowed } from "./config.js";
import { mpApiRequest } from "./transport.js";
import { validatePathSegment } from "./utils/filter-sanitize.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Create and configure the MCP server with all tools registered.
 *
 * Each tool callback receives the user's access token and MP base URL
 * via the extra.authInfo property, set by the HTTP handler.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "ministry-platform",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // ── list_tables ──────────────────────────────────────────────────────────

  server.registerTool(
    "list_tables",
    {
      title: "List Tables",
      description:
        "List all Ministry Platform tables available through this MCP server. " +
        "Returns table names and their read/write permissions.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (extra: Extra) => {
      const tables = getAllowedTables("read");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              tables.map((t) => ({
                table: t,
                read: isTableAllowed(t, "read"),
                write: isTableAllowed(t, "write"),
              })),
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── describe_table ───────────────────────────────────────────────────────

  server.registerTool(
    "describe_table",
    {
      title: "Describe Table",
      description:
        "Get the field names and types for a Ministry Platform table. " +
        "Query the table with $top=0 to get column metadata from the response.",
      inputSchema: {
        table: z
          .string()
          .describe("The MP table name (e.g., 'Contacts', 'Events')"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async ({ table }, extra) => {
      const safeName = validatePathSegment(table, "table");

      if (!isTableAllowed(safeName, "read")) {
        const allowed = getAllowedTables("read");
        return {
          content: [
            {
              type: "text",
              text: `Table "${safeName}" is not in the allowlist. Available tables: ${allowed.join(", ")}`,
            },
          ],
          isError: true,
        };
      }

      const { mpBaseUrl, accessToken } = getAuthFromExtra(extra);
      const data = await mpApiRequest(
        mpBaseUrl,
        accessToken,
        "GET",
        `/tables/${encodeURIComponent(safeName)}`,
        { $top: 0 }
      );

      // MP returns an empty array for $top=0, but the column names are
      // available by querying 1 row instead
      const sample = (await mpApiRequest(
        mpBaseUrl,
        accessToken,
        "GET",
        `/tables/${encodeURIComponent(safeName)}`,
        { $top: 1 }
      )) as Record<string, unknown>[];

      if (sample.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Table "${safeName}" exists but has no records to infer fields from.`,
            },
          ],
        };
      }

      const fields = Object.keys(sample[0]).map((key) => ({
        name: key,
        sampleValue: sample[0][key],
        type: typeof sample[0][key],
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(fields, null, 2),
          },
        ],
      };
    }
  );

  // ── query_table ──────────────────────────────────────────────────────────

  server.registerTool(
    "query_table",
    {
      title: "Query Table",
      description:
        "Query records from a Ministry Platform table. Supports $filter (SQL WHERE syntax), " +
        "$select (columns), $orderby, $top, $skip, and FK joins (e.g., Contact_ID_Table.Display_Name). " +
        "Filter syntax uses SQL conventions: LIKE, IN(), IS NULL, GETDATE(), boolean AND/OR. " +
        "Single quotes in values must be doubled (e.g., O''Brien). " +
        "Returns up to 1000 records by default.",
      inputSchema: {
        table: z
          .string()
          .describe("The MP table name (e.g., 'Contacts', 'Events')"),
        select: z
          .string()
          .optional()
          .describe(
            "Comma-separated column names to return. Supports FK joins like Contact_ID_Table.Display_Name"
          ),
        filter: z
          .string()
          .optional()
          .describe(
            "SQL WHERE clause filter (e.g., \"Display_Name LIKE '%Smith%'\" or \"Event_Start_Date > GETDATE()\")"
          ),
        orderby: z
          .string()
          .optional()
          .describe(
            "Column(s) to sort by (e.g., 'Display_Name' or 'Event_Start_Date DESC')"
          ),
        top: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Maximum number of records to return (1-1000, default 1000)"),
        skip: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Number of records to skip (for pagination)"),
        distinct: z
          .boolean()
          .optional()
          .describe("Return only distinct records"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async ({ table, select, filter, orderby, top, skip, distinct }, extra) => {
      const safeName = validatePathSegment(table, "table");

      if (!isTableAllowed(safeName, "read")) {
        const allowed = getAllowedTables("read");
        return {
          content: [
            {
              type: "text",
              text: `Table "${safeName}" is not in the allowlist. Available tables: ${allowed.join(", ")}`,
            },
          ],
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

      const data = await mpApiRequest(
        mpBaseUrl,
        accessToken,
        "GET",
        `/tables/${encodeURIComponent(safeName)}`,
        qs
      );

      const records = data as unknown[];
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(records, null, 2),
          },
        ],
      };
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
        table: z
          .string()
          .describe("The MP table name (e.g., 'Contacts', 'Events')"),
        id: z
          .number()
          .int()
          .describe("The record's primary key ID"),
        select: z
          .string()
          .optional()
          .describe("Comma-separated column names to return"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async ({ table, id, select }, extra) => {
      const safeName = validatePathSegment(table, "table");

      if (!isTableAllowed(safeName, "read")) {
        const allowed = getAllowedTables("read");
        return {
          content: [
            {
              type: "text",
              text: `Table "${safeName}" is not in the allowlist. Available tables: ${allowed.join(", ")}`,
            },
          ],
          isError: true,
        };
      }

      const { mpBaseUrl, accessToken } = getAuthFromExtra(extra);

      const qs: Record<string, string | undefined> = {};
      if (select) qs["$select"] = select;

      const data = await mpApiRequest(
        mpBaseUrl,
        accessToken,
        "GET",
        `/tables/${encodeURIComponent(safeName)}/${id}`,
        qs
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );

  return server;
}

/**
 * Extract auth info from the MCP extra context.
 * The bearerAuth middleware sets req.auth (AuthInfo), which the transport
 * passes through as extra.authInfo. Our verifyAccessToken stores mpBaseUrl
 * and accessToken inside AuthInfo.extra.
 */
function getAuthFromExtra(extra: Record<string, unknown>): {
  mpBaseUrl: string;
  accessToken: string;
} {
  const authInfo = (extra as { authInfo?: { token?: string; extra?: { mpBaseUrl?: string; accessToken?: string } } })
    .authInfo;
  const mpBaseUrl = authInfo?.extra?.mpBaseUrl;
  const accessToken = authInfo?.extra?.accessToken || authInfo?.token;
  if (!mpBaseUrl || !accessToken) {
    throw new Error("Not authenticated — please log in first");
  }
  return { mpBaseUrl, accessToken };
}
