import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPeopleTools } from "./tools/people.js";
import { registerGroupTools } from "./tools/groups.js";
import { registerEventTools } from "./tools/events.js";
import { registerGenericTools } from "./tools/generic.js";

// ── Presentation instructions (sent to Claude as server-level instructions) ──

const PRESENTATION_INSTRUCTIONS = `
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
1. **No raw IDs** — Omit Contact_ID, Participant_ID, Group_ID, etc. unless explicitly asked.
2. **Never guess lookup values** — Use FK joins or the domain tools which resolve them automatically.
3. **Donations are confidential** — Never mention donor records, giving amounts, or pledge info unless explicitly asked.
4. **Focus on useful info** — Names, contact info, engagement, dates. Not database metadata.

### Domain Tools (preferred)
Use find_people, get_person_details, search_groups, get_group_roster, get_group_attendance_summary, search_events, get_event_attendance, get_schedule, and get_attendance_summary for common queries. These encode the correct FK joins and field names. In particular:
- get_schedule returns events for a date/range with rooms already joined — use it for "what's happening tomorrow / this Sunday" instead of stitching Events + Event_Rooms by hand.
- get_attendance_summary aggregates Event_Metrics for a recurring service (e.g., "Sunday Morning Service") into year/month/week buckets with metrics pivoted by name — use it for "YoY service attendance" instead of pulling raw metric rows. get_event_attendance also pivots its metrics output, so each metric (In Person, Online, Headcount) appears as a key directly under "metrics".
- get_group_attendance_summary returns per-participant attendance counts for a group's meetings over one or two date windows, with optional drift-detection thresholds — use it for "who came consistently last fall but hasn't this spring" instead of pulling raw Event_Participants rows. Group meetings are discovered via Event_Rooms.Group_ID.

### Aggregation Tools (use these instead of fetching rows to count them)
- **count_rows(table, filter)** — returns just { count: N }. Use this any time you only need a total ("how many active members 65–69") instead of pulling rows with query_table.
- **group_by_count(table, group_by, filter)** — returns { groups: [{value, count}, ...], total }. Use this for breakdowns ("engagement breakdown", "members by status"). Pass FK joins like Engagement_Level_ID_Table.Engagement_Level so buckets are human-readable.
- **birth_date_range_for_age(min_age, max_age)** — returns Date_of_Birth bounds plus a ready-made filter snippet. Use this instead of doing date math by hand; Age is calculated and not filterable directly.

### Generic Tools (power-user fallback)
query_table and get_record are available for ad-hoc queries. query_table now wraps responses as { data, row_count, has_more, next_skip } — when has_more is true, re-issue with skip = next_skip. When using them:

**FK join syntax:** Replace _ID with _ID_Table.ColumnName
- Gender_ID_Table.Gender, Marital_Status_ID_Table.Marital_Status
- Contact_Status_ID_Table.Contact_Status, Household_Position_ID_Table.Household_Position
- Group_Type_ID_Table.Group_Type, Group_Role_ID_Table.Role_Title
- Event_Type_ID_Table.Event_Type, Program_ID_Table.Program_Name

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
- Participant_Engagement is not a valid FK join name
- Nested FK joins in $select DON'T work (e.g., Event_ID_Table.Event_Type_ID_Table.Event_Type fails). Only underscore-chained joins work (e.g., Event_ID_Table_Event_Type_ID_Table.Event_Type). If that also fails, query the lookup table separately.
- Do NOT use SQL functions in $filter (DATEADD, GETDATE, DATEDIFF, etc.) — MP rejects them as "not safe". Use literal ISO date strings instead: Event_Start_Date >= '2026-04-13'
- Use square brackets for special chars: [State/Region], [Address_Line_1]

### Attendance
- **Individual:** Event_Participants with Participation_Status_ID IN (3,4). 3=Attended, 4=Confirmed, 5=Cancelled.
- **Aggregate:** Event_Metrics with Metric_ID_Table.Metric_Name of "Headcount" or "In Person".

### Group Roles
Group_Role_Type_ID: 1=Leader, 2=Participant, 3=Servant (volunteer).
`;

/**
 * Create and configure the MCP server with all tools registered.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "ministry-platform",
      version: "0.2.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: PRESENTATION_INSTRUCTIONS,
    }
  );

  // Register domain tools (preferred for staff use)
  registerPeopleTools(server);
  registerGroupTools(server);
  registerEventTools(server);
  // Register generic tools (power-user escape hatches)
  registerGenericTools(server);

  return server;
}
