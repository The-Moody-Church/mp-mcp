import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mpApiRequest } from "../transport.js";
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
      if (search) filters.push(`Group_Name LIKE '%${search.replace(/'/g, "''")}%'`);
      if (group_type) filters.push(`Group_Type_ID_Table.Group_Type = '${group_type.replace(/'/g, "''")}'`);
      if (ministry) filters.push(`Ministry_ID_Table.Ministry_Name LIKE '%${ministry.replace(/'/g, "''")}%'`);
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
        const escaped = group_name.replace(/'/g, "''");
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
}
