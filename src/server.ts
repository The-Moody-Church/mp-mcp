import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { registerPeopleTools } from "./tools/people.js";
import { registerGroupTools } from "./tools/groups.js";
import { registerEventTools } from "./tools/events.js";
import { registerGenericTools } from "./tools/generic.js";
import { isToolLoggingEnabled, logToolInvocation } from "./utils/tool-logger.js";

// ── Presentation instructions (sent to Claude as server-level instructions) ──

function buildDomainConventions(config: AppConfig): string {
  if (!config.memberFilter) {
    return `### Domain Conventions

- **"member" / "members"**: no canonical definition is configured for this church. Ask the user how they identify members before guessing — different MP deployments use Member_Status_ID, Participant_Type_ID, or custom fields.
`;
  }
  return `### Domain Conventions

**"member" / "members"** at this church: filter with EXACTLY \`${config.memberFilter}\`. This is the operator-configured authoritative definition for this deployment. Apply it literally and as your FIRST move when the user mentions members — do not preface with a describe_table or a status enumeration to "see what's available", do not run a query_table on the lookup table to broaden the value list, do not start with Participant_Type.

Treat the filter as opaque and final:
- Apply the operator-configured value EXACTLY. If it says \`= 1\`, use \`= 1\` — never \`IN (1, ...)\`, never expanded to other "member-flavored" statuses, never narrowed.
- Do not substitute Participant_Type-based filters, even if the user's tenant has a "Member" Participant_Type or types that look member-like.
- Do not invent columns like \`Membership_Status_ID\`. The configured column is the only one to use.
- If the user explicitly asks for a different definition (e.g. "include Associate members too"), apply their override on top of this filter, but say so out loud.

Standard MP places membership-status columns on the **Participants** table (not Contacts). Apply the filter where it lives:
- Querying Participants: \`${config.memberFilter}\` (verbatim).
- Querying Contacts: \`Participant_Record_Table.${extractColumnHint(config.memberFilter)}\`.
- Querying Event_Participants / Group_Participants: \`Participant_ID_Table.${extractColumnHint(config.memberFilter)}\`.

When a member-related question naturally targets Participants (engagement, milestones, group involvement), query Participants directly — do not detour through Contacts.
`;
}

