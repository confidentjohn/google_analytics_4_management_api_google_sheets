/**
 * Channel Groups: create, list, update (v1alpha)
 */

function createNewChannelGroups() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("newChannelGroups");
  if (!sheet) {
    SpreadsheetApp.getUi().alert("Sheet 'newChannelGroups' not found.");
    return;
  }

  const data = sheet.getDataRange().getValues();
  const headers = data.shift();

  const propertyIdIndex = headers.indexOf("Property ID");
  const displayNameIndex = headers.indexOf("displayName");
  const descriptionIndex = headers.indexOf("description");
  const groupingRuleIndex = headers.indexOf("groupingRule");

  if (propertyIdIndex === -1 || displayNameIndex === -1 || descriptionIndex === -1 || groupingRuleIndex === -1) {
    SpreadsheetApp.getUi().alert("Missing required columns in 'newChannelGroups' sheet.");
    return;
  }

  data.forEach(row => {
    const propertyId = String(row[propertyIdIndex]);
    const displayName = row[displayNameIndex];
    const description = row[descriptionIndex];
    const groupingRule = row[groupingRuleIndex];

    if (!propertyId || !displayName || !groupingRule) {
      Logger.log("Skipping row due to missing required fields.");
      return;
    }

    const formattedPropertyId = formatPropertyId(propertyId);
    const url = `https://analyticsadmin.googleapis.com/v1alpha/${formattedPropertyId}/channelGroups`;

    const payload = {
      displayName: displayName,
      description: description || "",
      groupingRule: JSON.parse(groupingRule)
    };

    const options = {
      method: 'post',
      headers: {
        Authorization: `Bearer ${ScriptApp.getOAuthToken()}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      muteHttpExceptions: true,
      payload: JSON.stringify(payload)
    };

    try {
      const response = UrlFetchApp.fetch(url, options);
      Logger.log("API Response: " + response.getContentText());
    } catch (e) {
      Logger.log("Error creating channel group: " + e.message);
    }
  });

  SpreadsheetApp.getUi().alert("Channel group creation process completed.");
}

/**
 * Channel Groups (list) — supports:
 *  - Property ID CSV
 *  - Account ID CSV
 *  - Blank (ALL properties you can access)
 *
 * Output columns mirror the dimensions/metrics listings with account/property context.
 */
function listChannelGroups() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const accessToken = ScriptApp.getOAuthToken();

  // --- Gather filters via UI (if available) ---
  let propInput = "";
  let acctInput = "";
  try {
    const ui = SpreadsheetApp.getUi();

    const propResp = ui.prompt(
      "List Channel Groups",
      "Enter GA4 Property IDs (comma-separated), or leave blank:",
      ui.ButtonSet.OK_CANCEL
    );
    if (propResp.getSelectedButton() !== ui.Button.OK) {
      ui.alert("Operation canceled.");
      return;
    }
    propInput = String(propResp.getResponseText() || "").trim();

    const acctResp = ui.prompt(
      "Optional: Account filter",
      "Enter GA4 Account IDs (comma-separated), or leave blank. (If you filled Property IDs above, leave this blank.)",
      ui.ButtonSet.OK_CANCEL
    );
    if (acctResp.getSelectedButton() !== ui.Button.OK) {
      ui.alert("Operation canceled.");
      return;
    }
    acctInput = String(acctResp.getResponseText() || "").trim();

    // Safety: not both
    if (propInput && acctInput) {
      ui.alert("Please provide either Property IDs OR Account IDs, not both.");
      return;
    }
  } catch (e) {
    // No UI context (editor) -> proceed with ALL
    Logger.log("No UI context; proceeding with ALL properties.");
  }

  // --- Prepare output sheet ---
  const sheetName = "GA4 Channel Groups " + timestampForSheet();
  const sheet = ss.insertSheet(sheetName);
  sheet.appendRow([
    "Account ID",
    "Account Name",
    "Property ID",
    "Property Name",
    "Channel Group ID",       // short id (last path segment)
    "Channel Group Resource", // full resource name properties/{pid}/channelGroups/{id}
    "Display Name",
    "Description",
    "Grouping Rules",
    "Update"
  ]);

  // --- Decide which properties to process ---
  const parseIdCsv = (txt) =>
    String(txt || "")
      .split(",")
      .map(s => s.trim())
      .filter(s => /^[0-9]+$/.test(s));

  const propIdsFilter = parseIdCsv(propInput);
  const acctIdsFilter = parseIdCsv(acctInput);

  let propertiesToProcess = []; // [{accountId, accountName, propertyId, propertyName}]

  if (propIdsFilter.length > 0) {
    // Explicit property IDs -> fetch meta so we can show names + account
    propertiesToProcess = propIdsFilter.map(pid => {
      const meta = fetchPropertyMeta_(pid, accessToken);
      return meta || { accountId: "", accountName: "", propertyId: pid, propertyName: "" };
    });
  } else if (acctIdsFilter.length > 0) {
    // For each account, list its properties
    acctIdsFilter.forEach(accountId => {
      const props = fetchPropertiesForAccount_(accountId, accessToken);
      propertiesToProcess.push(...props);
    });
  } else {
    // EVERYTHING
    const summaries = getAllAccountSummaries(accessToken) || [];
    propertiesToProcess = flattenProperties(summaries);
  }

  if (!propertiesToProcess.length) {
    Logger.log("No properties to process based on your input.");
    try { SpreadsheetApp.getUi().alert("No properties to process based on your input."); } catch (_) {}
    return;
  }

  // Deduplicate by propertyId
  const seen = new Set();
  propertiesToProcess = propertiesToProcess.filter(p => {
    if (!p || !p.propertyId) return false;
    if (seen.has(p.propertyId)) return false;
    seen.add(p.propertyId);
    return true;
  });

  Logger.log(`Listing channel groups for ${propertiesToProcess.length} properties...`);

  // --- Fetch channel groups per property (v1alpha) ---
  let totalGroups = 0;

  for (const prop of propertiesToProcess) {
    const { accountId, accountName, propertyId, propertyName } = prop;
    const formattedPropertyId = formatPropertyId(propertyId);
    const baseUrl = `https://analyticsadmin.googleapis.com/v1alpha/${formattedPropertyId}/channelGroups`;

    const options = {
      method: "get",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      },
      muteHttpExceptions: true
    };

    let nextPageToken = null;
    do {
      let url = baseUrl;
      if (nextPageToken) url += `?pageToken=${encodeURIComponent(nextPageToken)}`;

      try {
        const res = UrlFetchApp.fetch(url, options);
        const json = JSON.parse(res.getContentText());

        const groups = json.channelGroups || [];
        groups.forEach(group => {
          const resource = group.name || "";                       // properties/{pid}/channelGroups/{id}
          const shortId  = resource.split("/").pop() || "";        // {id}
          const rules    = group.groupingRule ? JSON.stringify(group.groupingRule) : "None";
          sheet.appendRow([
            accountId,
            accountName,
            propertyId,
            propertyName,
            shortId,
            resource,
            group.displayName || "",
            group.description || "",
            rules,
            "n"
          ]);
        });

        totalGroups += groups.length;
        nextPageToken = json.nextPageToken || null;
      } catch (e) {
        Logger.log(`Error fetching channel groups for ${propertyId}: ${e.message}`);
        // move on to next property
        nextPageToken = null;
      }
    } while (nextPageToken);
  }

  Logger.log(`Completed listing for ${propertiesToProcess.length} properties → ${sheetName}`);
  try {
    SpreadsheetApp.getUi().alert(`Loaded ${totalGroups} channel groups across ${propertiesToProcess.length} properties. Sheet: ${sheetName}`);
  } catch (_) {}
}

/**
 * Update Channel Groups from the "updateChannelGroups" sheet.
 * Headers (case-insensitive):
 *   Property ID | Channel Group ID | displayName | description | groupingRule
 * - Channel Group ID can be either bare id ("123456") or full name ("properties/XXX/channelGroups/123456")
 * - Empty cells = do not update that field.
 */
function updateChannelGroups() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui;
  try { ui = SpreadsheetApp.getUi(); } catch (_) {}

  var sheet = ss.getSheetByName("updateChannelGroups");
  if (!sheet) { safeAlert_("Sheet not found", "Sheet 'updateChannelGroups' not found."); return; }

  var data = sheet.getDataRange().getValues();
  if (!data || data.length < 2) {
    safeAlert_("No data", "No rows found in 'updateChannelGroups' (need headers + at least 1 row).");
    return;
  }

  // Normalize headers
  var norm = function(s){ return String(s||"").trim().toLowerCase(); };
  var headers = data[0].map(norm);

  var propIdx = headers.indexOf("property id");
  var cgIdx   = headers.indexOf("channel group id");
  var dnIdx   = headers.indexOf("displayname");
  var dsIdx   = headers.indexOf("description");
  var grIdx   = headers.indexOf("groupingrule");

  if (propIdx === -1 || cgIdx === -1) {
    safeAlert_("Missing headers", "Required headers: Property ID, Channel Group ID. Optional: displayName, description, groupingRule.");
    return;
  }

  // Ensure a Status column exists (append if missing)
  var statusColIdx = headers.indexOf("status");
  if (statusColIdx === -1) {
    sheet.getRange(1, headers.length + 1).setValue("Status");
    statusColIdx = headers.length; // 0-based index in our arrays; +1 when writing to sheet
  }

  var accessToken = ScriptApp.getOAuthToken();
  var ok = 0, fail = 0;

  for (var r = 1; r < data.length; r++) {
    var row = data[r];

    var propertyId  = String(row[propIdx] || "").trim();
    var channelGroupIdRaw = String(row[cgIdx] || "").trim();
    var displayName = dnIdx !== -1 ? String(row[dnIdx] || "").trim() : "";
    var description = dsIdx !== -1 ? String(row[dsIdx] || "").trim() : "";
    var groupingRaw = grIdx !== -1 ? String(row[grIdx] || "").trim() : "";

    // Skip truly blank rows
    if (!propertyId && !channelGroupIdRaw && !displayName && !description && !groupingRaw) continue;

    if (!propertyId || !channelGroupIdRaw) {
      setRowStatus_(sheet, r, statusColIdx, "Missing Property ID or Channel Group ID");
      continue;
    }

    var formattedPropertyId = formatPropertyId(propertyId); // "properties/123"
    var cgId = channelGroupIdRaw.indexOf("/") >= 0
      ? channelGroupIdRaw.split("/").pop()        // full resource name provided
      : channelGroupIdRaw;                         // bare id

    // Build request body & updateMask from non-empty cells
    var body = { name: formattedPropertyId + "/channelGroups/" + cgId };
    var mask = [];

    // If you want to allow renaming, include displayName:
    if (displayName) { body.displayName = displayName; mask.push("displayName"); }
    if (description) { body.description = description; mask.push("description"); }

    if (groupingRaw) {
      try {
        var groupingRule = JSON.parse(groupingRaw);
        if (groupingRule && Object.keys(groupingRule).length > 0) {
          body.groupingRule = groupingRule;
          mask.push("groupingRule");
        }
      } catch (e) {
        setRowStatus_(sheet, r, statusColIdx, "Invalid JSON");
        continue;
      }
    }

    if (mask.length === 0) {
      setRowStatus_(sheet, r, statusColIdx, "Nothing to update");
      continue;
    }

    var url = "https://analyticsadmin.googleapis.com/v1alpha/" +
              formattedPropertyId + "/channelGroups/" + encodeURIComponent(cgId) +
              "?updateMask=" + encodeURIComponent(mask.join(","));

    var options = {
      method: "patch",
      headers: {
        Authorization: "Bearer " + accessToken,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      muteHttpExceptions: true,
      payload: JSON.stringify(body)
    };

    try {
      var res = UrlFetchApp.fetch(url, options);
      var code = res.getResponseCode();
      if (code === 200) {
        setRowStatus_(sheet, r, statusColIdx, "Updated");
        ok++;
      } else {
        setRowStatus_(sheet, r, statusColIdx, "Failed");
        Logger.log("Update failed row " + (r+1) + " :: " + res.getContentText());
        fail++;
      }
    } catch (e) {
      setRowStatus_(sheet, r, statusColIdx, "Failed");
      Logger.log("Update exception row " + (r+1) + " :: " + e.message);
      fail++;
    }
  }

  var msg = "Channel Group updates complete. " + ok + " updated, " + fail + " failed.";
  if (ui) ui.alert(msg); else Logger.log(msg);
}

/** Write a status message into the row's Status column. */
function setRowStatus_(sheet, rowIndex0, statusColIdx0, value) {
  // rowIndex0 is 0-based in our loop; +1 to be 1-based; +1 more for header row => +2
  sheet.getRange(rowIndex0 + 2, statusColIdx0 + 1).setValue(value);
}

/** Minimal alert helper that works both with and without a UI context. */
function safeAlert_(title, msg) {
  try {
    SpreadsheetApp.getUi().alert(title, msg, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    Logger.log("ALERT: " + title + " - " + msg);
  }
}

/** Formats a raw property ID into the full API resource name. */
function formatPropertyId(propertyId) {
  return String(propertyId).startsWith("properties/") ? propertyId : ("properties/" + String(propertyId).trim());
}


/**
 * Create STANDARD Channel Groups for a property from a sheet template.
 * Sheet default: "standardChannelGroups"
 * Required columns (case-insensitive): displayName, description, groupingRule (JSON)
 *
 * @param {string} propertyId  GA4 property id (123... or "properties/123...")
 * @param {string|GoogleAppsScript.Spreadsheet.Sheet} [sheetOrName="standardChannelGroups"]
 * @returns {{ok:number, fail:number}}  counts summary
 */
function createStandardChannelGroups(propertyId, sheetOrName) {
  if (!propertyId) {
    safeAlert_("Missing propertyId", "Please provide a GA4 property ID.");
    return { ok: 0, fail: 0 };
  }

  // Resolve sheet
  var sheet = null;
  if (sheetOrName && typeof sheetOrName === "object" && sheetOrName.getDataRange) {
    sheet = sheetOrName;
  } else {
    var name = typeof sheetOrName === "string" ? sheetOrName : "standardChannelGroups";
    sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  }
  if (!sheet) {
    safeAlert_("Sheet not found", "Sheet 'standardChannelGroups' not found.");
    return { ok: 0, fail: 0 };
  }

  var values = sheet.getDataRange().getValues();
  if (!values || values.length <= 1) {
    safeAlert_("No data", "No rows found in 'standardChannelGroups' (need headers + at least 1 row).");
    return { ok: 0, fail: 0 };
  }

  // Case-insensitive header map
  var norm = function (s) { return String(s || "").trim().toLowerCase(); };
  var headers = values[0].map(norm);
  var find = function (want) { return headers.indexOf(norm(want)); };

  var dnIdx = find("displayname");
  var dsIdx = find("description");
  var grIdx = find("groupingrule");

  if ([dnIdx, grIdx].some(function (i){ return i === -1; })) {
    Logger.log("Headers seen: " + JSON.stringify(headers));
    safeAlert_("Missing headers", "Required headers: displayName, groupingRule (optional: description).");
    return { ok: 0, fail: 0 };
  }

  var formattedPropertyId = formatPropertyId(propertyId); // "properties/123"
  var baseUrl = "https://analyticsadmin.googleapis.com/v1alpha/" + formattedPropertyId + "/channelGroups";

  var ok = 0, fail = 0;

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var displayName = String(row[dnIdx] || "").trim();
    var description = dsIdx !== -1 ? String(row[dsIdx] || "").trim() : "";
    var groupingRuleRaw = String(row[grIdx] || "").trim();

    // Skip truly blank rows
    if (!displayName && !groupingRuleRaw && !description) continue;

    // Required fields
    if (!displayName || !groupingRuleRaw) {
      Logger.log("Row " + (r + 1) + ": missing displayName or groupingRule — skipped.");
      fail++; 
      continue;
    }

    // Parse groupingRule JSON safely
    var groupingRule;
    try {
      groupingRule = JSON.parse(groupingRuleRaw);
    } catch (e) {
      Logger.log("Row " + (r + 1) + ": groupingRule is not valid JSON — skipped. " + e.message);
      fail++;
      continue;
    }

    var payload = {
      displayName: displayName,
      description: description || "",
      groupingRule: groupingRule
    };

    var options = {
      method: "post",
      contentType: "application/json",
      headers: {
        Authorization: "Bearer " + ScriptApp.getOAuthToken(),
        Accept: "application/json"
      },
      muteHttpExceptions: true,
      payload: JSON.stringify(payload)
    };

    try {
      var res = UrlFetchApp.fetch(baseUrl, options);
      var code = res.getResponseCode();
      if (code === 200 || code === 201) {
        ok++;
        Logger.log("OK: Channel Group '" + displayName + "' → " + propertyId);
      } else {
        fail++;
        Logger.log("FAIL (" + code + "): '" + displayName + "' → " + propertyId + " :: " + res.getContentText());
      }
    } catch (e) {
      fail++;
      Logger.log("ERROR: '" + displayName + "' → " + propertyId + " :: " + e.message);
    }
  }

  Logger.log("Standard channel groups: " + ok + " created, " + fail + " failed.");
  try { SpreadsheetApp.getUi().alert("Standard channel groups: " + ok + " created, " + fail + " failed for " + propertyId + "."); } catch (_) {}

  return { ok: ok, fail: fail };
}
