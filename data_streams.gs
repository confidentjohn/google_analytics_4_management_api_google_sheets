/**
 * Data streams (create)
 */
function createDataStream(propertyId, payload) {
  const url = `https://analyticsadmin.googleapis.com/v1beta/properties/${propertyId}/dataStreams`;
  const options = {
    method: 'POST',
    muteHttpExceptions: true,
    headers: {
      'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload)
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const statusCode = response.getResponseCode();
    const responseText = response.getContentText();
    Logger.log('HTTP Status Code: ' + statusCode);
    Logger.log('Raw response: ' + responseText);

    if (statusCode === 200 || statusCode === 201) {
      return JSON.parse(responseText);
    } else {
      Logger.log('Request failed with status code ' + statusCode);
      return null;
    }
  } catch (e) {
    Logger.log('Error in API request: ' + e.message);
    return null;
  }
}


/**
 * Call this immediately after createDataStream(...) succeeds.
 * It safely no-ops for non-WEB streams or if there are no EMS flags.
 *
 * @param {string} propertyId
 * @param {Object} dataStreamResponse  (result of createDataStream)
 * @param {Array<any>} row             The current CreateProperty row
 * @param {Object<string,number>} columnMap   header->index for CreateProperty
 */
function applyEnhancedMeasurementFromRow_(propertyId, dataStreamResponse, row, columnMap) {
  if (!dataStreamResponse || dataStreamResponse.type !== "WEB_DATA_STREAM") {
    Logger.log("Enhanced Measurement skipped: not a WEB data stream or missing response.");
    return;
  }

  const name = String(dataStreamResponse.name || "");
  const dsId = name.split("/").pop();
  if (!dsId) {
    Logger.log("Could not parse dataStreamId from dataStreamResponse.name; skipping EMS patch.");
    return;
  }

  const emSettings = buildEnhancedMeasurementFromRow_(row, columnMap);
  if (!emSettings || Object.keys(emSettings).length === 0) {
    Logger.log("No Enhanced Measurement settings found in sheet; skipping EMS patch.");
    return;
  }

  patchEnhancedMeasurement_(propertyId, dsId, emSettings);
}

/**
 * Reads columns I–P (streamEnabled..formInteractionsEnabled) and returns a
 * v1alpha EnhancedMeasurementSettings object (snake_case fields).
 */
function buildEnhancedMeasurementFromRow_(row, columnMap) {
  const val    = (key) => String(row[columnMap[key]] || "").trim().toLowerCase();
  const toBool = (s)   => s === "enable" || s === "enabled";

  const hasAny =
    ["streamenabled","scrollsenabled","outboundclicksenabled","sitesearchenabled",
     "videoengagementenabled","filedownloadsenabled","pagechangesenabled","forminteractionsenabled"]
     .some(k => row[columnMap[k]] && String(row[columnMap[k]]).trim() !== "");

  if (!hasAny) return {};

  return {
    stream_enabled:              toBool(val("streamenabled")),
    scrolls_enabled:             toBool(val("scrollsenabled")),
    outbound_clicks_enabled:     toBool(val("outboundclicksenabled")),
    site_search_enabled:         toBool(val("sitesearchenabled")),
    video_engagement_enabled:    toBool(val("videoengagementenabled")),
    file_downloads_enabled:      toBool(val("filedownloadsenabled")),
    page_changes_enabled:        toBool(val("pagechangesenabled")),
    form_interactions_enabled:   toBool(val("forminteractionsenabled")),
  };
}

/**
 * PATCH Enhanced Measurement Settings for a WEB data stream (v1alpha).
 */
function patchEnhancedMeasurement_(propertyId, dataStreamId, emSettings) {
  if (!emSettings || Object.keys(emSettings).length === 0) {
    Logger.log("patchEnhancedMeasurement_: nothing to update.");
    return;
  }

  const mask = Object.keys(emSettings)
    .map(k => snakeToCamel_(k))
    .join(",");

  const url =
    `https://analyticsadmin.googleapis.com/v1alpha/properties/${encodeURIComponent(propertyId)}` +
    `/dataStreams/${encodeURIComponent(dataStreamId)}/enhancedMeasurementSettings?updateMask=${encodeURIComponent(mask)}`;

  const options = {
    method: "patch",
    contentType: "application/json",
    headers: {
      Authorization: `Bearer ${ScriptApp.getOAuthToken()}`,
      Accept: "application/json"
    },
    muteHttpExceptions: true,
    payload: JSON.stringify(emSettings)
  };

  try {
    const res  = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    const txt  = res.getContentText();
    if (code === 200) {
      Logger.log(`Enhanced Measurement patched OK for ${propertyId}/${dataStreamId}`);
    } else {
      Logger.log(`Enhanced Measurement PATCH failed (${code}) for ${propertyId}/${dataStreamId} :: ${txt}`);
    }
  } catch (e) {
    Logger.log(`Enhanced Measurement PATCH error for ${propertyId}/${dataStreamId}: ${e.message}`);
  }
}

/**
 * (Optional) Read current Enhanced Measurement settings for debugging.
 */
function getEnhancedMeasurement_(propertyId, dataStreamId) {
  const url =
    `https://analyticsadmin.googleapis.com/v1alpha/properties/${encodeURIComponent(propertyId)}` +
    `/dataStreams/${encodeURIComponent(dataStreamId)}/enhancedMeasurementSettings`;

  const options = {
    method: "get",
    headers: {
      Authorization: `Bearer ${ScriptApp.getOAuthToken()}`,
      Accept: "application/json"
    },
    muteHttpExceptions: true
  };

  try {
    const res = UrlFetchApp.fetch(url, options);
    Logger.log(`EMS GET ${propertyId}/${dataStreamId}: ${res.getResponseCode()} ${res.getContentText()}`);
  } catch (e) {
    Logger.log(`EMS GET error for ${propertyId}/${dataStreamId}: ${e.message}`);
  }
}

/** tiny helper */
function snakeToCamel_(s) {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}


/* ======================================================================
   DATA STREAMS — LIST
   ====================================================================== */

/**
 * listDataStreams()
 *
 * Lists all data streams across selected or all properties, with full
 * account and property context flattened into each row.
 *
 * Prompts (mutually exclusive):
 *   • Property IDs (CSV) — or blank
 *   • Account IDs  (CSV) — or blank
 *   • Both blank → all accessible properties
 *
 * Output sheet: "GA4 Data Streams <timestamp>"
 *   Account ID | Account Name |
 *   Property ID | Property Name | Time Zone | Currency Code |
 *   Data Stream ID | Data Stream Name | Data Stream Type |
 *   Measurement ID | Default URI | Firebase App ID |
 *   Stream Create Time | Stream Update Time |
 *   User Data Acknowledgement
 *
 * acknowledgeUserDataCollection is called once per unique property ID
 * after streams are fetched. The result is written to the last column.
 * Re-acknowledging an already-acknowledged property is a no-op (200).
 *
 * Rate limiting strategy:
 *   - getAllAccountSummaries is called ONCE and passed as a cache to all
 *     helpers — avoids repeated calls that burn quota before the main loop.
 *   - properties.list per account returns full objects (timeZone, currencyCode)
 *     so we never need a separate GET per property.
 *   - 500ms sleep between property stream fetches.
 *   - 2s back-off + single retry on 429/503.
 */
function listDataStreams() {
  const ss          = SpreadsheetApp.getActiveSpreadsheet();
  const accessToken = ScriptApp.getOAuthToken();

  // ── UI prompts ──────────────────────────────────────────────────────
  let propInput = "";
  let acctInput = "";
  try {
    const ui = SpreadsheetApp.getUi();

    const r1 = ui.prompt(
      "List Data Streams",
      "Enter GA4 Property IDs (comma-separated), or leave blank:",
      ui.ButtonSet.OK_CANCEL
    );
    if (r1.getSelectedButton() !== ui.Button.OK) { ui.alert("Cancelled."); return; }
    propInput = String(r1.getResponseText() || "").trim();

    const r2 = ui.prompt(
      "Optional: Account filter",
      "Enter GA4 Account IDs (comma-separated), or leave blank.\n(Leave blank if you provided Property IDs above.)",
      ui.ButtonSet.OK_CANCEL
    );
    if (r2.getSelectedButton() !== ui.Button.OK) { ui.alert("Cancelled."); return; }
    acctInput = String(r2.getResponseText() || "").trim();

    if (propInput && acctInput) {
      ui.alert("Provide either Property IDs OR Account IDs, not both.");
      return;
    }
  } catch (_) {
    Logger.log("No UI context — listing data streams for ALL properties.");
  }

  // ── Fetch account summaries ONCE and cache ──────────────────────────
  // This is the key fix: every downstream helper receives this cache
  // rather than calling getAllAccountSummaries() independently.
  Logger.log("Fetching account summaries...");
  const summaryCache = getAllAccountSummaries(accessToken) || [];

  // Build a quick accountId → accountName lookup from the cache
  const accountNameMap = {};
  summaryCache.forEach(acc => {
    const id = (acc.account || "").replace("accounts/", "");
    accountNameMap[id] = acc.displayName || "";
  });

  // ── Resolve properties ──────────────────────────────────────────────
  const parseIdCsv = txt =>
    String(txt || "").split(",").map(s => s.trim()).filter(s => /^\d+$/.test(s));

  const propIdsFilter = parseIdCsv(propInput);
  const acctIdsFilter = parseIdCsv(acctInput);

  // [{accountId, accountName, propertyId, propertyName, timeZone, currencyCode}]
  let properties = [];

  if (propIdsFilter.length > 0) {
    // Small explicit list — individual GETs are fine, pass cache to avoid re-fetch
    properties = propIdsFilter
      .map(pid => fetchPropertyFull_(pid, accessToken, accountNameMap))
      .filter(Boolean);

  } else if (acctIdsFilter.length > 0) {
    acctIdsFilter.forEach((aid, i) => {
      if (i > 0) Utilities.sleep(500);
      properties.push(...fetchPropertiesFullForAccount_(aid, accessToken, accountNameMap));
    });

  } else {
    // All accounts — one properties.list call per account
    summaryCache.forEach((acc, i) => {
      const accountId = (acc.account || "").replace("accounts/", "");
      if (i > 0) Utilities.sleep(500);
      const props = fetchPropertiesFullForAccount_(accountId, accessToken, accountNameMap);
      if (props.length) {
        properties.push(...props);
      } else {
        // Quota hit — fall back to summary data (no tz/currency)
        Logger.log(`Falling back to summary data for account ${accountId}`);
        (acc.propertySummaries || []).forEach(ps => {
          properties.push({
            accountId,
            accountName:  accountNameMap[accountId] || "",
            propertyId:   (ps.property || "").replace("properties/", ""),
            propertyName: ps.displayName || "",
            timeZone:     "",
            currencyCode: ""
          });
        });
      }
    });
  }

  // Deduplicate by propertyId
  const seen = new Set();
  properties = properties.filter(p => {
    if (!p || !p.propertyId || seen.has(p.propertyId)) return false;
    seen.add(p.propertyId);
    return true;
  });

  if (!properties.length) {
    Logger.log("No properties matched.");
    try { SpreadsheetApp.getUi().alert("No properties matched your input."); } catch (_) {}
    return;
  }

  Logger.log(`Listing data streams for ${properties.length} properties...`);

  // ── Output sheet ────────────────────────────────────────────────────
  const sheetName = "GA4 Data Streams " + timestampForSheet();
  const sheet     = ss.insertSheet(sheetName);

  sheet.appendRow([
    "Account ID",
    "Account Name",
    "Property ID",
    "Property Name",
    "Time Zone",
    "Currency Code",
    "Data Stream ID",
    "Data Stream Name",
    "Data Stream Type",
    "Measurement ID",
    "Default URI",
    "Firebase App ID",
    "Stream Create Time",
    "Stream Update Time",
    "User Data Acknowledgement"
  ]);

  // ── Acknowledge user data collection per unique property ────────────
  // Done after stream fetch so we only call for properties that actually
  // have streams. Deduped — one call per property regardless of stream count.
  Logger.log(`Acknowledging user data collection for ${properties.length} properties...`);
  const ackStatusMap = {}; // propertyId → "Acknowledged" | "Failed: ..."

  properties.forEach((prop, i) => {
    if (i > 0) Utilities.sleep(200);
    const ok = acknowledgeUserDataCollection_(prop.propertyId, accessToken);
    ackStatusMap[prop.propertyId] = ok ? "Acknowledged" : "Failed";
  });

  // ── Fetch streams and accumulate rows ───────────────────────────────
  let totalStreams = 0;
  const rows = [];

  properties.forEach((prop, i) => {
    const { accountId, accountName, propertyId, propertyName, timeZone, currencyCode } = prop;

    if (i > 0) Utilities.sleep(500);

    let pageToken    = null;
    let hasAnyStream = false;

    do {
      const url =
        `https://analyticsadmin.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}/dataStreams` +
        (pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "");

      let json = {};
      try {
        const res  = UrlFetchApp.fetch(url, {
          method:  "get",
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
          muteHttpExceptions: true
        });
        const code = res.getResponseCode();
        if (code === 429 || code === 503) {
          Logger.log(`Rate limit on streams for ${propertyId} — backing off 2s`);
          Utilities.sleep(2000);
          const retry = UrlFetchApp.fetch(url, {
            method:  "get",
            headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
            muteHttpExceptions: true
          });
          json = JSON.parse(retry.getContentText() || "{}");
        } else {
          json = JSON.parse(res.getContentText() || "{}");
        }
      } catch (e) {
        Logger.log(`Error fetching streams for ${propertyId}: ${e.message}`);
        break;
      }

      const streams = json.dataStreams || [];

      streams.forEach(stream => {
        hasAnyStream = true;
        const streamId   = (stream.name || "").split("/").pop();
        const streamType = stream.type  || "";

        const web     = stream.webStreamData        || {};
        const android = stream.androidAppStreamData || {};
        const ios     = stream.iosAppStreamData     || {};

        rows.push([
          accountId,
          accountName,
          propertyId,
          propertyName,
          timeZone,
          currencyCode,
          streamId,
          stream.displayName || "",
          streamType,
          web.measurementId  || "",
          web.defaultUri     || "",
          web.firebaseAppId  || android.firebaseAppId || ios.firebaseAppId || "",
          stream.createTime  || "",
          stream.updateTime  || "",
          ackStatusMap[propertyId] || ""
        ]);
      });

      totalStreams += streams.length;
      pageToken = json.nextPageToken || null;
    } while (pageToken);

    if (!hasAnyStream) {
      rows.push([
        accountId, accountName, propertyId, propertyName,
        timeZone, currencyCode,
        "—", "No data streams", "", "", "", "", "", "",
        ackStatusMap[propertyId] || ""
      ]);
    }
  });

  // Batch write — much faster than appendRow in a loop
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }

  Logger.log(`Done — ${totalStreams} streams across ${properties.length} properties → ${sheetName}`);
  try {
    SpreadsheetApp.getUi().alert(
      `Found ${totalStreams} data streams across ${properties.length} properties.\nSheet: ${sheetName}`
    );
  } catch (_) {}
}


