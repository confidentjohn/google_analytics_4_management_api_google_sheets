/**
 * Custom Dimensions
 * - listCustomDimensions()                : list across selected/all properties
 * - createAdHocCustomDimensions()         : create from "newDimensions"
 * - archiveCustomDimensions()             : archive using "archiveDimensions"
 * - getCustomDimensionsPage()             : low-level single-page fetch
 * - getAllCustomDimensions()              : high-level all-pages fetch
 *
 * Requires shared helpers defined elsewhere:
 *   formatPropertyId, timestampForSheet, getAllAccountSummaries, flattenProperties,
 *   safeAlert_, getUserEmail_, sendCompletionEmail(userEmail, title, count, sheetName)
 */

/**
 * List custom dimensions for:
 *  - specific Property IDs (CSV), OR
 *  - specific Account IDs (CSV), OR
 *  - everything (leave both blank)
 */
function listCustomDimensions() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const accessToken = ScriptApp.getOAuthToken();

  // --- Gather filters via UI (if available) ---
  let propInput = "";
  let acctInput = "";
  try {
    const ui = SpreadsheetApp.getUi();

    const propResp = ui.prompt(
      "List Custom Dimensions",
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

    // Safety: both filled is not allowed
    if (propInput && acctInput) {
      ui.alert("Please provide either Property IDs OR Account IDs, not both.");
      return;
    }
  } catch (e) {
    // No UI context (running from editor) -> proceed with ALL
    Logger.log("No UI context; proceeding with ALL properties.");
  }

  // --- Prepare output sheet ---
  const sheetName = "GA4 Custom Dimensions " + timestampForSheet();
  const sheet = ss.insertSheet(sheetName);
  sheet.appendRow([
    "Account ID",
    "Account Name",
    "Property ID",
    "Property Name",
    "Display Name",
    "Parameter Name",
    "Scope",
    "Description"
  ]);

  // --- Decide which properties to process ---
  // Helper to normalize a CSV string of numeric IDs
  const parseIdCsv = (txt) =>
    String(txt || "")
      .split(",")
      .map(s => s.trim())
      .filter(s => /^[0-9]+$/.test(s));

  const propIdsFilter = parseIdCsv(propInput);
  const acctIdsFilter = parseIdCsv(acctInput);

  /** @type {{accountId:string,accountName:string,propertyId:string,propertyName:string}[]} */
  let propertiesToProcess = [];

  if (propIdsFilter.length > 0) {
    // Case 1: explicit property IDs
    // For each property ID, fetch property to get names + parent account
    propertiesToProcess = propIdsFilter.map(pid => {
      const meta = fetchPropertyMeta_(pid, accessToken); // {accountId, accountName?, propertyId, propertyName}
      return meta || { accountId: "", accountName: "", propertyId: pid, propertyName: "" };
    });
  } else if (acctIdsFilter.length > 0) {
    // Case 2: explicit account IDs
    // For each account, list its properties
    acctIdsFilter.forEach(accountId => {
      const props = fetchPropertiesForAccount_(accountId, accessToken); // [{accountId, accountName, propertyId, propertyName}]
      propertiesToProcess.push(...props);
    });
  } else {
    // Case 3: EVERYTHING (all accounts you can access)
    const summaries = getAllAccountSummaries(accessToken) || [];
    propertiesToProcess = flattenProperties(summaries); // [{accountId, accountName, propertyId, propertyName}]
  }

  if (!propertiesToProcess.length) {
    Logger.log("No properties to process based on your input.");
    try { SpreadsheetApp.getUi().alert("No properties to process based on your input."); } catch (_) {}
    return;
  }

  // Deduplicate by propertyId (in case of overlaps)
  const seen = new Set();
  propertiesToProcess = propertiesToProcess.filter(p => {
    if (!p || !p.propertyId) return false;
    if (seen.has(p.propertyId)) return false;
    seen.add(p.propertyId);
    return true;
  });

  Logger.log(`Listing custom dimensions for ${propertiesToProcess.length} properties...`);

  // --- Fetch custom dimensions for each property (paged) ---
  for (const prop of propertiesToProcess) {
    const { accountId, accountName, propertyId, propertyName } = prop;
    let nextPageToken = null;

    do {
      const resp = getCustomDimensionsPage(accessToken, propertyId, nextPageToken) || {};
      const dims = resp.customDimensions || [];
      nextPageToken = resp.nextPageToken;

      if (dims.length === 0 && !nextPageToken) {
        sheet.appendRow([accountId, accountName, propertyId, propertyName, "—", "No custom dimensions", "", ""]);
      } else {
        dims.forEach(d => {
          sheet.appendRow([
            accountId,
            accountName,
            propertyId,
            propertyName,
            d.displayName || "",
            d.parameterName || "",
            d.scope || "",
            d.description || ""
          ]);
        });
      }
    } while (nextPageToken);
  }

  Logger.log(`Completed listing for ${propertiesToProcess.length} properties → ${sheetName}`);
  // completion email
  const userEmail = getUserEmail_();
  sendCompletionEmail(userEmail, "Custom Dimensions (List)", propertiesToProcess.length, sheetName);
  try { SpreadsheetApp.getUi().alert(`Completed! Wrote results to sheet: ${sheetName}`); } catch (_) {}
}

