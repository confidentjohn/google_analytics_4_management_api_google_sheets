/**
 * Calculated Metrics (list) - v1alpha
 * Prompts for Property IDs or Account IDs. If both empty, lists for ALL accessible properties.
 * Output columns:
 *   Account ID | Account Name | Property ID | Property Name | Metric ID | Display Name | Formula | Metric Unit | Description
 */
function listCalculatedMetrics() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const accessToken = ScriptApp.getOAuthToken();

  // --- Gather filters via UI (if available) ---
  let propInput = "";
  let acctInput = "";
  try {
    const ui = SpreadsheetApp.getUi();

    const propResp = ui.prompt(
      "List Calculated Metrics",
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
    // Running from editor (no UI) → proceed with ALL
    Logger.log("No UI context; proceeding with ALL properties.");
  }

  // --- Prepare output sheet ---
  const sheetName = "GA4 Calculated Metrics " + timestampForSheet();
  const sheet = ss.insertSheet(sheetName);
  sheet.appendRow([
    "Account ID",
    "Account Name",
    "Property ID",
    "Property Name",
    "Metric ID",
    "Display Name",
    "Formula",
    "Metric Unit",
    "Description"
  ]);

  // Helper to normalize a CSV string of numeric IDs
  const parseIdCsv = (txt) =>
    String(txt || "")
      .split(",")
      .map(s => s.trim())
      .filter(s => /^[0-9]+$/.test(s));

  const propIdsFilter = parseIdCsv(propInput);
  const acctIdsFilter = parseIdCsv(acctInput);

  // --- Decide which properties to process ---
  let propertiesToProcess = []; // [{accountId, accountName, propertyId, propertyName}]
  if (propIdsFilter.length > 0) {
    // Explicit properties
    propertiesToProcess = propIdsFilter.map(pid => {
      const meta = fetchPropertyMeta_(pid, accessToken);
      return meta || { accountId: "", accountName: "", propertyId: pid, propertyName: "" };
    });
  } else if (acctIdsFilter.length > 0) {
    // Specific accounts → list their properties
    acctIdsFilter.forEach(accountId => {
      const props = fetchPropertiesForAccount_(accountId, accessToken);
      propertiesToProcess.push(...props);
    });
  } else {
    // Everything the user can access
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

  Logger.log(`Listing calculated metrics for ${propertiesToProcess.length} properties...`);

  // --- Fetch calculated metrics per property (paged) ---
  for (const prop of propertiesToProcess) {
    const { accountId, accountName, propertyId, propertyName } = prop;
    let nextPageToken = null;

    do {
      const resp = getCalculatedMetricsPage_(accessToken, propertyId, nextPageToken) || {};
      const calc = resp.calculatedMetrics || [];
      nextPageToken = resp.nextPageToken;

      if (calc.length === 0 && !nextPageToken) {
        sheet.appendRow([accountId, accountName, propertyId, propertyName, "—", "No calculated metrics", "", "", ""]);
      } else {
        calc.forEach(m => {
          sheet.appendRow([
            accountId,
            accountName,
            propertyId,
            propertyName,
            m.calculatedMetricId || "",
            m.displayName || "",
            m.formula || "",
            m.metricUnit || "",
            m.description || ""
          ]);
        });
      }
    } while (nextPageToken);
  }

  Logger.log(`Completed calculated metrics listing → ${sheetName}`);
  try { SpreadsheetApp.getUi().alert(`Completed! Wrote results to sheet: ${sheetName}`); } catch (_) {}

  // Optional: notify via email (expects getUserEmail_ + sendCompletionEmail(userEmail, title, count, sheetName))
  try {
    const userEmail = getUserEmail_();
    if (userEmail) {
      sendCompletionEmail(userEmail, "Calculated Metrics (List)", propertiesToProcess.length, sheetName);
    }
  } catch (e) {
    Logger.log("Email notification skipped: " + e.message);
  }
}

/**
 * Fetches a single page of calculated metrics from the "v1alpha" API.
 * This is a helper function used for retrieving existing calculated metrics.
 * @param {string} accessToken OAuth token.
 * @param {string} propertyId The GA4 property ID (e.g., "123456").
 * @param {string} pageToken The next page token for pagination.
 * @returns {object} The API response object.
 */
function getCalculatedMetricsPage_(accessToken, propertyId, pageToken) {
  const formattedPropertyId = formatPropertyId(propertyId); // "properties/123"
  let url = `https://analyticsadmin.googleapis.com/v1alpha/${formattedPropertyId}/calculatedMetrics`;
  if (pageToken) url += `?pageToken=${encodeURIComponent(pageToken)}`;

  const options = {
    method: "get",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    },
    muteHttpExceptions: true
  };

  try {
    const res = UrlFetchApp.fetch(url, options);
    return JSON.parse(res.getContentText());
  } catch (e) {
    Logger.log(`Error fetching calculated metrics for property ${propertyId}: ${e.message}`);
    return {};
  }
}

