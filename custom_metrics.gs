/**
 * Custom Metrics — list with optional filters (Property IDs or Account IDs)
 * UI flow mirrors listCustomDimensions() dual-prompt.
 */
function listCustomMetrics() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const accessToken = ScriptApp.getOAuthToken();

  // --- Gather filters via UI (if available) ---
  let propInput = "";
  let acctInput = "";
  try {
    const ui = SpreadsheetApp.getUi();

    const propResp = ui.prompt(
      "List Custom Metrics",
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

    if (propInput && acctInput) {
      ui.alert("Please provide either Property IDs OR Account IDs, not both.");
      return;
    }
  } catch (e) {
    // No UI context (running from editor) -> proceed with ALL
    Logger.log("No UI context; proceeding with ALL properties.");
  }

  // --- Prepare output sheet ---
  const sheetName = "GA4 Custom Metrics " + timestampForSheet();
  const sheet = ss.insertSheet(sheetName);
  sheet.appendRow([
    "Account ID",
    "Account Name",
    "Property ID",
    "Property Name",
    "Display Name",
    "Parameter Name",
    "Scope",
    "Unit",
    "Description"
  ]);

  // Helper to normalize numeric CSV
  const parseIdCsv = (txt) =>
    String(txt || "")
      .split(",")
      .map(s => s.trim())
      .filter(s => /^[0-9]+$/.test(s));

  const propIdsFilter = parseIdCsv(propInput);
  const acctIdsFilter = parseIdCsv(acctInput);

  // --- Build property list to process ---
  let propertiesToProcess = []; // [{accountId, accountName, propertyId, propertyName}]

  if (propIdsFilter.length > 0) {
    // Explicit property IDs
    propertiesToProcess = propIdsFilter.map(pid => {
      const meta = fetchPropertyMeta_(pid, accessToken); // shared helper from dimensions file
      return meta || { accountId: "", accountName: "", propertyId: pid, propertyName: "" };
    });
  } else if (acctIdsFilter.length > 0) {
    // All properties under the given accounts
    acctIdsFilter.forEach(accountId => {
      const props = fetchPropertiesForAccount_(accountId, accessToken); // shared helper from dimensions file
      propertiesToProcess.push(...props);
    });
  } else {
    // Everything accessible
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

  Logger.log(`Listing custom metrics for ${propertiesToProcess.length} properties...`);

  // --- Fetch metrics for each property (paged) ---
  for (const prop of propertiesToProcess) {
    const { accountId, accountName, propertyId, propertyName } = prop;

    let nextPageToken = null;
    do {
      const resp = getCustomMetricsPage_(accessToken, propertyId, nextPageToken) || {};
      const metrics = resp.customMetrics || [];
      nextPageToken = resp.nextPageToken;

      if (metrics.length === 0 && !nextPageToken) {
        sheet.appendRow([accountId, accountName, propertyId, propertyName, "—", "No custom metrics", "", "", ""]);
      } else {
        metrics.forEach(m => {
          sheet.appendRow([
            accountId,
            accountName,
            propertyId,
            propertyName,
            m.displayName || "",
            m.parameterName || "",
            m.scope || "",           // should be "EVENT" or blank
            m.measurementUnit || "", // API field name is measurementUnit
            m.description || ""
          ]);
        });
      }
    } while (nextPageToken);
  }

  Logger.log(`Completed listing for ${propertiesToProcess.length} properties → ${sheetName}`);
  try { SpreadsheetApp.getUi().alert(`Completed! Wrote results to sheet: ${sheetName}`); } catch (_) {}
}

/**
 * Paged fetch for custom metrics (scoped helper to avoid name collisions).
 */
function getCustomMetricsPage_(accessToken, propertyId, pageToken) {
  let url = `https://analyticsadmin.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}/customMetrics`;
  if (pageToken) url += `?pageToken=${encodeURIComponent(pageToken)}`;

  const options = {
    method: "get",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    return JSON.parse(response.getContentText());
  } catch (e) {
    Logger.log(`Error fetching custom metrics for property ${propertyId}: ${e.message}`);
    return {};
  }
}

function createAdHocCustomMetrics() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("newMetrics");
  if (!sheet) {
    ui.alert("Sheet 'newMetrics' not found.");
    return;
  }

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    ui.alert("No metrics found in 'newMetrics' sheet.");
    return;
  }

  const headers = data[0].map(h => h.toString().trim());
  const propertyIdIndex = headers.indexOf("Property ID");
  const nameIndex = headers.indexOf("Name");
  const paramNameIndex = headers.indexOf("Parameter Name");
  const scopeIndex = headers.indexOf("Scope");
  const unitIndex = headers.indexOf("Unit");
  const descIndex = headers.indexOf("Description");

  if ([propertyIdIndex, nameIndex, paramNameIndex, scopeIndex, unitIndex].some(index => index === -1)) {
    ui.alert("Missing one or more required headers in 'newMetrics' sheet.");
    return;
  }

  let successCount = 0;
  let failCount = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const propertyId = String(row[propertyIdIndex] || "").trim();
    const name = String(row[nameIndex] || "").trim();
    const paramName = String(row[paramNameIndex] || "").trim();
    const scope = String(row[scopeIndex] || "").trim();
    const unit = String(row[unitIndex] || "").trim();
    const description = descIndex !== -1 ? String(row[descIndex] || "").trim() : "";

    if (!propertyId || !name || !paramName || !scope || !unit) {
      Logger.log(`Skipping row ${i + 1} due to missing values.`);
      continue;
    }

    if (scope.toUpperCase() !== "EVENT") {
      Logger.log(`Skipping row ${i + 1}: Invalid scope '${scope}' (must be 'EVENT').`);
      continue;
    }

    const formattedPropertyId = formatPropertyId(propertyId);
    const url = `https://analyticsadmin.googleapis.com/v1beta/${formattedPropertyId}/customMetrics`;

    const payload = {
      displayName: name,
      parameterName: paramName,
      scope: scope.toUpperCase(),
      measurementUnit: unit.toUpperCase(),
      description: description
    };

    const options = {
      method: "post",
      contentType: "application/json",
      headers: {
        Authorization: `Bearer ${ScriptApp.getOAuthToken()}`,
        Accept: "application/json"
      },
      muteHttpExceptions: true,
      payload: JSON.stringify(payload)
    };

    try {
      const response = UrlFetchApp.fetch(url, options);
      const responseCode = response.getResponseCode();
      const responseText = response.getContentText();

      if (responseCode === 200 || responseCode === 201) {
        successCount++;
        Logger.log(`Successfully created metric: ${name} for property ${propertyId}`);
      } else if (responseCode === 429) {
        Logger.log(`Quota exceeded. Retrying in 5 seconds...`);
        Utilities.sleep(5000);
        i--; // Retry the same row
      } else {
        failCount++;
        Logger.log(`Failed to create metric: ${name} for property ${propertyId}. Response: ${responseText}`);
      }
    } catch (error) {
      failCount++;
      Logger.log(`Error creating metric: ${name} for property ${propertyId}. Error: ${error.message}`);
    }

    Utilities.sleep(2000); // avoid rate limits
  }

  ui.alert(`Process completed: ${successCount} metrics created, ${failCount} failures.`);
}