// Pull the leading column name out of a filter snippet so we can show
// concrete chained examples in the domain-conventions block. Best-effort —
// matches the first identifier-like token; falls back to the raw filter if
// nothing matches.
function extractColumnHint(filter: string): string {
  const match = filter.match(/^[\s(]*([A-Za-z_][A-Za-z0-9_]*)/);
  return match ? `${match[1]} = ...` : filter;
}

function buildPresentationInstructions(config: AppConfig): string {
  return `
## Ministry Platform MCP Server — Instructions for Claude

You are connected to a church management system (Ministry Platform) via MCP tools.
Church staff use these tools from regular conversations — present data in plain language.

### Data Model
- **Contact** — The hub record. Every person has one. Start here for people lookups.
- **Household** — Shared address. Access via Household_ID FK from Contacts.
- **Participant** — Tracks group/event involvement. Access via Participant_Record FK from Contacts.
- **Donor** — Tracks giving. NEVER mention unless the user explicitly asks about donations.
- **User** — Platform login accounts (dp_Users).

### Presentation Rules
1. **No raw IDs anywhere user-facing** — Omit Contact_ID, Participant_ID, Group_ID, etc. from data tables AND from filter explanations. When showing a filter you applied, render it with the FK label resolved (e.g., \`Member_Status = 'Member'\`), not the raw ID equality (\`Member_Status_ID = 1\`). Use raw IDs only when the user explicitly asks. If you don't know a label, call describe_table on the lookup table or use group_by_count with the FK label join — don't fall back to showing the ID.
2. **Never guess lookup values** — Use FK joins or the domain tools which resolve them automatically. describe_table returns \`label_column\` for known FKs; use that exact column.
3. **Donations are confidential** — Never mention donor records, giving amounts, or pledge info unless explicitly asked.
4. **Focus on useful info** — Names, contact info, engagement, dates. Not database metadata.

${buildDomainConventions(config)}
### Domain Tools (preferred)
Use find_people, get_person_details, search_groups, get_group_roster, get_group_attendance_summary, search_events, get_event_attendance, get_schedule, and get_attendance_summary for common queries. These encode the correct FK joins and field names. In particular:
- get_schedule returns events for a date/range with rooms already joined — use it for "what's happening tomorrow / this Sunday" instead of stitching Events + Event_Rooms by hand.
- get_attendance_summary aggregates Event_Metrics for a recurring service (e.g., "Sunday Morning Service") into year/month/week buckets with metrics pivoted by Metric_Title — use it for "YoY service attendance" instead of pulling raw metric rows. get_event_attendance also pivots its metrics output, so each metric (In Person, Online, Headcount) appears as a key directly under "metrics".
- get_group_attendance_summary returns per-participant attendance counts for a group's meetings over one or two date windows, with optional drift-detection thresholds — use it for "who came consistently last fall but hasn't this spring" instead of pulling raw Event_Participants rows. Group meetings are discovered via Event_Rooms.Group_ID.

### Aggregation Tools (use these instead of fetching rows to count them)
- **count_rows(table, filter)** — returns just { count: N }. Use this any time you only need a total ("how many active members 65–69") instead of pulling rows with query_table.
- **group_by_count(table, group_by, filter)** — when group_by is an FK label join (e.g. Participant_Engagement_ID_Table.Engagement_Level), returns { groups: [{ id, label, count }, ...], total } so the underlying ID is visible alongside the label; otherwise returns { groups: [{ value, count }, ...], total }. Use this for breakdowns ("engagement breakdown", "members by status").
- **birth_date_range_for_age(min_age, max_age)** — returns Date_of_Birth bounds plus a ready-made filter snippet. Use this instead of doing date math by hand; Age is calculated and not filterable directly.

### Generic Tools (power-user fallback)
query_table and get_record are available for ad-hoc queries. query_table now wraps responses as { data, row_count, has_more, next_skip } — when has_more is true, re-issue with skip = next_skip. When using them:

**FK join syntax:** Replace _ID with _ID_Table.ColumnName
- Gender_ID_Table.Gender, Marital_Status_ID_Table.Marital_Status
- Contact_Status_ID_Table.Contact_Status, Household_Position_ID_Table.Household_Position
- Group_Type_ID_Table.Group_Type, Group_Role_ID_Table.Role_Title
- Event_Type_ID_Table.Event_Type, Program_ID_Table.Program_Name
- Metric_ID_Table.Metric_Title (NOT Metric_Name — the column is Metric_Title)

**Non-_ID FK columns** (use the column name directly with _Table, no _ID suffix):
- Primary_Contact_Table.Display_Name (on Groups)
- Parent_Group_Table.Group_Name, Born_From_Table.Group_Name, Promote_to_Group_Table.Group_Name (on Groups)
- Participant_Record_Table.Display_Name (on Contacts — Contact → Participant link)
- describe_table flags these explicitly via fk_join_prefix and label_column.

**Chained joins:** Household_ID_Table_Address_ID_Table.City, Contact_ID_Table.Display_Name

**Disambiguation:** Prefix ambiguous columns with the table name:
- Group_Participants.Start_Date (not just Start_Date)
- Group_Participants.End_Date (not just End_Date)
- Contacts.Contact_ID (when joining with other tables that have Contact_ID)

**Common mistakes to avoid:**
- Address_ID_Table does NOT exist on Contacts — use Household_ID_Table_Address_ID_Table
- Congregation_ID is on Households, not Contacts — use Household_ID_Table_Congregation_ID_Table.Congregation_Name
- Group_Type_ID does NOT exist on Group_Participants — it's on Groups (join Group_ID_Table_Group_Type_ID_Table.Group_Type)
- "Day" is not a column on Groups — use Meeting_Day_ID_Table.Meeting_Day
- Engagement and Member Status live on **Participants**, not Contacts. There is no Engagement_Level_ID or Member_Status_ID on Contacts. To query from Contacts, route through Participant_Record_Table (e.g., Participant_Record_Table_Participant_Engagement_ID_Table.Engagement_Level, Participant_Record_Table_Member_Status_ID_Table.Member_Status). Better: query Participants directly.
- Non-_ID FK columns drop the _ID before _Table: Primary_Contact_Table.Display_Name (NOT Primary_Contact_ID_Table), Parent_Group_Table.Group_Name, Born_From_Table.Group_Name, Participant_Record_Table.Display_Name. describe_table flags these via fk_join_prefix.
- The label column on the Participant_Engagement lookup is Engagement_Level (not Participant_Engagement); on Metrics it is Metric_Title (not Metric_Name). When in doubt, describe_table the lookup or use describe_table on the source — its label_column field is authoritative.
- Nested FK joins in $select DON'T work (e.g., Event_ID_Table.Event_Type_ID_Table.Event_Type fails). Only underscore-chained joins work (e.g., Event_ID_Table_Event_Type_ID_Table.Event_Type). If that also fails, query the lookup table separately.
- Do NOT use SQL functions in $filter (DATEADD, GETDATE, DATEDIFF, etc.) — MP rejects them as "not safe". Use literal ISO date strings instead: Event_Start_Date >= '2026-04-13'
- Do NOT HTML-encode operators (&gt;/&lt;) — MP rejects the encoded form as "not safe". Pass >, <, >=, <= literally.
- Use square brackets for special chars: [State/Region], [Address_Line_1]
- MP audit columns have a leading underscore: \`_Setup_Date\`, \`_Setup_User\`, \`_Last_Modified\`, \`_Last_Modified_User\`. They're present on virtually every table but don't always appear in describe_table's sample row. If you want to filter on "when this row was created", use \`_Setup_Date\` (NOT \`Setup_Date\` — that's a different, table-specific column when it exists at all).

### Attendance
- **Individual:** Event_Participants with Participation_Status_ID IN (3,4). 3=Attended, 4=Confirmed, 5=Cancelled.
- **Aggregate:** Event_Metrics with Metric_ID_Table.Metric_Title of "Headcount" or "In Person".

### Group Roles
Group_Role_Type_ID: 1=Leader, 2=Participant, 3=Servant (volunteer).
`;
}

/**
 * Wrap a tool handler so each invocation appends a JSONL row to TOOL_LOG_PATH.
 * No-op when logging is disabled. Errors and tool-level isError responses are
 * recorded with ok: false. Logging never blocks a successful response —
 * any write failure is surfaced to the console only.
 */
function wrapHandlerWithLogging<H extends (...args: unknown[]) => unknown>(
  toolName: string,
  handler: H
): H {
  if (!isToolLoggingEnabled()) return handler;
  const wrapped = async (args: unknown, extra: unknown): Promise<unknown> => {
    const start = Date.now();
    let ok = true;
    let error: string | undefined;
    try {
      const result = await (handler as unknown as (a: unknown, e: unknown) => Promise<unknown>)(args, extra);
      const r = result as { isError?: boolean; content?: Array<{ text?: unknown }> } | undefined;
      if (r && r.isError) {
        ok = false;
        // Pull the user-visible error text out of the tool response so the
        // log row carries the actual MP/validation message instead of just
        // "tool_returned_isError". Truncate to keep one bad row from
        // ballooning the JSONL line.
        const text = r.content?.[0]?.text;
        error = typeof text === "string" ? text.slice(0, 500) : "tool_returned_isError";
      }
      return result;
    } catch (err) {
      ok = false;
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const ai = (extra as { authInfo?: { extra?: { userId?: string; userName?: string } } } | undefined)?.authInfo;
      void logToolInvocation({
        ts: new Date().toISOString(),
        user_id: ai?.extra?.userId,
        user_name: ai?.extra?.userName,
        tool: toolName,
        args,
        duration_ms: Date.now() - start,
        ok,
        ...(error !== undefined && { error }),
      });
    }
  };
  return wrapped as unknown as H;
}

/**
 * Create and configure the MCP server with all tools registered.
 */
export function createMcpServer(config: AppConfig): McpServer {
  const server = new McpServer(
    {
      name: "ministry-platform",
      version: "0.2.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: buildPresentationInstructions(config),
    }
  );

  // Patch registerTool so every tool registered below picks up the logging
  // wrapper without each tool file having to remember to opt in.
  if (isToolLoggingEnabled()) {
    const original = server.registerTool.bind(server);
    type RegisterFn = typeof original;
    type RegisterArgs = Parameters<RegisterFn>;
    const patched = ((name: RegisterArgs[0], config: RegisterArgs[1], handler: RegisterArgs[2]) =>
      original(
        name,
        config,
        wrapHandlerWithLogging(name as string, handler as (...a: unknown[]) => unknown) as RegisterArgs[2]
      )) as RegisterFn;
    (server as unknown as { registerTool: RegisterFn }).registerTool = patched;
  }

  // Register domain tools (preferred for staff use)
  registerPeopleTools(server);
  registerGroupTools(server);
  registerEventTools(server);
  // Register generic tools (power-user escape hatches)
  registerGenericTools(server);

  return server;
}