/**
 * Creates STANDARD calculated metrics from a Google Sheet.
 * Reads data from the "standardCalculatedMetrics" sheet and creates metrics via the GA4 Admin API (v1alpha).
 * @param {string} propertyId The GA4 property ID.
 * @param {string|GoogleAppsScript.Spreadsheet.Sheet} [sheetOrName="standardCalculatedMetrics"]
 * The name or Sheet object to read from.
 */
function createStandardCalculatedMetrics(propertyId, sheetOrName) {
  if (!propertyId) {
    safeAlert_("Missing propertyId", "Please provide a GA4 property ID.");
    return;
  }

  // Resolve sheet
  let sheet = null;
  if (sheetOrName && typeof sheetOrName === "object" && sheetOrName.getDataRange) {
    sheet = sheetOrName;
  } else {
    const name = typeof sheetOrName === "string" ? sheetOrName : "standardCalculatedMetrics";
    sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  }
  if (!sheet) {
    safeAlert_("Sheet not found", "Sheet 'standardCalculatedMetrics' not found.");
    return;
  }

  const data = sheet.getDataRange().getValues();
  if (!data || data.length <= 1) {
    safeAlert_("No data", "No rows found in 'standardCalculatedMetrics' (need headers + at least 1 row).");
    return;
  }

  // --- Header mapping (robust to odd spacing) ---
  const norm = s => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
  const headers = data[0].map(norm);
  const find = want => headers.findIndex(h => h === norm(want));

  const idIndex   = find("calculated metric id");
  const nameIndex = find("display name");
  const frmIndex  = find("formula");
  const unitIndex = find("metric unit");
  const dscIndex  = find("description");

  if ([idIndex, nameIndex, frmIndex, unitIndex].some(i => i === -1)) {
    Logger.log("Headers seen: " + JSON.stringify(headers));
    safeAlert_(
      "Missing headers",
      "Required headers: Calculated Metric ID, Display Name, Formula, Metric Unit (optional: Description)."
    );
    return;
  }

  const formattedPropertyId = formatPropertyId(propertyId); // "properties/123"
  const baseUrl = `https://analyticsadmin.googleapis.com/v1alpha/${formattedPropertyId}/calculatedMetrics`;

  let ok = 0, fail = 0;
  const idRegex = /^[A-Za-z][A-Za-z0-9_]*$/;

  for (let r = 1; r < data.length; r++) {
    const row = data[r];

    // Read & trim values
    const calculatedMetricId = String(row[idIndex]   || "").trim();
    const displayName        = String(row[nameIndex] || "").trim();
    const formula            = String(row[frmIndex]  || "").trim();
    const metricUnit         = String(row[unitIndex] || "").trim();
    const description        = dscIndex !== -1 ? String(row[dscIndex] || "").trim() : "";

    // Skip truly blank rows (all required empty)
    if (!calculatedMetricId && !displayName && !formula && !metricUnit) {
      continue;
    }

    // Validate fields
    if (!calculatedMetricId || !displayName || !formula || !metricUnit) {
      Logger.log(`Row ${r+1}: missing ID/Name/Formula/Unit — skipped. Parsed: ` +
                 JSON.stringify({calculatedMetricId, displayName, formula, metricUnit}));
      fail++;
      continue;
    }
    if (!idRegex.test(calculatedMetricId)) {
      Logger.log(`Row ${r+1}: invalid Calculated Metric ID '${calculatedMetricId}' — must start with a letter and use letters/numbers/underscores.`);
      fail++;
      continue;
    }

    // --- Start of corrected code ---

    // Build the resource in snake_case. NOTE: calculated_metric_id is NOT in the payload.
    const payloadObj = {
      display_name: displayName,
      formula: formula,
      metric_unit: metricUnit,
      description: description
    };

    // Construct the URL with the calculatedMetricId as a query parameter
    const finalUrl = `${baseUrl}?calculatedMetricId=${encodeURIComponent(calculatedMetricId)}`;

    Logger.log(`POST to URL: ${finalUrl}`);
    Logger.log(`Payload: ${JSON.stringify(payloadObj)}`);

    const options = {
      method: "post",
      contentType: "application/json",
      headers: {
        Authorization: `Bearer ${ScriptApp.getOAuthToken()}`,
        Accept: "application/json"
      },
      muteHttpExceptions: true,
      payload: JSON.stringify(payloadObj)
    };

    // --- End of corrected code ---

    try {
      const res = UrlFetchApp.fetch(finalUrl, options);
      const code = res.getResponseCode();
      if (code === 200 || code === 201) {
        ok++;
        Logger.log(`OK: Calculated metric '${calculatedMetricId}' → ${propertyId}`);
      } else {
        fail++;
        Logger.log(`FAIL (${code}): '${calculatedMetricId}' → ${propertyId} :: ${res.getContentText()}`);
      }
    } catch (e) {
      fail++;
      Logger.log(`ERROR: '${calculatedMetricId}' → ${propertyId} :: ${e.message}`);
    }
  }

  Logger.log(`Standard calculated metrics: ${ok} created, ${fail} failed.`);
  safeAlert_("Create Standard Calculated Metrics", `Completed: ${ok} created, ${fail} failed for ${propertyId}.`);
}

