import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mpApiRequest } from "../transport.js";
import { getAuthFromExtra } from "./auth.js";

export function registerPeopleTools(server: McpServer): void {
  server.registerTool(
    "find_people",
    {
      title: "Find People",
      description:
        "Search for people in Ministry Platform by name, email, or phone number. " +
        "Searches Nickname, First_Name, and Last_Name individually (Display_Name is just 'Last, Nickname'). " +
        "Returns matching contacts with their basic info.",
      inputSchema: {
        search: z
          .string()
          .describe("Name, email, or phone number to search for"),
        top: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results to return (default 25)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ search, top }, extra) => {
      const { mpBaseUrl, accessToken } = getAuthFromExtra(extra);
      const limit = top ?? 25;
      const escaped = search.replace(/'/g, "''");

      // Search across name, email, and phone fields.
      // Display_Name is "Last, Nickname" — search Nickname/First_Name/Last_Name
      // individually for better partial matching.
      const filter = [
        `Nickname LIKE '%${escaped}%'`,
        `First_Name LIKE '%${escaped}%'`,
        `Last_Name LIKE '%${escaped}%'`,
        `Display_Name LIKE '%${escaped}%'`,
        `Email_Address LIKE '%${escaped}%'`,
        `Mobile_Phone LIKE '%${escaped}%'`,
        `Company_Phone LIKE '%${escaped}%'`,
      ].join(" OR ");

      const select = [
        "Contact_ID",
        "Display_Name",
        "Nickname",
        "First_Name",
        "Last_Name",
        "Email_Address",
        "Mobile_Phone",
        "Company_Phone",
        "Contact_Status_ID_Table.Contact_Status",
        "Household_Position_ID_Table.Household_Position",
      ].join(",");

      const data = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Contacts", {
        $select: select,
        $filter: filter,
        $orderby: "Last_Name,First_Name",
        $top: limit,
      });

      const records = data as Record<string, unknown>[];
      // Strip internal IDs from output
      const cleaned = records.map(({ Contact_ID, ...rest }) => rest);

      return {
        content: [{
          type: "text" as const,
          text: cleaned.length > 0
            ? JSON.stringify(cleaned, null, 2)
            : `No contacts found matching "${search}".`,
        }],
      };
    }
  );

  server.registerTool(
    "get_person_details",
    {
      title: "Get Person Details",
      description:
        "Get a person's full profile from Ministry Platform including contact info, " +
        "group memberships, and recent event attendance. Search by name or provide a Contact_ID.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Person's name to search for (uses Display_Name)"),
        contact_id: z
          .number()
          .int()
          .optional()
          .describe("Contact_ID if already known"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ name, contact_id }, extra) => {
      const { mpBaseUrl, accessToken } = getAuthFromExtra(extra);

      // Step 1: Find the contact
      let contactId = contact_id;
      if (!contactId && name) {
        const escaped = name.replace(/'/g, "''");
        const results = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Contacts", {
          $select: "Contact_ID,Display_Name",
          $filter: `Display_Name LIKE '%${escaped}%'`,
          $top: 5,
        }) as Record<string, unknown>[];

        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No contacts found matching "${name}".` }] };
        }
        if (results.length > 1) {
          return {
            content: [{
              type: "text" as const,
              text: `Multiple matches found. Please be more specific:\n${results.map(r => `- ${r.Display_Name} (Contact_ID: ${r.Contact_ID})`).join("\n")}`,
            }],
          };
        }
        contactId = results[0].Contact_ID as number;
      }

      if (!contactId) {
        return { content: [{ type: "text" as const, text: "Provide either a name or contact_id." }], isError: true };
      }

      // Step 2: Get full contact profile with FK joins
      const contactSelect = [
        "Contacts.Contact_ID",
        "Display_Name",
        "Nickname",
        "First_Name",
        "Last_Name",
        "Date_of_Birth",
        "Gender_ID_Table.Gender",
        "Marital_Status_ID_Table.Marital_Status",
        "Contact_Status_ID_Table.Contact_Status",
        "Household_Position_ID_Table.Household_Position",
        "Email_Address",
        "Mobile_Phone",
        "Company_Phone",
        "Household_ID_Table_Address_ID_Table.[Address_Line_1]",
        "Household_ID_Table_Address_ID_Table.City",
        "Household_ID_Table_Address_ID_Table.[State/Region]",
        "Household_ID_Table_Address_ID_Table.[Postal_Code]",
        "Household_ID_Table_Congregation_ID_Table.Congregation_Name",
        "Participant_Record",
        "Participant_Record_Table_Member_Status_ID_Table.Member_Status",
      ].join(",");

      const contact = await mpApiRequest(mpBaseUrl, accessToken, "GET",
        `/tables/Contacts/${contactId}`, { $select: contactSelect }
      ) as Record<string, unknown>[];

      const profile: Record<string, unknown> = Array.isArray(contact) ? contact[0] : contact;

      // Step 3: Get group memberships (if participant record exists)
      let groups: unknown[] = [];
      const participantId = profile.Participant_Record as number | null;
      if (participantId) {
        try {
          groups = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Group_Participants", {
            $select: [
              "Group_ID_Table.Group_Name",
              "Group_ID_Table_Group_Type_ID_Table.Group_Type",
              "Group_Role_ID_Table.Role_Title",
              "Group_Participants.Start_Date",
              "Group_Participants.End_Date",
            ].join(","),
            $filter: `Participant_ID=${participantId} AND (Group_Participants.End_Date IS NULL OR Group_Participants.End_Date > GETDATE())`,
            $orderby: "Group_ID_Table.Group_Name",
          }) as unknown[];
        } catch {
          // Non-fatal — continue without groups
        }
      }

      // Step 4: Get recent event attendance
      let events: unknown[] = [];
      if (participantId) {
        try {
          events = await mpApiRequest(mpBaseUrl, accessToken, "GET", "/tables/Event_Participants", {
            $select: [
              "Event_ID_Table.Event_Title",
              "Event_ID_Table.Event_Start_Date",
              "Participation_Status_ID_Table.Participation_Status",
            ].join(","),
            $filter: `Participant_ID=${participantId} AND Participation_Status_ID IN (3,4)`,
            $orderby: "Event_ID_Table.Event_Start_Date DESC",
            $top: 10,
          }) as unknown[];
        } catch {
          // Non-fatal — continue without events
        }
      }

      // Remove internal IDs from the response
      const { Contact_ID, Participant_Record, ...cleanProfile } = profile;

      const result = {
        profile: cleanProfile,
        ...(groups.length > 0 && { active_groups: groups }),
        ...(events.length > 0 && { recent_attendance: events }),
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