/**
 * Get property displayName and parent account for a propertyId.
 * Returns {accountId, accountName, propertyId, propertyName} or null.
 */
function fetchPropertyMeta_(propertyId, accessToken) {
  const url = `https://analyticsadmin.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}`;
  const options = {
    method: "get",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    muteHttpExceptions: true
  };
  try {
    const res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    if (code !== 200) {
      Logger.log(`Property meta fetch failed (${code}) for ${propertyId}: ${res.getContentText()}`);
      return null;
    }
    const json = JSON.parse(res.getContentText());
    const propertyName = json.displayName || "";
    const parent = json.parent || "";            // "accounts/123"
    const accountId = parent.replace("accounts/", "");
    // Optional attempt to look up account name from summaries
    let accountName = "";
    try {
      const summaries = getAllAccountSummaries(accessToken) || [];
      const match = (summaries.accountSummaries || summaries).find(s => (s.account || "").endsWith(accountId));
      accountName = match ? (match.displayName || "") : "";
    } catch (_) {}
    return { accountId, accountName, propertyId, propertyName };
  } catch (e) {
    Logger.log(`Error fetching property meta for ${propertyId}: ${e.message}`);
    return null;
  }
}

/**
 * List all properties under a specific accountId.
 * Returns [{accountId, accountName, propertyId, propertyName}]
 */
function fetchPropertiesForAccount_(accountId, accessToken) {
  const results = [];
  // Get the account display name from summaries (optional)
  let accountName = "";
  try {
    const summaries = getAllAccountSummaries(accessToken) || [];
    const match = (summaries.accountSummaries || summaries).find(s => (s.account || "").endsWith(accountId));
    accountName = match ? (match.displayName || "") : "";
  } catch (_) {}

  let nextPageToken = null;
  do {
    let url = `https://analyticsadmin.googleapis.com/v1beta/properties?pageSize=200&filter=parent:accounts/${encodeURIComponent(accountId)}`;
    if (nextPageToken) url += `&pageToken=${encodeURIComponent(nextPageToken)}`;

    const options = {
      method: "get",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      muteHttpExceptions: true
    };

    try {
      const res = UrlFetchApp.fetch(url, options);
      const json = JSON.parse(res.getContentText());
      const props = json.properties || [];
      props.forEach(p => {
        results.push({
          accountId,
          accountName,
          propertyId: (p.name || "").replace("properties/", ""),
          propertyName: p.displayName || ""
        });
      });
      nextPageToken = json.nextPageToken || null;
    } catch (e) {
      Logger.log(`Error listing properties for account ${accountId}: ${e.message}`);
      break;
    }
  } while (nextPageToken);

  return results;
}

/**
 * Create ad-hoc custom dimensions from "newDimensions" sheet.
 */
