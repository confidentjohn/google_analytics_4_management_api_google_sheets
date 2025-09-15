/**
 * Run all GA4 "list" jobs in one pass with a single prompt:
 * - Custom Dimensions
 * - Custom Metrics
 * - Calculated Metrics (v1alpha)
 * - Channel Groups (v1alpha)
 *
 * Prompts once for Property IDs (CSV) or Account IDs (CSV).
 * If both blank → runs for ALL accessible properties.
 *
 * Requires helpers already in this project:
 * - formatPropertyId(id)
 * - timestampForSheet()
 * - getAllAccountSummaries(token)
 * - flattenProperties(accountSummaries)
 * - (optional) getCalculatedMetricsPage_(token, propertyId, pageToken)
 */
function listAllAdminResourcesOnce() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const accessToken = ScriptApp.getOAuthToken();

  // ---- 1) Prompt once for filters ----
  let propInput = "";
  let acctInput = "";
  try {
    const ui = SpreadsheetApp.getUi();
    const r1 = ui.prompt(
      "List GA4 Resources (one prompt)",
      "Enter GA4 Property IDs (comma-separated) or leave blank:",
      ui.ButtonSet.OK_CANCEL
    );
    if (r1.getSelectedButton() !== ui.Button.OK) {
      ui.alert("Operation canceled.");
      return;
    }
    propInput = String(r1.getResponseText() || "").trim();

    const r2 = ui.prompt(
      "Optional: Account filter",
      "Enter GA4 Account IDs (comma-separated), or leave blank. (If you filled Property IDs above, leave this blank.)",
      ui.ButtonSet.OK_CANCEL
    );
    if (r2.getSelectedButton() !== ui.Button.OK) {
      ui.alert("Operation canceled.");
      return;
    }
    acctInput = String(r2.getResponseText() || "").trim();

    if (propInput && acctInput) {
      ui.alert("Please provide either Property IDs OR Account IDs, not both.");
      return;
    }
  } catch (e) {
    Logger.log("No UI context; proceeding with ALL properties.");
  }

  // ---- 2) Resolve target properties once ----
  const parseIdCsv_ = (txt) =>
    String(txt || "")
      .split(",")
      .map(s => s.trim())
      .filter(s => /^[0-9]+$/.test(s));

  const propIdsFilter = parseIdCsv_(propInput);
  const acctIdsFilter = parseIdCsv_(acctInput);

  let properties = []; // [{accountId, accountName, propertyId, propertyName}]

  if (propIdsFilter.length > 0) {
    properties = propIdsFilter.map(pid => fetchPropertyMetaForAll_(pid, accessToken))
                              .filter(Boolean);
  } else if (acctIdsFilter.length > 0) {
    acctIdsFilter.forEach(aid => properties.push(...fetchPropertiesForAccount_(aid, accessToken)));
  } else {
    const summaries = getAllAccountSummaries(accessToken) || [];
    properties = flattenProperties(summaries);
  }

  // Deduplicate by propertyId
  const seen = new Set();
  properties = properties.filter(p => {
    if (!p || !p.propertyId) return false;
    if (seen.has(p.propertyId)) return false;
    seen.add(p.propertyId);
    return true;
  });

  if (!properties.length) {
    try { SpreadsheetApp.getUi().alert("No properties matched your input."); } catch(_) {}
    Logger.log("No properties matched your input.");
    return;
  }

  Logger.log(`Running ALL listings for ${properties.length} properties ...`);

  // ---- 3) Run the 4 listings, each to its own sheet ----
  // 3a) Custom Dimensions
  writeCustomDimensionsSheet_(ss, accessToken, properties);

  // 3b) Custom Metrics
  writeCustomMetricsSheet_(ss, accessToken, properties);

  // 3c) Calculated Metrics (v1alpha)
  writeCalculatedMetricsSheet_(ss, accessToken, properties);

  // 3d) Channel Groups (v1alpha)
  writeChannelGroupsSheet_(ss, accessToken, properties);

  try { SpreadsheetApp.getUi().alert("All listings completed. Check newly created sheets."); } catch(_) {}
  Logger.log("All listings completed.");
}

/* ====================================================================== */
/* =============== Internal workers (no additional prompts) ============== */
/* ====================================================================== */

