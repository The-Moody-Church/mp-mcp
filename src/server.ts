import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getAllowedTables, isTableAllowed } from "./config.js";
import { mpApiRequest } from "./transport.js";
import { validatePathSegment } from "./utils/filter-sanitize.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// ── Presentation instructions (sent to Claude as server-level instructions) ──

const PRESENTATION_INSTRUCTIONS = `
## Data Presentation Rules

When presenting Ministry Platform data to users, follow these rules:

### MP Data Model
Ministry Platform has five core record types. Understanding these helps you navigate the data:

- **Contact** — The hub record. Every person has one. Holds name, birthday, phone, email. The Contacts table is your starting point for looking up people.
- **Household** — Groups contacts at a shared address. Every contact belongs to a household. Access address via Household_ID FK join.
- **Participant** — Tracks involvement in groups and events. Not everyone has one — only people active in church life. Access via Participant_Record FK from Contacts.
- **Donor** — Tracks giving. Only people who have donated. Access via Donor_Record FK from Contacts. Treat this data with discretion.
- **User** — Platform login accounts (dp_Users table). Only staff/volunteers with system access. Has Contact_ID FK back to Contacts.

Key navigation patterns:
- Person lookup: Start with Contacts table, use Display_Name or First_Name/Last_Name to find them
- Address: Contacts → Household_ID_Table_Address_ID_Table.[Address_Line_1], .City, .[State/Region], .[Postal_Code]
- Group membership: Query Group_Participants filtered by Contact_ID or Group_ID, join Group_ID_Table.Group_Name
- Event attendance: Query Event_Participants filtered by Contact_ID or Event_ID, join Event_ID_Table.Event_Title
- Membership status: Contacts → Participant_Record_Table_Member_Status_ID_Table.Member_Status

### 1. No Raw IDs
Omit internal ID columns (Contact_ID, Participant_ID, Household_ID, Event_ID, Group_ID, User_ID, etc.) unless the user explicitly asks for them. Humans care about names, dates, and descriptions — not database keys.

### 2. Resolve Lookup Values via FK Joins
Many columns store numeric foreign key IDs (e.g., Marital_Status_ID, Contact_Status_ID, Gender_ID). NEVER guess what these numbers mean — use FK joins in $select to get the human-readable text.

**FK join syntax:** Replace the column's _ID suffix with _ID_Table.{ColumnName}
- Marital_Status_ID → Marital_Status_ID_Table.Marital_Status
- Contact_Status_ID → Contact_Status_ID_Table.Contact_Status
- Gender_ID → Gender_ID_Table.Gender
- Household_Position_ID → Household_Position_ID_Table.Household_Position
- Congregation_ID → Congregation_ID_Table.Congregation_Name
- Group_Type_ID → Group_Type_ID_Table.Group_Type
- Group_Role_ID → Group_Role_ID_Table.Role_Title
- Member_Status_ID → Member_Status_ID_Table.Member_Status
- Event_Type_ID → Event_Type_ID_Table.Event_Type
- Program_ID → Program_ID_Table.Program_Name
- Participation_Status_ID → Participation_Status_ID_Table.Participation_Status
- Room_ID → Room_ID_Table.Room_Name

**Chained FK joins** traverse multiple relationships with underscores:
- Household_ID_Table_Address_ID_Table.City (Contact → Household → Address)
- Participant_Record_Table_Member_Status_ID_Table.Member_Status (Contact → Participant → Member Status)
- Contact_ID_Table.Display_Name (any table with Contact_ID FK)
- Event_ID_Table.Event_Title (any table with Event_ID FK)

Use square brackets for column names containing special characters: [State/Region], [Address_Line_1]

### 3. Prefer $select with FK Joins Over Raw Queries
When querying a table, use $select to request only the columns you need, and include FK joins for any ID columns. For example, to look up a contact:

Good: $select=Display_Name, Nickname, Date_of_Birth, Gender_ID_Table.Gender, Marital_Status_ID_Table.Marital_Status, Contact_Status_ID_Table.Contact_Status, Email_Address, Mobile_Phone, Congregation_ID_Table.Congregation_Name, Household_Position_ID_Table.Household_Position

Bad: No $select (returns all columns as raw IDs)

### 4. Donation and Giving Data
NEVER mention donations, giving history, donor status, pledge information, or any financial data unless the user explicitly asks about it. This includes:
- Do not mention that a person has (or doesn't have) a Donor_Record
- Do not mention donation amounts, frequencies, or trends
- Do not reference fund names, pledge campaigns, or giving programs
- Do not editorialize about giving levels or patterns
When the user does explicitly ask about giving data, keep responses factual and concise. Treat all financial information as confidential.

### 5. Contact Information
When presenting a person, focus on: name, contact info (email, phone), engagement (groups, events, participation), and status. This is more useful than raw database metadata.

### 6. Attendance Data
Attendance is tracked in two different places depending on the event type:

- **Individual attendance** (check-in, small groups, classes): Stored in Event_Participants. A person attended if their Participation_Status_ID is 4 (Attended) or 5 (Checked In). Query Event_Participants filtered by Participation_Status_ID IN (4,5) and join Event_ID_Table.Event_Title, Participant_ID → Contact_ID_Table.Display_Name.

- **Aggregate attendance** (Sunday services, large gatherings): Stored in Event_Metrics. Look for metrics with a type of "Headcount" or "In Person" (join Metric_ID_Table.Metric_Name). The Numerical_Value field has the count. These events don't track who specifically attended — just total numbers.

### 6. Table Schema Quick Reference

**Contacts** — The hub record. Key FK joins: Gender_ID → Genders, Marital_Status_ID → Marital_Statuses, Contact_Status_ID → Contact_Statuses, Household_ID → Households, Household_Position_ID → Household_Positions, Participant_Record → Participants, Industry_ID → Industries, Occupation_ID → Occupations, User_Account → dp_Users. Key fields: Display_Name, First_Name, Last_Name, Nickname, Date_of_Birth, Email_Address, Mobile_Phone, Company_Phone. Note: Donor_Record FK exists but should not be queried unless the user explicitly asks about giving.

**Participants** — Involvement tracking. FK joins: Contact_ID → Contacts, Member_Status_ID → Member_Statuses, Participant_Type_ID → Participant_Types. Key fields: Participant_Start_Date, Participant_End_Date, Notes.

**Groups** — Small groups, classes, teams, etc. FK joins: Group_Type_ID → Group_Types, Ministry_ID → Ministries, Congregation_ID → Congregations, Primary_Contact → Contacts. Key fields: Group_Name, Description, Start_Date, End_Date, Meeting_Time.

**Group_Participants** — Who's in which group. FK joins: Group_ID → Groups, Participant_ID → Participants, Group_Role_ID → Group_Roles. Key fields: Start_Date, End_Date, Notes. To find a person's groups: filter by Participant_ID and join Group_ID_Table.Group_Name, Group_Role_ID_Table.Role_Title.

**Events** — Services, classes, meetings. FK joins: Event_Type_ID → Event_Types, Program_ID → Programs, Congregation_ID → Congregations, Primary_Contact → Contacts. Key fields: Event_Title, Event_Start_Date, Event_End_Date, Description, Cancelled.

**Event_Participants** — Attendance/registration. FK joins: Event_ID → Events, Participant_ID → Participants, Participation_Status_ID → Participation_Statuses, Room_ID → Rooms. Key fields: Time_In, Time_Out, Notes.

**Contact_Log** — Notes and interactions. FK joins: Contact_ID → Contacts, Contact_Log_Type_ID → Contact_Log_Types, Made_By → dp_Users. Key fields: Contact_Date, Notes.

**Background_Checks** — Clearances. FK joins: Contact_ID → Contacts, Background_Check_Type_ID → Background_Check_Types, Background_Check_Status_ID → Background_Check_Statuses. Key fields: Background_Check_Submitted, Background_Check_Returned, All_Clear.

**Rooms** — Physical spaces. FK joins: Building_ID → Buildings. Key fields: Room_Name, Room_Number, Maximum_Capacity, Bookable.

**Programs** — Organizational programs. FK joins: Ministry_ID → Ministries, Congregation_ID → Congregations, Primary_Contact → Contacts. Key fields: Program_Name, Start_Date, End_Date.

**Ministries** — Ministry departments. FK joins: Primary_Contact → Contacts, Parent_Ministry → Ministries, Leadership_Team → Groups. Key fields: Ministry_Name, Description.
`;

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
      instructions: PRESENTATION_INSTRUCTIONS,
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
        "Query records from a Ministry Platform table. Returns up to 1000 records by default.\n\n" +
        "IMPORTANT: Always use $select with FK joins to get human-readable values instead of raw IDs. " +
        "FK join syntax: replace _ID with _ID_Table.ColumnName (e.g., Marital_Status_ID_Table.Marital_Status, " +
        "Contact_ID_Table.Display_Name). Chain with underscores for multi-hop: " +
        "Household_ID_Table_Address_ID_Table.City. Use square brackets for special chars: [State/Region].\n\n" +
        "$filter uses SQL WHERE syntax: LIKE, IN(), IS NULL, GETDATE(), AND/OR. " +
        "Single quotes in values must be doubled (O''Brien). FK joins work in filters too.",
      inputSchema: {
        table: z
          .string()
          .describe("The MP table name (e.g., 'Contacts', 'Events')"),
        select: z
          .string()
          .optional()
          .describe(
            "Comma-separated columns. ALWAYS include FK joins for ID columns to get readable text: " +
            "e.g., Display_Name, Gender_ID_Table.Gender, Marital_Status_ID_Table.Marital_Status, " +
            "Contact_Status_ID_Table.Contact_Status, Email_Address. " +
            "Chain joins: Household_ID_Table_Address_ID_Table.City. Brackets for special chars: [State/Region]"
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
        "Get a single record from a Ministry Platform table by its ID. " +
        "Use $select with FK joins to get human-readable values (e.g., " +
        "Marital_Status_ID_Table.Marital_Status instead of raw Marital_Status_ID).",
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
