import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mpApiRequest } from "../transport.js";
import { getAuthFromExtra } from "./auth.js";

export function registerEventTools(server: McpServer): void {
  server.registerTool(
    "search_events",
    {
      title: "Search Events",
      description:
        "Search for events (services, classes, meetings, etc.) by date range, " +
        "name, or program. Returns upcoming events by default.",
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe("Event title to search for"),
        start_date: z
          .string()
          .optional()
          .describe("Start of date range (YYYY-MM-DD). Defaults to today."),
        end_date: z
          .string()
          .optional()
          .describe("End of date range (YYYY-MM-DD). Defaults to 7 days from start."),
        program: z
          .string()
          .optional()
          .describe("Filter by program name"),
        include_cancelled: z
          .boolean()
          .optional()
          .describe("Include cancelled events (default: false)"),
        top: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max results (default 50)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ search, start_date, end_date, program, include_cancelled, top }, extra) => {
      const { mpBaseUrl, accessToken } = getAuthFromExtra(extra);

      const startStr = start_date || new Date().toISOString().split("T")[0];
      const filters: string[] = [];
      filters.push(`Event_Start_Date >= '${startStr}'`);
      if (end_date) filters.push(`Event_Start_Date <= '${end_date}'`);
      if (search) filters.push(`Event_Title LIKE '%${search.replace(/'/g, "''")}%'`);
      if (program) filters.push(`Program_ID_Table.Program_Name LIKE '%${program.replace(/'/g, "''")}%'`);
      if (!include_cancelled) filters.push("ISNULL(Cancelled,0) = 0");

      const select = [
        "Event_ID",
        "Event_Title",
        "Event_Start_Date",
        "Event_End_Date",
        "Event_Type_ID_Table.Event_Type",
        "Program_ID_Table.Program_Name",
        "Congregation_ID_Table.Congregation_Name",
        "Primary_Contact_Table.Display_Name",
        "Participants_Expected",
        "Cancelled",
      ].join(",");

      const data = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Events", {
        $select: select,
        $filter: filters.join(" AND "),
        $orderby: "Event_Start_Date",
        $top: top ?? 50,
      }) as Record<string, unknown>[];

      const cleaned = data.map(({ Event_ID, ...rest }) => rest);

      return {
        content: [{
          type: "text" as const,
          text: cleaned.length > 0
            ? JSON.stringify(cleaned, null, 2)
            : "No events found matching your criteria.",
        }],
      };
    }
  );

  server.registerTool(
    "get_event_attendance",
    {
      title: "Get Event Attendance",
      description:
        "Get who attended or registered for an event. For events with individual check-in, " +
        "returns the people who attended. For services/large events, returns the headcount " +
        "from event metrics if available.",
      inputSchema: {
        event_name: z
          .string()
          .optional()
          .describe("Event title to search for"),
        event_id: z
          .number()
          .int()
          .optional()
          .describe("Event_ID if already known"),
        event_date: z
          .string()
          .optional()
          .describe("Date to narrow search (YYYY-MM-DD)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ event_name, event_id, event_date }, extra) => {
      const { mpBaseUrl, accessToken } = getAuthFromExtra(extra);

      // Find the event if searching by name
      let eventId = event_id;
      let eventTitle = "";
      if (!eventId && event_name) {
        const escaped = event_name.replace(/'/g, "''");
        const filters = [`Event_Title LIKE '%${escaped}%'`];
        if (event_date) filters.push(`Event_Start_Date >= '${event_date}' AND Event_Start_Date < DATEADD(day,1,'${event_date}')`);
        const results = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Events", {
          $select: "Event_ID,Event_Title,Event_Start_Date",
          $filter: filters.join(" AND "),
          $orderby: "Event_Start_Date DESC",
          $top: 5,
        }) as Record<string, unknown>[];

        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No events found matching "${event_name}".` }] };
        }
        if (results.length > 1 && !event_date) {
          return {
            content: [{
              type: "text" as const,
              text: `Multiple events found. Please specify a date or be more specific:\n${results.map(r => `- ${r.Event_Title} (${r.Event_Start_Date}) — Event_ID: ${r.Event_ID}`).join("\n")}`,
            }],
          };
        }
        eventId = results[0].Event_ID as number;
        eventTitle = results[0].Event_Title as string;
      }

      if (!eventId) {
        return { content: [{ type: "text" as const, text: "Provide either an event_name or event_id." }], isError: true };
      }

      // Try individual attendance first (Event_Participants with status 3=Attended or 4=Confirmed)
      const attendees = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Event_Participants", {
        $select: [
          "Participant_ID_Table_Contact_ID_Table.Display_Name",
          "Participation_Status_ID_Table.Participation_Status",
          "Time_In",
          "Time_Out",
        ].join(","),
        $filter: `Event_ID=${eventId} AND Event_Participants.Participation_Status_ID IN (3,4)`,
        $orderby: "Participant_ID_Table_Contact_ID_Table.Display_Name",
      }) as unknown[];

      // Also check for aggregate metrics (headcount)
      let metrics: unknown[] = [];
      try {
        metrics = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Event_Metrics", {
          $select: "Metric_ID_Table.Metric_Name,Numerical_Value",
          $filter: `Event_ID=${eventId}`,
        }) as unknown[];
      } catch {
        // Non-fatal
      }

      const result: Record<string, unknown> = {};
      if (eventTitle) result.event = eventTitle;
      if ((attendees as unknown[]).length > 0) {
        result.individual_attendance = attendees;
        result.count = (attendees as unknown[]).length;
      }
      if ((metrics as unknown[]).length > 0) {
        result.metrics = metrics;
      }
      if ((attendees as unknown[]).length === 0 && (metrics as unknown[]).length === 0) {
        result.message = "No attendance data found for this event.";
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