function createAdHocCustomDimensions() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("newDimensions");
  if (!sheet) {
    ui.alert("Sheet 'newDimensions' not found.");
    return;
  }

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    ui.alert("No dimensions found in 'newDimensions' sheet.");
    return;
  }

  const headers = data[0].map(h => h.toString().trim());
  const propertyIdIndex = headers.indexOf("Property ID");
  const nameIndex = headers.indexOf("Name");
  const paramNameIndex = headers.indexOf("Parameter Name");
  const scopeIndex = headers.indexOf("Scope");
  const descIndex = headers.indexOf("Description");

  if ([propertyIdIndex, nameIndex, paramNameIndex, scopeIndex].some(index => index === -1)) {
    ui.alert("Missing one or more required headers in 'newDimensions' sheet.");
    return;
  }

  let ok = 0, fail = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const propertyId = String(row[propertyIdIndex] || "").trim();
    const name = String(row[nameIndex] || "").trim();
    const paramName = String(row[paramNameIndex] || "").trim();
    const scope = String(row[scopeIndex] || "").trim();
    const description = descIndex !== -1 ? String(row[descIndex] || "").trim() : "";

    // Skip empty rows
    if (![propertyId, name, paramName, scope].some(Boolean)) continue;

    if (!propertyId || !name || !paramName || !scope) {
      Logger.log(`Skipping row ${i + 1} due to missing values.`);
      continue;
    }

    const formattedPropertyId = formatPropertyId(propertyId);
    const url = `https://analyticsadmin.googleapis.com/v1beta/${formattedPropertyId}/customDimensions`;

    const payload = {
      displayName: name,
      parameterName: paramName,
      scope: scope,
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
      const code = response.getResponseCode();
      if (code === 200 || code === 201) {
        ok++;
        Logger.log(`OK: ${name} → ${propertyId}`);
      } else {
        fail++;
        Logger.log(`FAIL (${code}): ${name} → ${propertyId} :: ${response.getContentText()}`);
      }
    } catch (error) {
      fail++;
      Logger.log(`ERROR: ${name} → ${propertyId} :: ${error.message}`);
    }
  }

  ui.alert(`Process completed: ${ok} dimensions created, ${fail} failures.`);
}

/**
 * Archive custom dimensions using the "archiveDimensions" sheet.
 * Sheet headers required: "Property ID", "Parameter Name"
 */
function archiveCustomDimensions() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("archiveDimensions");
  if (!sheet) {
    ui.alert("Sheet 'archiveDimensions' not found.");
    return;
  }

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    ui.alert("No rows found in 'archiveDimensions' sheet.");
    return;
  }

  const headersRow = data[0].map(h => h.toString().trim());
  const propertyIdIndex = headersRow.indexOf("Property ID");
  const paramNameIndex = headersRow.indexOf("Parameter Name");

  if (propertyIdIndex === -1 || paramNameIndex === -1) {
    ui.alert("Missing 'Property ID' or 'Parameter Name' header in 'archiveDimensions'.");
    return;
  }

  let ok = 0, fail = 0;

  for (let i = 1; i < data.length; i++) {
    const propertyId = String(data[i][propertyIdIndex] || "").trim();
    const paramName  = String(data[i][paramNameIndex]  || "").trim();

    // Skip empty rows
    if (![propertyId, paramName].some(Boolean)) continue;

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
      const allDimensions = getAllCustomDimensions(formattedPropertyId, headers);
      Logger.log(`Retrieved ${allDimensions.length} dimensions from ${propertyId}`);

      const match = allDimensions.find(dim => dim.parameterName === paramName);

      if (!match) {
        fail++;
        Logger.log(`Parameter '${paramName}' not found in ${propertyId}`);
        continue;
      }

      const archiveUrl = `https://analyticsadmin.googleapis.com/v1beta/${match.name}:archive`;
      const archiveResponse = UrlFetchApp.fetch(archiveUrl, {
        method: "post",
        headers: headers,
        muteHttpExceptions: true
      });

      if (archiveResponse.getResponseCode() === 200) {
        ok++;
        Logger.log(`Archived '${paramName}' in ${propertyId}`);
      } else {
        fail++;
        Logger.log(`Failed to archive '${paramName}' in ${propertyId}. :: ${archiveResponse.getContentText()}`);
      }

    } catch (e) {
      fail++;
      Logger.log(`Error processing '${paramName}' in ${propertyId}: ${e.message}`);
    }
  }

  ui.alert(`Archiving complete: ${ok} archived, ${fail} failed.`);
}

/**
 * Low-level: fetch ONE PAGE of custom dimensions for a property.
 * Returns raw JSON { customDimensions:[...], nextPageToken: "..." }
 */
function getCustomDimensionsPage(accessToken, propertyId, pageToken) {
  let url = `https://analyticsadmin.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}/customDimensions`;
  if (pageToken) url += `?pageToken=${encodeURIComponent(pageToken)}`;

  const options = {
    method: "get",
    headers: { Authorization: `Bearer ${accessToken}` },
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    return JSON.parse(response.getContentText());
  } catch (e) {
    Logger.log(`Error fetching custom dimensions (page) for property ${propertyId}: ${e.message}`);
    return {};
  }
}

