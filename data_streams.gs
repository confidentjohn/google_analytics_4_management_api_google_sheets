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

  // Extract dataStreamId from name like: properties/{pid}/dataStreams/{dsId}
  const name = String(dataStreamResponse.name || "");
  const dsId = name.split("/").pop();
  if (!dsId) {
    Logger.log("Could not parse dataStreamId from dataStreamResponse.name; skipping EMS patch.");
    return;
  }

  // Build the settings object from columns I–P
  const emSettings = buildEnhancedMeasurementFromRow_(row, columnMap);
  if (!emSettings || Object.keys(emSettings).length === 0) {
    Logger.log("No Enhanced Measurement settings found in sheet; skipping EMS patch.");
    return;
  }

  // Optional: peek at current settings before
  // getEnhancedMeasurement_(propertyId, dsId);

  // Patch
  patchEnhancedMeasurement_(propertyId, dsId, emSettings);

  // Optional: verify after
  // getEnhancedMeasurement_(propertyId, dsId);
}

/**
 * Reads columns I–P (streamEnabled..formInteractionsEnabled) and returns a
 * v1alpha EnhancedMeasurementSettings object (snake_case fields).
 *
 * Sheet values expected: "enable" / "disable" (case-insensitive).
 */
function buildEnhancedMeasurementFromRow_(row, columnMap) {
  const val = (key) => String(row[columnMap[key]] || "").trim().toLowerCase();
  const toBool = (s) => s === "enable" || s === "enabled"; // allow both

  const hasAny =
    ["streamenabled","scrollsenabled","outboundclicksenabled","sitesearchenabled",
     "videoengagementenabled","filedownloadsenabled","pagechangesenabled","forminteractionsenabled"]
     .some(k => row[columnMap[k]] && String(row[columnMap[k]]).trim() !== "");

  if (!hasAny) return {};

  // v1alpha uses snake_case field names for EnhancedMeasurementSettings
  return {
    // master switch
    stream_enabled: toBool(val("streamenabled")),

    // individual toggles
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
 * Only sends fields you provide (updateMask built automatically).
 */
function patchEnhancedMeasurement_(propertyId, dataStreamId, emSettings) {
  if (!emSettings || Object.keys(emSettings).length === 0) {
    Logger.log("patchEnhancedMeasurement_: nothing to update.");
    return;
  }

  // Build updateMask from the provided keys (convert snake_case->camelCase per API field names)
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
    const res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    const txt = res.getContentText();
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
