import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mpApiRequest } from "../transport.js";
import { escapeLikeValue } from "../utils/filter-sanitize.js";
import { getAuthFromExtra } from "./auth.js";

export function registerGroupTools(server: McpServer): void {
  server.registerTool(
    "search_groups",
    {
      title: "Search Groups",
      description:
        "Search for groups (small groups, ministry teams, classes, etc.) " +
        "by name, type, or ministry. Returns active groups by default.",
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe("Group name to search for"),
        group_type: z
          .string()
          .optional()
          .describe("Filter by group type (e.g., 'Small Group', 'Ministry Team', 'Class')"),
        ministry: z
          .string()
          .optional()
          .describe("Filter by ministry name"),
        include_ended: z
          .boolean()
          .optional()
          .describe("Include groups that have ended (default: false)"),
        top: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max results (default 50)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ search, group_type, ministry, include_ended, top }, extra) => {
      const { mpBaseUrl, accessToken } = getAuthFromExtra(extra);

      const filters: string[] = [];
      if (search) filters.push(`Group_Name LIKE '%${escapeLikeValue(search)}%'`);
      if (group_type) filters.push(`Group_Type_ID_Table.Group_Type = '${group_type.replace(/'/g, "''")}'`);
      if (ministry) filters.push(`Ministry_ID_Table.Ministry_Name LIKE '%${escapeLikeValue(ministry)}%'`);
      if (!include_ended) filters.push("(Groups.End_Date IS NULL OR Groups.End_Date > GETDATE())");

      const select = [
        "Group_ID",
        "Group_Name",
        "Group_Type_ID_Table.Group_Type",
        "Ministry_ID_Table.Ministry_Name",
        "Congregation_ID_Table.Congregation_Name",
        "Primary_Contact_Table.Display_Name",
        "Groups.Start_Date",
        "Groups.End_Date",
        "Meeting_Time",
        "Meeting_Day_ID_Table.Meeting_Day",
        "Meeting_Frequency_ID_Table.Meeting_Frequency",
      ].join(",");

      const data = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Groups", {
        $select: select,
        $filter: filters.length > 0 ? filters.join(" AND ") : undefined,
        $orderby: "Group_Name",
        $top: top ?? 50,
      }) as Record<string, unknown>[];

      const cleaned = data.map(({ Group_ID, ...rest }) => rest);

      return {
        content: [{
          type: "text" as const,
          text: cleaned.length > 0
            ? JSON.stringify(cleaned, null, 2)
            : "No groups found matching your criteria.",
        }],
      };
    }
  );

  server.registerTool(
    "get_group_roster",
    {
      title: "Get Group Roster",
      description:
        "Get the members/participants of a specific group with their roles and dates. " +
        "Shows active members by default.",
      inputSchema: {
        group_name: z
          .string()
          .optional()
          .describe("Group name to search for"),
        group_id: z
          .number()
          .int()
          .optional()
          .describe("Group_ID if already known"),
        include_inactive: z
          .boolean()
          .optional()
          .describe("Include members who have left the group (default: false)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ group_name, group_id, include_inactive }, extra) => {
      const { mpBaseUrl, accessToken } = getAuthFromExtra(extra);

      // Find the group if searching by name
      let groupId = group_id;
      if (!groupId && group_name) {
        const escaped = escapeLikeValue(group_name);
        const results = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Groups", {
          $select: "Group_ID,Group_Name",
          $filter: `Group_Name LIKE '%${escaped}%'`,
          $top: 5,
        }) as Record<string, unknown>[];

        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No groups found matching "${group_name}".` }] };
        }
        if (results.length > 1) {
          return {
            content: [{
              type: "text" as const,
              text: `Multiple groups found. Please be more specific:\n${results.map(r => `- ${r.Group_Name} (Group_ID: ${r.Group_ID})`).join("\n")}`,
            }],
          };
        }
        groupId = results[0].Group_ID as number;
      }

      if (!groupId) {
        return { content: [{ type: "text" as const, text: "Provide either a group_name or group_id." }], isError: true };
      }

      const filters = [`Group_ID=${groupId}`];
      if (!include_inactive) {
        filters.push("(Group_Participants.End_Date IS NULL OR Group_Participants.End_Date > GETDATE())");
      }

      const select = [
        "Participant_ID_Table_Contact_ID_Table.Display_Name",
        "Participant_ID_Table_Contact_ID_Table.Email_Address",
        "Participant_ID_Table_Contact_ID_Table.Mobile_Phone",
        "Group_Role_ID_Table.Role_Title",
        "Group_Role_ID_Table_Group_Role_Type_ID_Table.Group_Role_Type",
        "Group_Participants.Start_Date",
        "Group_Participants.End_Date",
      ].join(",");

      const data = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Group_Participants", {
        $select: select,
        $filter: filters.join(" AND "),
        $orderby: "Group_Role_ID_Table_Group_Role_Type_ID_Table.Group_Role_Type,Participant_ID_Table_Contact_ID_Table.Display_Name",
      }) as unknown[];

      return {
        content: [{
          type: "text" as const,
          text: (data as unknown[]).length > 0
            ? JSON.stringify(data, null, 2)
            : "No members found for this group.",
        }],
      };
    }
  );

  // ── get_group_attendance_summary ─────────────────────────────────────────

  server.registerTool(
    "get_group_attendance_summary",
    {
      title: "Get Group Attendance Summary",
      description:
        "Per-participant attendance counts for a group's meetings over one or two " +
        "date windows. Designed for pastoral-care questions like \"who came " +
        "consistently last fall but hasn't this spring\" — collapses what would " +
        "otherwise be 5+ raw queries into one call.\n\n" +
        "Group meetings are discovered via Event_Rooms.Group_ID (the standard " +
        "MP linkage between an event and the group it serves). Attendance is " +
        "Event_Participants with Participation_Status_ID IN (3,4) — Attended or " +
        "Confirmed.\n\n" +
        "Pass `compare_start_date`/`compare_end_date` to add a second period; " +
        "the response then includes per-participant counts for both. Use " +
        "`min_meetings_period_a` and `max_meetings_period_b` to pre-filter to " +
        "drift candidates server-side.",
      inputSchema: {
        group_id: z.number().int().optional().describe("Group_ID if already known"),
        group_name: z.string().optional().describe("Group name to search for (LIKE %name%)"),
        start_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("Period A start (inclusive, YYYY-MM-DD)."),
        end_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("Period A end (inclusive, YYYY-MM-DD)."),
        compare_start_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Period B start (inclusive). Pair with compare_end_date for two-window comparison."),
        compare_end_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Period B end (inclusive)."),
        min_meetings_period_a: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Only return participants who attended at least this many meetings in period A."),
        max_meetings_period_b: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Only return participants who attended at most this many meetings in period B (requires compare_*)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (
      {
        group_id,
        group_name,
        start_date,
        end_date,
        compare_start_date,
        compare_end_date,
        min_meetings_period_a,
        max_meetings_period_b,
      },
      extra
    ) => {
      const { mpBaseUrl, accessToken } = getAuthFromExtra(extra);

      const hasCompare = !!compare_start_date && !!compare_end_date;
      if ((compare_start_date && !compare_end_date) || (!compare_start_date && compare_end_date)) {
        return {
          content: [{ type: "text" as const, text: "compare_start_date and compare_end_date must be provided together." }],
          isError: true,
        };
      }
      if (max_meetings_period_b !== undefined && !hasCompare) {
        return {
          content: [{ type: "text" as const, text: "max_meetings_period_b requires both compare_start_date and compare_end_date." }],
          isError: true,
        };
      }

      // Resolve group_id from name if needed (matches get_group_roster's pattern).
      let groupId = group_id;
      let groupLabel: string | undefined;
      if (!groupId && group_name) {
        const escaped = escapeLikeValue(group_name);
        const results = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Groups", {
          $select: "Group_ID,Group_Name",
          $filter: `Group_Name LIKE '%${escaped}%'`,
          $top: 5,
        }) as Record<string, unknown>[];
        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No groups found matching "${group_name}".` }] };
        }
        if (results.length > 1) {
          return {
            content: [{
              type: "text" as const,
              text: `Multiple groups found. Please be more specific:\n${results.map(r => `- ${r.Group_Name} (Group_ID: ${r.Group_ID})`).join("\n")}`,
            }],
          };
        }
        groupId = results[0].Group_ID as number;
        groupLabel = results[0].Group_Name as string;
      }
      if (!groupId) {
        return { content: [{ type: "text" as const, text: "Provide either a group_id or group_name." }], isError: true };
      }

      // Compute the union window covering both periods so we only hit MP once
      // for events. Events are bucketed into period A or B in JS.
      const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
      const windowStart = hasCompare && cmp(compare_start_date!, start_date) < 0 ? compare_start_date! : start_date;
      const windowEnd = hasCompare && cmp(compare_end_date!, end_date) > 0 ? compare_end_date! : end_date;
      const addOneDay = (iso: string) => {
        const d = new Date(`${iso}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString().slice(0, 10);
      };
      const windowEndExclusive = addOneDay(windowEnd);

      // 1. Find the group's events via Event_Rooms.Group_ID.
      const reservationRows = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Event_Rooms", {
        $select: [
          "Event_Rooms.Event_ID",
          "Event_ID_Table.Event_Title",
          "Event_ID_Table.Event_Start_Date",
        ].join(","),
        $filter:
          `Event_Rooms.Group_ID=${groupId} AND ` +
          `Event_ID_Table.Event_Start_Date >= '${windowStart}' AND ` +
          `Event_ID_Table.Event_Start_Date < '${windowEndExclusive}'`,
        $top: 1000,
      }) as Record<string, unknown>[];

      // Dedupe by Event_ID (a single event with multiple rooms appears
      // multiple times in Event_Rooms) and bucket each event into period A/B.
      type EventBucket = "a" | "b";
      const eventsById = new Map<number, { title: string; start: string; period: EventBucket }>();
      for (const row of reservationRows) {
        const id = row.Event_ID as number;
        if (eventsById.has(id)) continue;
        const startRaw = row.Event_Start_Date as string;
        const dateOnly = startRaw.slice(0, 10);
        let period: EventBucket | null = null;
        if (cmp(dateOnly, start_date) >= 0 && cmp(dateOnly, end_date) <= 0) {
          period = "a";
        } else if (hasCompare && cmp(dateOnly, compare_start_date!) >= 0 && cmp(dateOnly, compare_end_date!) <= 0) {
          period = "b";
        }
        if (period === null) continue; // event sat in the gap between A and B
        eventsById.set(id, { title: row.Event_Title as string, start: startRaw, period });
      }

      const periodAEventIds = [...eventsById.entries()].filter(([, e]) => e.period === "a").map(([id]) => id);
      const periodBEventIds = [...eventsById.entries()].filter(([, e]) => e.period === "b").map(([id]) => id);

      if (eventsById.size === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              group_id: groupId,
              group_name: groupLabel,
              total_events_period_a: 0,
              ...(hasCompare && { total_events_period_b: 0 }),
              participants: [],
              message: "No meetings found for this group in the requested date range.",
            }, null, 2),
          }],
        };
      }

      // 2. Fetch attendance for those events. Prefix Event_ID and
      // Participation_Status_ID with Event_Participants because both columns
      // are ambiguous against the joined Participants/Contacts tables.
      const allEventIds = [...eventsById.keys()];
      const attendance = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Event_Participants", {
        $select: [
          "Event_Participants.Event_ID",
          "Event_Participants.Participant_ID",
          "Participant_ID_Table_Contact_ID_Table.Display_Name",
          "Participant_ID_Table_Contact_ID_Table.Email_Address",
          "Participant_ID_Table_Contact_ID_Table.Mobile_Phone",
        ].join(","),
        $filter:
          `Event_Participants.Event_ID IN (${allEventIds.join(",")}) AND ` +
          `Event_Participants.Participation_Status_ID IN (3,4)`,
        $top: 1000,
      }) as Record<string, unknown>[];

      // 3. Fold attendance into per-participant counts by period.
      interface PStats {
        name: string;
        email: string | null;
        phone: string | null;
        period_a_meetings: number;
        period_b_meetings: number;
      }
      const perParticipant = new Map<number, PStats>();
      for (const row of attendance) {
        const eventId = row.Event_ID as number;
        const event = eventsById.get(eventId);
        if (!event) continue;
        const pid = row.Participant_ID as number;
        if (!perParticipant.has(pid)) {
          perParticipant.set(pid, {
            name: (row.Display_Name as string) ?? "(unknown)",
            email: (row.Email_Address as string | null) ?? null,
            phone: (row.Mobile_Phone as string | null) ?? null,
            period_a_meetings: 0,
            period_b_meetings: 0,
          });
        }
        const stats = perParticipant.get(pid)!;
        if (event.period === "a") stats.period_a_meetings += 1;
        else stats.period_b_meetings += 1;
      }

      // 4. Apply optional thresholds.
      let participants = [...perParticipant.values()];
      if (min_meetings_period_a !== undefined) {
        participants = participants.filter((p) => p.period_a_meetings >= min_meetings_period_a);
      }
      if (max_meetings_period_b !== undefined) {
        participants = participants.filter((p) => p.period_b_meetings <= max_meetings_period_b);
      }
      // Sort: most-attended in period A first; tie-break by name.
      participants.sort((a, b) => b.period_a_meetings - a.period_a_meetings || a.name.localeCompare(b.name));

      const summary: Record<string, unknown> = {
        group_id: groupId,
        ...(groupLabel && { group_name: groupLabel }),
        period_a: { start_date, end_date, total_events: periodAEventIds.length },
        ...(hasCompare && {
          period_b: { start_date: compare_start_date, end_date: compare_end_date, total_events: periodBEventIds.length },
        }),
        participants_returned: participants.length,
        participants: participants.map((p) => {
          const out: Record<string, unknown> = {
            name: p.name,
            email: p.email,
            phone: p.phone,
            period_a_meetings: p.period_a_meetings,
          };
          if (hasCompare) out.period_b_meetings = p.period_b_meetings;
          return out;
        }),
      };
      if (reservationRows.length === 1000 || attendance.length === 1000) {
        summary.truncated = true;
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    }
  );
}