function writeCustomDimensionsSheet_(ss, accessToken, properties) {
  const sheetName = "GA4 Custom Dimensions " + timestampForSheet();
  const sh = ss.insertSheet(sheetName);
  sh.appendRow(["Account ID","Account Name","Property ID","Property Name","Display Name","Parameter Name","Scope","Description"]);

  properties.forEach(({accountId, accountName, propertyId, propertyName}) => {
    let nextPageToken = null;
    do {
      const url = `https://analyticsadmin.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}/customDimensions` +
                  (nextPageToken ? `?pageToken=${encodeURIComponent(nextPageToken)}` : "");
      const res = UrlFetchApp.fetch(url, {
        method: "get",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        muteHttpExceptions: true
      });
      const json = JSON.parse(res.getContentText() || "{}");
      const rows = (json.customDimensions || []).map(d => [
        accountId, accountName, propertyId, propertyName,
        d.displayName || "", d.parameterName || "", d.scope || "", d.description || ""
      ]);
      if (rows.length) sh.getRange(sh.getLastRow()+1, 1, rows.length, rows[0].length).setValues(rows);
      if (!rows.length && !json.nextPageToken) {
        sh.appendRow([accountId, accountName, propertyId, propertyName, "—", "No custom dimensions", "", ""]);
      }
      nextPageToken = json.nextPageToken || null;
    } while (nextPageToken);
  });

  Logger.log(`Wrote Custom Dimensions → ${sheetName}`);
}

function writeCustomMetricsSheet_(ss, accessToken, properties) {
  const sheetName = "GA4 Custom Metrics " + timestampForSheet();
  const sh = ss.insertSheet(sheetName);
  sh.appendRow(["Account ID","Account Name","Property ID","Property Name","Display Name","Parameter Name","Scope","Unit","Description"]);

  properties.forEach(({accountId, accountName, propertyId, propertyName}) => {
    let nextPageToken = null;
    do {
      const url = `https://analyticsadmin.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}/customMetrics` +
                  (nextPageToken ? `?pageToken=${encodeURIComponent(nextPageToken)}` : "");
      const res = UrlFetchApp.fetch(url, {
        method: "get",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        muteHttpExceptions: true
      });
      const json = JSON.parse(res.getContentText() || "{}");
      const rows = (json.customMetrics || []).map(m => [
        accountId, accountName, propertyId, propertyName,
        m.displayName || "", m.parameterName || "", m.scope || "", m.unit || "", m.description || ""
      ]);
      if (rows.length) sh.getRange(sh.getLastRow()+1, 1, rows.length, rows[0].length).setValues(rows);
      if (!rows.length && !json.nextPageToken) {
        sh.appendRow([accountId, accountName, propertyId, propertyName, "—", "No custom metrics", "", "", ""]);
      }
      nextPageToken = json.nextPageToken || null;
    } while (nextPageToken);
  });

  Logger.log(`Wrote Custom Metrics → ${sheetName}`);
}

function writeCalculatedMetricsSheet_(ss, accessToken, properties) {
  const sheetName = "GA4 Calculated Metrics " + timestampForSheet();
  const sh = ss.insertSheet(sheetName);
  sh.appendRow(["Account ID","Account Name","Property ID","Property Name","Calculated Metric ID","Display Name","Formula","Metric Unit","Description"]);

  properties.forEach(({accountId, accountName, propertyId, propertyName}) => {
    let nextPageToken = null;
    do {
      // Uses your existing helper if present; otherwise inline the GET like others
      const json = (typeof getCalculatedMetricsPage_ === "function")
        ? (getCalculatedMetricsPage_(accessToken, propertyId, nextPageToken) || {})
        : (() => {
            const formatted = formatPropertyId(propertyId);
            const url = `https://analyticsadmin.googleapis.com/v1alpha/${formatted}/calculatedMetrics` +
                        (nextPageToken ? `?pageToken=${encodeURIComponent(nextPageToken)}` : "");
            const res = UrlFetchApp.fetch(url, {
              method: "get",
              headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
              muteHttpExceptions: true
            });
            return JSON.parse(res.getContentText() || "{}");
          })();

      const rows = (json.calculatedMetrics || []).map(cm => [
        accountId, accountName, propertyId, propertyName,
        cm.calculatedMetricId || "", cm.displayName || "", cm.formula || "", cm.metricUnit || "", cm.description || ""
      ]);
      if (rows.length) sh.getRange(sh.getLastRow()+1, 1, rows.length, rows[0].length).setValues(rows);
      if (!rows.length && !json.nextPageToken) {
        sh.appendRow([accountId, accountName, propertyId, propertyName, "—", "No calculated metrics", "", "", ""]);
      }
      nextPageToken = json.nextPageToken || null;
    } while (nextPageToken);
  });

  Logger.log(`Wrote Calculated Metrics → ${sheetName}`);
}