/* ── Private helpers ───────────────────────────────────────────────────── */

/**
 * Fetch full details for a single property ID.
 * @param {string} propertyId
 * @param {string} accessToken
 * @param {Object} accountNameMap  Pre-built {accountId: accountName} cache — no API call needed.
 * @returns {{accountId, accountName, propertyId, propertyName, timeZone, currencyCode}|null}
 */
function fetchPropertyFull_(propertyId, accessToken, accountNameMap) {
  const url = `https://analyticsadmin.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}`;
  try {
    const res = UrlFetchApp.fetch(url, {
      method:  "get",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log(`fetchPropertyFull_ failed (${res.getResponseCode()}) for ${propertyId}`);
      return null;
    }
    const json      = JSON.parse(res.getContentText() || "{}");
    const accountId = (json.parent || "").replace("accounts/", "");
    return {
      accountId,
      accountName:  (accountNameMap || {})[accountId] || "",
      propertyId,
      propertyName: json.displayName  || "",
      timeZone:     json.timeZone     || "",
      currencyCode: json.currencyCode || ""
    };
  } catch (e) {
    Logger.log(`fetchPropertyFull_ error for ${propertyId}: ${e.message}`);
    return null;
  }
}

/**
 * Acknowledges user data collection terms for a property (v1beta).
 * Required before MeasurementProtocolSecrets can be created.
 * Safe to call on already-acknowledged properties — returns 200 either way.
 *
 * @param {string} propertyId  Bare numeric property ID
 * @param {string} accessToken
 * @returns {boolean} true if successful
 */
function acknowledgeUserDataCollection_(propertyId, accessToken) {
  const url = `https://analyticsadmin.googleapis.com/v1beta/properties/${propertyId}:acknowledgeUserDataCollection`;

  // This exact string is required by the API — do not modify it.
  const acknowledgement =
    "I acknowledge that I have the necessary privacy disclosures and rights from my end users " +
    "for the collection and processing of their data, including the association of such data with " +
    "the visitation information Google Analytics collects from my site and/or app property.";

  try {
    const res  = UrlFetchApp.fetch(url, {
      method:      "post",
      contentType: "application/json",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept:        "application/json"
      },
      muteHttpExceptions: true,
      payload: JSON.stringify({ acknowledgement: acknowledgement })
    });
    const code = res.getResponseCode();
    if (code === 200) {
      Logger.log(`Acknowledged user data collection for property ${propertyId}`);
      return true;
    } else {
      const body   = JSON.parse(res.getContentText() || "{}");
      const errMsg = (body.error && body.error.message) ? body.error.message : res.getContentText();
      Logger.log(`Acknowledgement failed for property ${propertyId}: ${code} – ${errMsg}`);
      return false;
    }
  } catch (e) {
    Logger.log(`Acknowledgement error for property ${propertyId}: ${e.message}`);
    return false;
  }
}