/**
 * Create STANDARD custom metrics from the "standardMetrics" sheet.
 * Required columns: Name, Parameter Name, Scope, Unit  (optional: Description)
 * @param {string} propertyId  GA4 property id (123456789 or "properties/123456789")
 * @param {GoogleAppsScript.Spreadsheet.Sheet|string} [metricSheetOrName="standardMetrics"]
 *        Either a Sheet object or the sheet name to read from.
 */
function createStandardCustomMetrics(propertyId, metricSheetOrName) {
  if (!propertyId) {
    safeAlert_("Missing propertyId", "Please provide a GA4 property ID.");
    return;
  }

  // Resolve sheet
  let sheet = null;
  if (metricSheetOrName && typeof metricSheetOrName === "object" && metricSheetOrName.getDataRange) {
    sheet = metricSheetOrName;
  } else {
    const name = typeof metricSheetOrName === "string" ? metricSheetOrName : "standardMetrics";
    sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  }
  if (!sheet) {
    safeAlert_("Sheet not found", "Sheet 'standardMetrics' not found.");
    return;
  }

  const data = sheet.getDataRange().getValues();
  if (!data || data.length <= 1) {
    safeAlert_("No data", "No rows found in 'standardMetrics' (need headers + at least 1 row).");
    return;
  }

  // Case-insensitive header map
  const headers = data[0].map(h => String(h || "").trim());
  const idx = (label) => headers.findIndex(h => h.toLowerCase() === label.toLowerCase());

  const nameIndex      = idx("Name");
  const paramNameIndex = idx("Parameter Name");
  const scopeIndex     = idx("Scope");
  const unitIndex      = idx("Unit");
  const descIndex      = idx("Description");

  if ([nameIndex, paramNameIndex, scopeIndex, unitIndex].some(i => i === -1)) {
    safeAlert_("Missing headers", "Required headers: Name, Parameter Name, Scope, Unit.");
    return;
  }

  const formattedPropertyId = formatPropertyId(propertyId);
  const baseUrl = `https://analyticsadmin.googleapis.com/v1beta/${formattedPropertyId}/customMetrics`;

  let ok = 0, fail = 0;

  for (let r = 1; r < data.length; r++) {
    const row = data[r];

    // 🚨 Skip completely empty rows
    if (row.every(cell => !cell || String(cell).trim() === "")) {
      continue;
    }

    const name       = String(row[nameIndex] || "").trim();
    const paramName  = String(row[paramNameIndex] || "").trim();
    const scope      = String(row[scopeIndex] || "").trim();
    const unit       = String(row[unitIndex] || "").trim();
    const description= descIndex !== -1 ? String(row[descIndex] || "").trim() : "";

    if (!name || !paramName || !unit) {
      Logger.log(`Row ${r+1}: missing Name/Parameter Name/Unit — skipped.`);
      continue;
    }

    // GA4 requires parameterName to start with a letter
    if (!/^[a-zA-Z]/.test(paramName)) {
      Logger.log(`Row ${r+1}: invalid parameterName '${paramName}' (must start with a letter) — skipped.`);
      continue;
    }

    const payload = {
      displayName: name,
      parameterName: paramName,
      ...(scope ? { scope: scope } : {}),
      measurementUnit: unit,
      description: description
    };

    const options = {
      method: "post",
      contentType: "application/json",
      headers: {
        Authorization: `Bearer ${ScriptApp.getOAuthToken()}`,
        Accept: "application/json"
      },
      muteHttpExceptions: true,
      payload: JSON.stringify(payload)
    };

    try {
      const res  = UrlFetchApp.fetch(baseUrl, options);
      const code = res.getResponseCode();
      if (code === 200 || code === 201) {
        ok++;
        Logger.log(`OK: metric ${name} → ${propertyId}`);
      } else {
        fail++;
        Logger.log(`FAIL (${code}): metric ${name} → ${propertyId} :: ${res.getContentText()}`);
      }
    } catch (e) {
      fail++;
      Logger.log(`ERROR: metric ${name} → ${propertyId} :: ${e.message}`);
    }
  }

  Logger.log(`Standard metrics: ${ok} created, ${fail} failed.`);
  safeAlert_('Create Standard Metrics', `Completed: ${ok} created, ${fail} failed for ${propertyId}.`);
}

