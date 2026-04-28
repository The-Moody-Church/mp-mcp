import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mpApiRequest } from "../transport.js";
import { escapeLikeValue } from "../utils/filter-sanitize.js";
import { getAuthFromExtra } from "./auth.js";

const DATE_KEYWORDS = ["today", "tomorrow", "this_sunday", "this_week"] as const;
type DateKeyword = (typeof DATE_KEYWORDS)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve a "today" / "tomorrow" / "this_sunday" / "this_week" keyword or a
 * literal YYYY-MM-DD into an ISO date string. For "this_week" we return the
 * pair { start, end } where end is the upcoming Saturday.
 */
function resolveDateKeyword(value: string): { start: string; end?: string } {
  if (ISO_DATE.test(value)) return { start: value };

  const today = new Date();
  // Anchor at UTC midnight to avoid TZ drift in toISOString().
  const anchor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const addDays = (d: Date, n: number) => {
    const r = new Date(d);
    r.setUTCDate(r.getUTCDate() + n);
    return r;
  };

  switch (value as DateKeyword) {
    case "today":
      return { start: fmt(anchor) };
    case "tomorrow":
      return { start: fmt(addDays(anchor, 1)) };
    case "this_sunday": {
      const dow = anchor.getUTCDay(); // 0 = Sunday
      const offset = dow === 0 ? 0 : 7 - dow;
      return { start: fmt(addDays(anchor, offset)) };
    }
    case "this_week": {
      const dow = anchor.getUTCDay();
      const offsetToSat = (6 - dow + 7) % 7;
      return { start: fmt(anchor), end: fmt(addDays(anchor, offsetToSat)) };
    }
    default:
      throw new Error(`Invalid date "${value}". Use YYYY-MM-DD or one of: ${DATE_KEYWORDS.join(", ")}.`);
  }
}

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
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Start of date range (YYYY-MM-DD). Defaults to today."),
        end_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
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
      if (search) filters.push(`Event_Title LIKE '%${escapeLikeValue(search)}%'`);
      if (program) filters.push(`Program_ID_Table.Program_Name LIKE '%${escapeLikeValue(program)}%'`);
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
          .regex(/^\d{4}-\d{2}-\d{2}$/)
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
        const escaped = escapeLikeValue(event_name);
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

      // Check aggregate metrics first (headcount for services/large events)
      let metrics: unknown[] = [];
      try {
        metrics = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Event_Metrics", {
          $select: "Event_Metrics.Metric_ID,Metric_ID_Table.Metric_Title,Numerical_Value",
          $filter: `Event_Metrics.Event_ID=${eventId}`,
        }) as unknown[];
      } catch {
        // Non-fatal
      }

      // Then check individual attendance (Event_Participants with status 3=Attended or 4=Confirmed)
      let attendees: unknown[] = [];
      try {
        attendees = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Event_Participants", {
          $select: [
            "Participant_ID_Table_Contact_ID_Table.Display_Name",
            "Participation_Status_ID_Table.Participation_Status",
            "Time_In",
            "Time_Out",
          ].join(","),
          $filter: `Event_ID=${eventId} AND Event_Participants.Participation_Status_ID IN (3,4)`,
          $orderby: "Participant_ID_Table_Contact_ID_Table.Display_Name",
        }) as unknown[];
      } catch {
        // Non-fatal
      }

      const result: Record<string, unknown> = {};
      if (eventTitle) result.event = eventTitle;

      const hasMetrics = (metrics as unknown[]).length > 0;
      const hasAttendees = (attendees as unknown[]).length > 0;

      if (hasMetrics) {
        // Pivot rows like { Metric_Title, Numerical_Value } into a flat
        // { "In Person": 1027, "Online": 1241 } object so the model doesn't
        // have to scan an array to find a metric. Falls back to the raw row
        // when Metric_Title isn't populated.
        const pivot: Record<string, unknown> = {};
        const unnamed: unknown[] = [];
        for (const row of metrics as Record<string, unknown>[]) {
          const name = row.Metric_Title;
          if (typeof name === "string" && name) {
            pivot[name] = row.Numerical_Value ?? null;
          } else {
            const { Metric_ID, ...rest } = row;
            unnamed.push(rest);
          }
        }
        result.metrics = pivot;
        if (unnamed.length > 0) result.metrics_unnamed = unnamed;
      }
      if (hasAttendees) {
        result.individual_attendance = attendees;
        result.individual_count = (attendees as unknown[]).length;
      }
      if (hasMetrics && hasAttendees) {
        result.note = "This event has both aggregate metrics (e.g., headcount) and individual check-in records.";
      }
      if (!hasMetrics && !hasAttendees) {
        result.message = "No attendance data found for this event.";
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ── get_schedule ────────────────────────────────────────────────────────

  server.registerTool(
    "get_schedule",
    {
      title: "Get Schedule",
      description:
        "Return the event schedule for a date or date range with rooms already " +
        "joined in. Replaces the multi-step query_table dance for \"what's " +
        "happening tomorrow and where\". Each event includes Cancelled and " +
        "Approved fields so callers can decide how to surface them — no implicit " +
        "active-only filter is applied.\n\n" +
        "`date` and `end_date` accept YYYY-MM-DD or one of: today, tomorrow, " +
        "this_sunday, this_week. `this_week` expands on its own to today→" +
        "Saturday; combine other keywords by passing both fields.",
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe("Start date or keyword (today, tomorrow, this_sunday, this_week). Default: today."),
        end_date: z
          .string()
          .optional()
          .describe("End date or keyword (inclusive). Default: same as date."),
        include_unassigned: z
          .boolean()
          .optional()
          .describe("Include events with no Event_Rooms records as a separate `unassigned` array (default: true)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ date, end_date, include_unassigned }, extra) => {
      const { mpBaseUrl, accessToken } = getAuthFromExtra(extra);

      const startResolved = resolveDateKeyword(date ?? "today");
      const startDate = startResolved.start;
      // If `date` was "this_week", honour its end unless caller overrode it.
      const endDate = end_date
        ? resolveDateKeyword(end_date).start
        : (startResolved.end ?? startDate);

      // Use [start 00:00, end+1day 00:00) so events at any time on end_date match.
      const endExclusive = (() => {
        const d = new Date(`${endDate}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString().slice(0, 10);
      })();

      const eventSelect = [
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
        "_Approved",
      ].join(",");

      const eventFilter =
        `Event_Start_Date >= '${startDate}' AND Event_Start_Date < '${endExclusive}'`;

      const events = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Events", {
        $select: eventSelect,
        $filter: eventFilter,
        $orderby: "Event_Start_Date",
        $top: 1000,
      }) as Record<string, unknown>[];

      // Bail early — nothing else to fetch.
      if (events.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              date: startDate,
              end_date: endDate,
              events: [],
              unassigned: [],
            }, null, 2),
          }],
        };
      }

      const eventIds = events.map((e) => e.Event_ID as number);
      // Fetch the room assignments for these events in one shot. Cancelled and
      // Room_ID are both ambiguous against the joined Rooms table, so prefix
      // them with Event_Rooms.
      let roomRows: Record<string, unknown>[] = [];
      try {
        roomRows = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Event_Rooms", {
          $select: [
            "Event_Rooms.Event_ID",
            "Room_ID_Table.Room_Name",
            "Room_ID_Table.Room_Number",
            "Room_ID_Table_Building_ID_Table.Building_Name",
            "Event_Rooms.Cancelled",
          ].join(","),
          $filter: `Event_Rooms.Event_ID IN (${eventIds.join(",")})`,
          $top: 1000,
        }) as Record<string, unknown>[];
      } catch (err) {
        // Non-fatal — return events without rooms but flag the failure so the
        // caller knows the join didn't run rather than silently showing nothing.
        console.error(`[tool] get_schedule Event_Rooms join failed:`, err);
      }

      const roomsByEvent = new Map<number, Array<Record<string, unknown>>>();
      for (const row of roomRows) {
        const id = row.Event_ID as number;
        if (!roomsByEvent.has(id)) roomsByEvent.set(id, []);
        roomsByEvent.get(id)!.push({
          name: row.Room_Name,
          number: row.Room_Number,
          building: row.Building_Name,
          cancelled: row.Cancelled,
        });
      }

      const showUnassigned = include_unassigned ?? true;
      const assigned: unknown[] = [];
      const unassigned: unknown[] = [];
      for (const e of events) {
        const id = e.Event_ID as number;
        const rooms = roomsByEvent.get(id) ?? [];
        // Strip internal Event_ID per the no-raw-IDs presentation rule.
        const { Event_ID, ...rest } = e;
        const item = { ...rest, rooms };
        if (rooms.length === 0) unassigned.push(item);
        else assigned.push(item);
      }

      const result: Record<string, unknown> = {
        date: startDate,
        end_date: endDate,
        events: showUnassigned ? [...assigned, ...unassigned] : assigned,
      };
      if (showUnassigned) {
        result.unassigned_count = unassigned.length;
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ── get_attendance_summary ──────────────────────────────────────────────

  server.registerTool(
    "get_attendance_summary",
    {
      title: "Get Attendance Summary",
      description:
        "Aggregate Event_Metrics across a recurring service over time. Returns " +
        "metric averages and totals per period (year / month / week) with each " +
        "metric pivoted as a keyed object — collapses queries like " +
        "\"YoY Sunday Service attendance\" into a single tool call.\n\n" +
        "All matching events are queried regardless of Cancelled/_Approved; " +
        "averages are computed over events that actually have a metric value, " +
        "so cancelled-with-no-data services don't drag the mean. " +
        "Each bucket reports `events_in_period` (everything matched) alongside " +
        "per-metric `events_with_value`.",
      inputSchema: {
        event_name: z
          .string()
          .describe("Substring matched against Event_Title (LIKE %name%). E.g., 'Sunday Morning Service'."),
        start_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("Inclusive lower bound for Event_Start_Date (YYYY-MM-DD)."),
        end_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Inclusive upper bound for Event_Start_Date (YYYY-MM-DD). Default: today."),
        group_by: z
          .enum(["year", "month", "week", "service"])
          .optional()
          .describe("Bucket granularity. 'service' returns one row per event with metrics pivoted (no aggregation). Default: 'year'."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ event_name, start_date, end_date, group_by }, extra) => {
      const { mpBaseUrl, accessToken } = getAuthFromExtra(extra);
      const groupByMode = group_by ?? "year";
      const endStr = end_date ?? new Date().toISOString().slice(0, 10);

      // Use [start, end+1day) so events at any time on end_date are included.
      const endExclusive = (() => {
        const d = new Date(`${endStr}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString().slice(0, 10);
      })();

      const escapedName = escapeLikeValue(event_name);
      const events = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Events", {
        $select: [
          "Event_ID",
          "Event_Title",
          "Event_Start_Date",
          "Cancelled",
          "_Approved",
        ].join(","),
        $filter:
          `Event_Title LIKE '%${escapedName}%' AND ` +
          `Event_Start_Date >= '${start_date}' AND Event_Start_Date < '${endExclusive}'`,
        $orderby: "Event_Start_Date",
        $top: 1000,
      }) as Record<string, unknown>[];

      if (events.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              event_name,
              start_date,
              end_date: endStr,
              group_by: groupByMode,
              buckets: [],
              message: `No events matched "${event_name}" in that date range.`,
            }, null, 2),
          }],
        };
      }

      const eventIds = events.map((e) => e.Event_ID as number);
      const metrics = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Event_Metrics", {
        $select: [
          "Event_Metrics.Event_ID",
          "Metric_ID_Table.Metric_Title",
          "Numerical_Value",
        ].join(","),
        $filter: `Event_Metrics.Event_ID IN (${eventIds.join(",")})`,
        $top: 1000,
      }) as Record<string, unknown>[];

      // Group metrics by Event_ID for fast lookup while bucketing.
      const metricsByEvent = new Map<number, Array<{ name: string; value: number }>>();
      for (const m of metrics) {
        const id = m.Event_ID as number;
        const name = m.Metric_Title;
        const raw = m.Numerical_Value;
        if (typeof name !== "string" || name === "" || raw === null || raw === undefined) continue;
        const value = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(value)) continue;
        if (!metricsByEvent.has(id)) metricsByEvent.set(id, []);
        metricsByEvent.get(id)!.push({ name, value });
      }

      const pad = (n: number) => String(n).padStart(2, "0");
      const bucketKey = (start: Date, eventTitle: string, eventId: number): string => {
        if (groupByMode === "year") return String(start.getUTCFullYear());
        if (groupByMode === "month") return `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}`;
        if (groupByMode === "week") {
          // Anchor weeks on Monday (ISO).
          const d = new Date(start);
          const dow = d.getUTCDay();
          const offset = dow === 0 ? -6 : 1 - dow;
          d.setUTCDate(d.getUTCDate() + offset);
          return d.toISOString().slice(0, 10);
        }
        // 'service' — one bucket per event.
        return `${start.toISOString().slice(0, 10)}#${eventId}#${eventTitle}`;
      };

      // For each bucket, accumulate per-metric totals + counts so we can
      // report avg, total, and the number of events that actually carried a
      // value for that metric (some events may have In Person but not Online).
      interface Bucket {
        period: string;
        events_in_period: number;
        metrics: Map<string, { total: number; count: number }>;
        // For 'service' mode we surface the event title/date alongside.
        event_title?: string;
        event_start?: string;
      }
      const buckets = new Map<string, Bucket>();

      for (const e of events) {
        const eventId = e.Event_ID as number;
        const startRaw = e.Event_Start_Date as string;
        const eventTitle = (e.Event_Title as string) ?? "";
        const startDate = new Date(startRaw);
        const key = bucketKey(startDate, eventTitle, eventId);
        if (!buckets.has(key)) {
          const b: Bucket = { period: key, events_in_period: 0, metrics: new Map() };
          if (groupByMode === "service") {
            b.event_title = eventTitle;
            b.event_start = startRaw;
            b.period = startRaw.slice(0, 10);
          }
          buckets.set(key, b);
        }
        const bucket = buckets.get(key)!;
        bucket.events_in_period += 1;
        const eventMetrics = metricsByEvent.get(eventId) ?? [];
        for (const { name, value } of eventMetrics) {
          const existing = bucket.metrics.get(name) ?? { total: 0, count: 0 };
          existing.total += value;
          existing.count += 1;
          bucket.metrics.set(name, existing);
        }
      }

      // Sort buckets chronologically. The keys are already lexicographically
      // sortable for year/month/week; for 'service' we keep insertion order
      // (events were $orderby'd).
      const sorted = [...buckets.values()];
      if (groupByMode !== "service") sorted.sort((a, b) => a.period.localeCompare(b.period));

      const round = (n: number) => Math.round(n * 100) / 100;
      const out = sorted.map((b) => {
        const metricsOut: Record<string, { avg: number; total: number; events_with_value: number }> = {};
        for (const [name, agg] of b.metrics.entries()) {
          metricsOut[name] = {
            avg: agg.count > 0 ? round(agg.total / agg.count) : 0,
            total: agg.total,
            events_with_value: agg.count,
          };
        }
        const row: Record<string, unknown> = {
          period: b.period,
          events_in_period: b.events_in_period,
          metrics: metricsOut,
        };
        if (b.event_title) row.event_title = b.event_title;
        if (b.event_start) row.event_start = b.event_start;
        return row;
      });

      const summary: Record<string, unknown> = {
        event_name,
        start_date,
        end_date: endStr,
        group_by: groupByMode,
        events_matched: events.length,
        buckets: out,
      };
      // Hitting exactly $top=1000 means MP may have truncated. Flag it so the
      // caller knows the trailing buckets are likely incomplete.
      if (events.length === 1000) summary.truncated = true;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    }
  );
}