/**
 * List all properties under an account using properties.list.
 * Returns full property objects including timeZone and currencyCode,
 * so no per-property GET is needed.
 *
 * @param {string} accountId
 * @param {string} accessToken
 * @param {Object} accountNameMap  Pre-built {accountId: accountName} cache — no API call needed.
 * @returns {Array<{accountId, accountName, propertyId, propertyName, timeZone, currencyCode}>}
 */
function fetchPropertiesFullForAccount_(accountId, accessToken, accountNameMap) {
  const results   = [];
  const accountName = (accountNameMap || {})[accountId] || "";

  let nextPageToken = null;
  do {
    let url = `https://analyticsadmin.googleapis.com/v1beta/properties?pageSize=200&filter=parent:accounts/${encodeURIComponent(accountId)}`;
    if (nextPageToken) url += `&pageToken=${encodeURIComponent(nextPageToken)}`;

    try {
      const res  = UrlFetchApp.fetch(url, {
        method:  "get",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        muteHttpExceptions: true
      });
      const code = res.getResponseCode();
      if (code !== 200) {
        Logger.log(`fetchPropertiesFullForAccount_ failed (${code}) for account ${accountId}: ${res.getContentText()}`);
        break;
      }
      const json = JSON.parse(res.getContentText() || "{}");
      (json.properties || []).forEach(p => {
        results.push({
          accountId,
          accountName,
          propertyId:   (p.name || "").replace("properties/", ""),
          propertyName: p.displayName  || "",
          timeZone:     p.timeZone     || "",
          currencyCode: p.currencyCode || ""
        });
      });
      nextPageToken = json.nextPageToken || null;
    } catch (e) {
      Logger.log(`fetchPropertiesFullForAccount_ error for account ${accountId}: ${e.message}`);
      break;
    }
  } while (nextPageToken);

  return results;
}
