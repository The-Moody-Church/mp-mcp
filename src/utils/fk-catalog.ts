// Shared foreign-key metadata used by describe_table at runtime and by the
// schema-regen script (scripts/build-schema.ts) at build time.
//
// FK_CATALOG is authoritative for the columns it covers — it pins the
// canonical label column on the lookup table (e.g., Metric_ID → Metric_Title,
// not Metric_Name). It also covers non-_ID FK columns (Primary_Contact,
// Parent_Group, ...) that the _ID-suffix heuristic wouldn't otherwise flag.
// Columns not in the catalog fall back to inferLookupTable for _ID-suffixed
// names.

export const FK_CATALOG: Record<string, { lookup_table: string; label_column: string }> = {
  Address_ID: { lookup_table: "Addresses", label_column: "City" },
  Born_From: { lookup_table: "Groups", label_column: "Group_Name" },
  Building_ID: { lookup_table: "Buildings", label_column: "Building_Name" },
  Care_Person: { lookup_table: "Contacts", label_column: "Display_Name" },
  Congregation_ID: { lookup_table: "Congregations", label_column: "Congregation_Name" },
  Contact_ID: { lookup_table: "Contacts", label_column: "Display_Name" },
  Contact_Status_ID: { lookup_table: "Contact_Statuses", label_column: "Contact_Status" },
  Descended_From: { lookup_table: "Groups", label_column: "Group_Name" },
  Event_ID: { lookup_table: "Events", label_column: "Event_Title" },
  Event_Type_ID: { lookup_table: "Event_Types", label_column: "Event_Type" },
  Gender_ID: { lookup_table: "Genders", label_column: "Gender" },
  Group_ID: { lookup_table: "Groups", label_column: "Group_Name" },
  Group_Role_ID: { lookup_table: "Group_Roles", label_column: "Role_Title" },
  Group_Focus_ID: { lookup_table: "Group_Focuses", label_column: "Group_Focus" },
  Group_Type_ID: { lookup_table: "Group_Types", label_column: "Group_Type" },
  Household_ID: { lookup_table: "Households", label_column: "Household_Name" },
  Household_Position_ID: { lookup_table: "Household_Positions", label_column: "Household_Position" },
  Household_Source_ID: { lookup_table: "Household_Sources", label_column: "Household_Source" },
  Life_Stage_ID: { lookup_table: "Life_Stages", label_column: "Life_Stage" },
  Marital_Status_ID: { lookup_table: "Marital_Statuses", label_column: "Marital_Status" },
  Meeting_Day_ID: { lookup_table: "Meeting_Days", label_column: "Meeting_Day" },
  Meeting_Frequency_ID: { lookup_table: "Meeting_Frequencies", label_column: "Meeting_Frequency" },
  Member_Status_ID: { lookup_table: "Member_Statuses", label_column: "Member_Status" },
  Metric_ID: { lookup_table: "Metrics", label_column: "Metric_Title" },
  Milestone_ID: { lookup_table: "Milestones", label_column: "Milestone_Title" },
  Ministry_ID: { lookup_table: "Ministries", label_column: "Ministry_Name" },
  Offsite_Meeting_Address: { lookup_table: "Addresses", label_column: "City" },
  Parent_Group: { lookup_table: "Groups", label_column: "Group_Name" },
  Participant_ID: { lookup_table: "Participants", label_column: "Display_Name" },
  Participant_Engagement_ID: { lookup_table: "Participant_Engagement", label_column: "Engagement_Level" },
  Participant_Record: { lookup_table: "Participants", label_column: "Display_Name" },
  Participant_Type_ID: { lookup_table: "Participant_Types", label_column: "Participant_Type" },
  Participation_Status_ID: { lookup_table: "Participation_Statuses", label_column: "Participation_Status" },
  Prefix_ID: { lookup_table: "Prefixes", label_column: "Prefix" },
  Primary_Contact: { lookup_table: "Contacts", label_column: "Display_Name" },
  Priority_ID: { lookup_table: "Priorities", label_column: "Priority_Name" },
  Program_ID: { lookup_table: "Programs", label_column: "Program_Name" },
  Program_Type_ID: { lookup_table: "Program_Types", label_column: "Program_Type" },
  Promote_to_Group: { lookup_table: "Groups", label_column: "Group_Name" },
  Room_ID: { lookup_table: "Rooms", label_column: "Room_Name" },
  Service_Type_ID: { lookup_table: "Service_Types", label_column: "Service_Type" },
  Suffix_ID: { lookup_table: "Suffixes", label_column: "Suffix" },
};

/**
 * Heuristic lookup-table inference for _ID-suffixed columns not in
 * FK_CATALOG. Tries common MP pluralization patterns and returns the first
 * match present in the supplied allowlist, or null.
 */
export function inferLookupTable(columnName: string, allowedTables: string[]): string | null {
  if (!columnName.endsWith("_ID")) return null;
  const stem = columnName.slice(0, -3);
  if (!stem) return null;

  const allowedSet = new Set(allowedTables);
  const candidates = [
    `${stem}s`,
    `${stem}es`,
    stem,
    `${stem.replace(/y$/, "ies")}`,
  ];
  for (const candidate of candidates) {
    if (allowedSet.has(candidate)) return candidate;
  }
  return null;
}