/**
 * Archive custom metrics using the "archiveMetrics" sheet.
 * Sheet headers required: "Property ID", "Parameter Name"
 */
function archiveCustomMetrics() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("archiveMetrics");
  if (!sheet) {
    ui.alert("Sheet 'archiveMetrics' not found.");
    return;
  }

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    ui.alert("No rows found in 'archiveMetrics' sheet.");
    return;
  }

  const headersRow = data[0].map(h => h.toString().trim());
  const propertyIdIndex = headersRow.indexOf("Property ID");
  const paramNameIndex  = headersRow.indexOf("Parameter Name");

  if (propertyIdIndex === -1 || paramNameIndex === -1) {
    ui.alert("Missing 'Property ID' or 'Parameter Name' header in 'archiveMetrics'.");
    return;
  }

  let ok = 0, fail = 0;

  for (let i = 1; i < data.length; i++) {
    const propertyId = String(data[i][propertyIdIndex] || "").trim();
    const paramName  = String(data[i][paramNameIndex]  || "").trim();

    // Skip empty rows quickly
    if (!(propertyId || paramName)) continue;

    if (!propertyId || !paramName) {
      Logger.log(`Skipping row ${i + 1} due to missing values.`);
      continue;
    }

    const formattedPropertyId = formatPropertyId(propertyId);
    const headers = {
      Authorization: `Bearer ${ScriptApp.getOAuthToken()}`,
      Accept: "application/json"
    };

    try {
      const allMetrics = getAllCustomMetrics(formattedPropertyId, headers);
      Logger.log(`Retrieved ${allMetrics.length} metrics from ${propertyId}`);

      const match = allMetrics.find(m => m.parameterName === paramName);

      if (!match) {
        fail++;
        Logger.log(`Parameter '${paramName}' not found in ${propertyId}`);
        continue;
      }

      const archiveUrl = `https://analyticsadmin.googleapis.com/v1beta/${match.name}:archive`;
      const archiveResponse = UrlFetchApp.fetch(archiveUrl, {
        method: "post",
        headers,
        muteHttpExceptions: true
      });

      if (archiveResponse.getResponseCode() === 200) {
        ok++;
        Logger.log(`Archived metric '${paramName}' in ${propertyId}`);
      } else {
        fail++;
        Logger.log(`Failed to archive metric '${paramName}' in ${propertyId}. :: ${archiveResponse.getContentText()}`);
      }

    } catch (e) {
      fail++;
      Logger.log(`Error processing metric '${paramName}' in ${propertyId}: ${e.message}`);
    }
  }

  ui.alert(`Metric archiving complete: ${ok} archived, ${fail} failed.`);
}

/**
 * Fetch ALL custom metrics for a property (handles paging).
 * @param {string} formattedPropertyId e.g. "properties/123456789"
 * @param {object} headers             request headers with Authorization
 * @return {Array<object>}
 */
function getAllCustomMetrics(formattedPropertyId, headers) {
  const allMetrics = [];
  let pageToken = "";
  const baseUrl = `https://analyticsadmin.googleapis.com/v1beta/${formattedPropertyId}/customMetrics`;

  do {
    let url = baseUrl;
    if (pageToken) url += `?pageToken=${encodeURIComponent(pageToken)}`;

    const response = UrlFetchApp.fetch(url, {
      method: "get",
      headers,
      muteHttpExceptions: true
    });

    const json = JSON.parse(response.getContentText());
    if (json.customMetrics) allMetrics.push(...json.customMetrics);
    pageToken = json.nextPageToken || "";
  } while (pageToken);

  return allMetrics;
}