/**
 * High-level: fetch ALL custom dimensions for a property.
 * @param {string} formattedPropertyId e.g. "properties/123456789"
 * @param {object} headers             request headers with Authorization
 * @return {Array<object>}
 */
function getAllCustomDimensions(formattedPropertyId, headers) {
  const allDimensions = [];
  let pageToken = "";
  const baseUrl = `https://analyticsadmin.googleapis.com/v1beta/${formattedPropertyId}/customDimensions`;

  do {
    let url = baseUrl;
    if (pageToken) url += `?pageToken=${pageToken}`;

    const response = UrlFetchApp.fetch(url, {
      method: "get",
      headers: headers,
      muteHttpExceptions: true
    });

    const json = JSON.parse(response.getContentText());
    if (json.customDimensions) allDimensions.push(...json.customDimensions);
    pageToken = json.nextPageToken || "";
  } while (pageToken);

  return allDimensions;
}

/**
 * Create STANDARD custom dimensions from the "standardDimensions" sheet.
 * Columns required: Name, Parameter Name, Scope  (optional: Description)
 * @param {string} propertyId               GA4 property id (123456789 or "properties/123456789")
 * @param {GoogleAppsScript.Spreadsheet.Sheet|string} [dimensionSheetOrName="standardDimensions"]
 *        Either a Sheet object or the sheet name to read from.
 */
function createStandardCustomDimensions(propertyId, dimensionSheetOrName) {
  if (!propertyId) {
    safeAlert_("Missing propertyId", "Please provide a GA4 property ID.");
    return;
  }

  // Resolve sheet
  let sheet = null;
  if (dimensionSheetOrName && typeof dimensionSheetOrName === "object" && dimensionSheetOrName.getDataRange) {
    sheet = dimensionSheetOrName;
  } else {
    const name = typeof dimensionSheetOrName === "string" ? dimensionSheetOrName : "standardDimensions";
    sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  }

  if (!sheet) {
    safeAlert_("Sheet not found", "Sheet 'standardDimensions' not found.");
    return;
  }

  const data = sheet.getDataRange().getValues();
  if (!data || data.length <= 1) {
    safeAlert_("No data", "No rows found in 'standardDimensions' (need headers + at least 1 row).");
    return;
  }

  // Case-insensitive header map
  const headers = data[0].map(h => String(h || "").trim());
  const idx = (label) => headers.findIndex(h => h.toLowerCase() === label.toLowerCase());

  const nameIndex      = idx("Name");
  const paramNameIndex = idx("Parameter Name");
  const scopeIndex     = idx("Scope");
  const descIndex      = idx("Description");

  if ([nameIndex, paramNameIndex, scopeIndex].some(i => i === -1)) {
    safeAlert_("Missing headers", "Required headers: Name, Parameter Name, Scope.");
    return;
  }

  const formattedPropertyId = formatPropertyId(propertyId);
  const baseUrl = `https://analyticsadmin.googleapis.com/v1beta/${formattedPropertyId}/customDimensions`;

  let ok = 0, fail = 0;

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const name = String(row[nameIndex] || "").trim();
    const paramName = String(row[paramNameIndex] || "").trim();
    const scope = String(row[scopeIndex] || "").trim();
    const description = descIndex !== -1 ? String(row[descIndex] || "").trim() : "";

    // Skip empty rows
    if (![name, paramName, scope].some(Boolean)) continue;

    const options = {
      method: "post",
      contentType: "application/json",
      headers: {
        Authorization: `Bearer ${ScriptApp.getOAuthToken()}`,
        Accept: "application/json"
      },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        displayName: name,
        parameterName: paramName,
        scope: scope,
        description: description
      })
    };

    try {
      const res = UrlFetchApp.fetch(baseUrl, options);
      const code = res.getResponseCode();
      if (code === 200 || code === 201) {
        ok++;
        Logger.log(`OK: ${name} → ${propertyId}`);
      } else {
        fail++;
        Logger.log(`FAIL (${code}): ${name} → ${propertyId} :: ${res.getContentText()}`);
      }
    } catch (e) {
      fail++;
      Logger.log(`ERROR: ${name} → ${propertyId} :: ${e.message}`);
    }
  }

  Logger.log(`Standard dimensions: ${ok} created, ${fail} failed.`);
  safeAlert_('Create Standard Dimensions', `Completed: ${ok} created, ${fail} failed for ${propertyId}.`);
}