// Helper functions (safeAlert_ and formatPropertyId) would need to be included if they aren't in your project.
// You can define them as follows if needed:

/**
 * Displays an alert box to the user.
 * @param {string} title The alert title.
 * @param {string} msg The alert message.
 */
function safeAlert_(title, msg) {
  try {
    SpreadsheetApp.getUi().alert(title, msg, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch(e) {
    Logger.log(`ALERT: ${title} - ${msg}`);
  }
}

/**
 * Formats a raw property ID into the full API resource name.
 * @param {string} propertyId The raw property ID.
 * @returns {string} The formatted property name.
 */
function formatPropertyId(propertyId) {
  return propertyId.startsWith('properties/') ? propertyId : `properties/${propertyId}`;
}


/**
 * Create calculated metrics from "newCalculatedMetrics".
 * Columns: Property ID, Calculated Metric ID, Display Name, Formula, Metric Unit, Description
 * @param {boolean} [overwrite=false]  If true, PATCH existing metrics instead of skipping.
 */
function createAdHocCalculatedMetrics(overwrite) {
  overwrite = !!overwrite;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("newCalculatedMetrics");
  if (!sheet) { safeAlert_("Sheet not found", "Sheet 'newCalculatedMetrics' not found."); return; }

  const data = sheet.getDataRange().getValues();
  if (!data || data.length <= 1) { safeAlert_("No data", "No rows found in 'newCalculatedMetrics'."); return; }

  // --- Header mapping (case/space insensitive) ---
  const norm = s => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
  const headers = data[0].map(norm);
  const find = want => headers.findIndex(h => h === norm(want));

  const pidIdx  = find("property id");
  const idIdx   = find("calculated metric id");
  const nameIdx = find("display name");
  const frmIdx  = find("formula");
  const unitIdx = find("metric unit");
  const dscIdx  = find("description");

  if ([pidIdx, idIdx, nameIdx, frmIdx, unitIdx].some(i => i === -1)) {
    Logger.log("Headers seen: " + JSON.stringify(headers));
    safeAlert_("Missing headers", "Required: Property ID, Calculated Metric ID, Display Name, Formula, Metric Unit (Description optional).");
    return;
  }

  // Allowed units per GA4 Admin v1alpha enum
  const ALLOWED_UNITS = new Set([
    "METRIC_UNIT_UNSPECIFIED","STANDARD","CURRENCY","FEET","METERS","KILOMETERS","MILES",
    "MILLISECONDS","SECONDS","MINUTES","HOURS"
  ]);
  const idRegex = /^[A-Za-z][A-Za-z0-9_]*$/;

  const accessToken = ScriptApp.getOAuthToken();

  // Cache of existing metric IDs per property to reduce API calls:
  // Map<string propertyId, Set<string calculatedMetricId>>
  const existingByProp = new Map();

  let created = 0, updated = 0, skipped = 0, failed = 0;

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const rawPropertyId       = String(row[pidIdx]  || "").trim();
    const calculatedMetricId  = String(row[idIdx]   || "").trim();
    const displayName         = String(row[nameIdx] || "").trim();
    const formula             = String(row[frmIdx]  || "").trim();
    const metricUnit          = String(row[unitIdx] || "").trim();
    const description         = dscIdx !== -1 ? String(row[dscIdx] || "").trim() : "";

    // Skip truly blank rows (all required empty)
    if (!rawPropertyId && !calculatedMetricId && !displayName && !formula && !metricUnit) continue;

    // Basic validation
    if (!rawPropertyId || !calculatedMetricId || !displayName || !formula || !metricUnit) {
      Logger.log(`Row ${r+1}: missing required field(s)—skipped.`);
      failed++; continue;
    }
    if (!idRegex.test(calculatedMetricId)) {
      Logger.log(`Row ${r+1}: invalid Calculated Metric ID '${calculatedMetricId}' (must start with a letter; letters/numbers/underscores).`);
      failed++; continue;
    }
    if (!ALLOWED_UNITS.has(metricUnit)) {
      Logger.log(`Row ${r+1}: invalid Metric Unit '${metricUnit}'.`);
      failed++; continue;
    }

    const propertyId = rawPropertyId.replace(/^properties\//, ""); // tolerate either form
    const formattedPropertyId = `properties/${propertyId}`;
    const baseUrl = `https://analyticsadmin.googleapis.com/v1alpha/${formattedPropertyId}/calculatedMetrics`;

    // Ensure we have the existing set for this property
    if (!existingByProp.has(propertyId)) {
      const ids = listCalculatedMetricIds_(accessToken, propertyId);
      existingByProp.set(propertyId, ids);
    }
    const existingIds = existingByProp.get(propertyId);

    // Build body (snake_case). NOTE: ID is not in payload.
    const body = {
      display_name: displayName,
      formula: formula,
      metric_unit: metricUnit,
      description: description
    };

    try {
      if (existingIds.has(calculatedMetricId)) {
        if (!overwrite) {
          skipped++;
          Logger.log(`SKIP row ${r+1}: '${calculatedMetricId}' already exists on ${propertyId}.`);
          continue;
        }
        // PATCH update existing
        const patchUrl = `${baseUrl}/${encodeURIComponent(calculatedMetricId)}?updateMask=display_name,formula,metric_unit,description`;
        const res = UrlFetchApp.fetch(patchUrl, {
          method: "patch",
          contentType: "application/json",
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
          muteHttpExceptions: true,
          payload: JSON.stringify(body)
        });
        const code = res.getResponseCode();
        if (code === 200) { updated++; Logger.log(`UPDATED row ${r+1}: '${calculatedMetricId}' on ${propertyId}`); }
        else { failed++; Logger.log(`FAIL PATCH (${code}) row ${r+1}: '${calculatedMetricId}' :: ${res.getContentText()}`); }
      } else {
        // CREATE new (ID in query param)
        const createUrl = `${baseUrl}?calculatedMetricId=${encodeURIComponent(calculatedMetricId)}`;
        const res = UrlFetchApp.fetch(createUrl, {
          method: "post",
          contentType: "application/json",
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
          muteHttpExceptions: true,
          payload: JSON.stringify(body)
        });
        const code = res.getResponseCode();
        if (code === 200 || code === 201) {
          created++;
          existingIds.add(calculatedMetricId);
          Logger.log(`CREATED row ${r+1}: '${calculatedMetricId}' on ${propertyId}`);
        } else {
          failed++;
          Logger.log(`FAIL CREATE (${code}) row ${r+1}: '${calculatedMetricId}' :: ${res.getContentText()}`);
        }
      }
    } catch (e) {
      failed++;
      Logger.log(`ERROR row ${r+1}: '${calculatedMetricId}' :: ${e.message}`);
    }
  }

  Logger.log(`Ad-hoc calculated metrics → created:${created}, updated:${updated}, skipped:${skipped}, failed:${failed}.`);
  safeAlert_("Create Ad-hoc Calculated Metrics",
             `Completed:\nCreated ${created}, Updated ${updated}, Skipped ${skipped}, Failed ${failed}.`);
}

/**
 * Returns Set of calculatedMetricId for a property (v1alpha).
 */
function listCalculatedMetricIds_(accessToken, propertyId) {
  const ids = new Set();
  let pageToken = null;
  do {
    const res = getCalculatedMetricsPage_(accessToken, propertyId, pageToken) || {};
    (res.calculatedMetrics || []).forEach(cm => {
      if (cm.calculatedMetricId) ids.add(cm.calculatedMetricId);
    });
    pageToken = res.nextPageToken || null;
  } while (pageToken);
  return ids;
}





/**
 * Delete calculated metrics listed in the "deleteCalculatedMetrics" sheet (v1alpha).
 * Required headers (case-insensitive): "Property ID", "Calculated Metric ID"
 * Optional: "Confirm" (must be 'y' or 'yes' to proceed)
 *
 * Usage:
 *   deleteCalculatedMetricsFromSheet();          // normal run
 *   deleteCalculatedMetricsFromSheet(true);      // dry-run (logs what WOULD be deleted)
 *
 * Returns nothing; shows a toast/alert + logs a summary.
 */
function deleteCalculatedMetricsFromSheet(dryRun) {
  dryRun = !!dryRun;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("deleteCalculatedMetrics");
  if (!sheet) { safeAlert_("Sheet not found", "Sheet 'deleteCalculatedMetrics' not found."); return; }

  const data = sheet.getDataRange().getValues();
  if (!data || data.length <= 1) { safeAlert_("No data", "No rows found in 'deleteCalculatedMetrics'."); return; }

  // header mapping (case/space-insensitive)
  const norm = s => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
  const headers = data[0].map(norm);
  const idx = want => headers.findIndex(h => h === norm(want));

  const pidIdx  = idx("property id");
  const cmIdIdx = idx("calculated metric id");
  const confIdx = idx("confirm"); // optional

  if ([pidIdx, cmIdIdx].some(i => i === -1)) {
    Logger.log("Headers seen: " + JSON.stringify(headers));
    safeAlert_("Missing headers", "Required columns: Property ID, Calculated Metric ID. Optional: Confirm.");
    return;
  }

  const accessToken = ScriptApp.getOAuthToken();
  let deleted = 0, skipped = 0, failed = 0;

  // Optional: validate ID format (GA requires letter first, then letters/numbers/_)
  const idRegex = /^[A-Za-z][A-Za-z0-9_]*$/;

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const rawProp = String(row[pidIdx]  || "").trim();
    const calcId  = String(row[cmIdIdx] || "").trim();
    const confirm = confIdx !== -1 ? String(row[confIdx] || "").trim().toLowerCase() : "";

    // skip truly empty rows
    if (!rawProp && !calcId && !confirm) continue;

    if (!rawProp || !calcId) {
      Logger.log(`Row ${r+1}: missing Property ID or Calculated Metric ID — skipped.`);
      skipped++; continue;
    }

    if (!idRegex.test(calcId)) {
      Logger.log(`Row ${r+1}: invalid Calculated Metric ID '${calcId}' — must start with a letter and use letters/numbers/_. Skipped.`);
      failed++; continue;
    }

    // safety check: require confirm = y/yes if the column exists
    if (confIdx !== -1 && !/^y(es)?$/.test(confirm)) {
      Logger.log(`Row ${r+1}: confirm not 'y'/'yes' — skipped '${calcId}'.`);
      skipped++; continue;
    }

    const propertyId = rawProp.replace(/^properties\//, "");
    const formattedPropertyId = `properties/${propertyId}`;
    const url = `https://analyticsadmin.googleapis.com/v1alpha/${formattedPropertyId}/calculatedMetrics/${encodeURIComponent(calcId)}`;

    if (dryRun) {
      Logger.log(`[DRY RUN] Would DELETE: ${url}`);
      skipped++; // treat dry-run as skipped action
      continue;
    }

    try {
      const res = UrlFetchApp.fetch(url, {
        method: "delete",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        muteHttpExceptions: true
      });
      const code = res.getResponseCode();

      // Google often returns 200 or 204 No Content on success
      if (code === 200 || code === 204) {
        deleted++;
        Logger.log(`DELETED row ${r+1}: '${calcId}' from ${propertyId}`);
      } else if (code === 404) {
        failed++;
        Logger.log(`NOT FOUND (404) row ${r+1}: '${calcId}' on ${propertyId} :: ${res.getContentText()}`);
      } else {
        failed++;
        Logger.log(`FAIL (${code}) row ${r+1}: '${calcId}' on ${propertyId} :: ${res.getContentText()}`);
      }
    } catch (e) {
      failed++;
      Logger.log(`ERROR row ${r+1}: '${calcId}' on ${propertyId} :: ${e.message}`);
    }
  }

  const summary = `Calculated Metrics Delete — Deleted: ${deleted}, Skipped: ${skipped}, Failed: ${failed}${dryRun ? " (dry-run)" : ""}.`;
  Logger.log(summary);
  try { ss.toast(summary); } catch(_){}
  safeAlert_("Delete Calculated Metrics", summary);
}