function writeChannelGroupsSheet_(ss, accessToken, properties) {
  const sheetName = "GA4 Channel Groups " + timestampForSheet();
  const sh = ss.insertSheet(sheetName);
  sh.appendRow(["Account ID","Account Name","Property ID","Property Name","Channel Group ID","Display Name","Description","Grouping Rules"]);

  properties.forEach(({accountId, accountName, propertyId, propertyName}) => {
    const formatted = formatPropertyId(propertyId);
    let nextPageToken = null;
    do {
      const url = `https://analyticsadmin.googleapis.com/v1alpha/${formatted}/channelGroups` +
                  (nextPageToken ? `?pageToken=${encodeURIComponent(nextPageToken)}` : "");
      const res = UrlFetchApp.fetch(url, {
        method: "get",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        muteHttpExceptions: true
      });
      const json = JSON.parse(res.getContentText() || "{}");
      const rows = (json.channelGroups || []).map(g => [
        accountId, accountName, propertyId, propertyName,
        g.name || "", g.displayName || "", g.description || "", JSON.stringify(g.groupingRule || {})
      ]);
      if (rows.length) sh.getRange(sh.getLastRow()+1, 1, rows.length, rows[0].length).setValues(rows);
      if (!rows.length && !json.nextPageToken) {
        sh.appendRow([accountId, accountName, propertyId, propertyName, "—", "No channel groups", "", ""]);
      }
      nextPageToken = json.nextPageToken || null;
    } while (nextPageToken);
  });

  Logger.log(`Wrote Channel Groups → ${sheetName}`);
}

/* ====================================================================== */
/* ============ Small helpers used by this orchestrator ================== */
/* ====================================================================== */

/**
 * Fetch property + parent account metadata for a single propertyId.
 * Returns {accountId, accountName, propertyId, propertyName} or null.
 */
function fetchPropertyMetaForAll_(propertyId, accessToken) {
  const url = `https://analyticsadmin.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}`;
  try {
    const res = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log(`Property meta fetch failed (${res.getResponseCode()}) for ${propertyId}: ${res.getContentText()}`);
      return null;
    }
    const json = JSON.parse(res.getContentText() || "{}");
    const propertyName = json.displayName || "";
    const accountId = String(json.parent || "").replace("accounts/", "");
    // Best-effort account name
    let accountName = "";
    try {
      const summaries = getAllAccountSummaries(accessToken) || [];
      const m = (summaries.accountSummaries || summaries).find(s => (s.account || "").endsWith(accountId));
      accountName = m ? (m.displayName || "") : "";
    } catch (_) {}
    return { accountId, accountName, propertyId, propertyName };
  } catch (e) {
    Logger.log(`Error fetching property meta for ${propertyId}: ${e.message}`);
    return null;
  }
}

/**
 * List all properties under an accountId.
 * Returns [{accountId, accountName, propertyId, propertyName}]
 */
function fetchPropertiesForAccount_(accountId, accessToken) {
  const results = [];
  let accountName = "";
  try {
    const summaries = getAllAccountSummaries(accessToken) || [];
    const m = (summaries.accountSummaries || summaries).find(s => (s.account || "").endsWith(accountId));
    accountName = m ? (m.displayName || "") : "";
  } catch (_) {}

  let nextPageToken = null;
  do {
    let url = `https://analyticsadmin.googleapis.com/v1beta/properties?pageSize=200&filter=parent:accounts/${encodeURIComponent(accountId)}`;
    if (nextPageToken) url += `&pageToken=${encodeURIComponent(nextPageToken)}`;
    try {
      const res = UrlFetchApp.fetch(url, {
        method: "get",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        muteHttpExceptions: true
      });
      const json = JSON.parse(res.getContentText() || "{}");
      (json.properties || []).forEach(p => {
        results.push({
          accountId,
          accountName,
          propertyId: String(p.name || "").replace("properties/", ""),
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
