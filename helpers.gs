/**
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃ GA4 Admin – README (helpers.gs)                                      ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * This project automates common GA4 Admin tasks from Google Sheets.
 * Most tabs are created by setupTemplateSheetsAndValidation().
 *
 * ── Core Conventions ──────────────────────────────────────────────────
 * • Property IDs can be written as plain "123456789" or "properties/123456789".
 *   Helpers normalize with formatPropertyId().
 * • Many functions show UI prompts when run from the spreadsheet menu.
 *   From the Apps Script editor (no UI context), functions fall back gracefully
 *   (e.g., proceed with “ALL” where sensible) and use Logger.log instead of alerts.
 * • The hidden sheet "propertycreation_validation_sheet" provides dropdown lists
 *   for data validation across multiple input tabs.
 *
 * ── Sheets created/managed by setupTemplateSheetsAndValidation() ───────
 *
 * 1) CreateProperty
 *    Purpose: Input for property creation workflow.
 *    Used by: createGA4Properties()
 *    Notes: Validations for propertyType, timeZone, currencyCode, stream type,
 *           and enhanced measurement toggles are wired to "propertycreation_validation_sheet".
 *
 * 2) standardDimensions
 *    Purpose: Seed “standard” custom dimensions at property creation time.
 *    Used by: createStandardCustomDimensions(), createGA4Properties()
 *
 * 3) standardMetrics
 *    Purpose: Seed “standard” custom metrics at property creation time.
 *    Used by: createStandardCustomMetrics(), createGA4Properties()
 *    Notes: Scope dropdown allows EVENT; Unit dropdown uses Admin API units.
 *
 * 4) standardCalculatedMetrics
 *    Purpose: Seed GA4 Calculated Metrics (v1alpha) at property creation time.
 *    Used by: createStandardCalculatedMetrics(), createGA4Properties()
 *    Columns: Calculated Metric ID, Display Name, Formula, Metric Unit, Description
 *    Notes: calculatedMetricId is passed in the query string (not the body).
 *
 * 5) newDimensions
 *    Purpose: Ad-hoc creation of custom dimensions across properties.
 *    Used by: createAdHocCustomDimensions()
 *    Columns: Property ID, Name, Parameter Name, Scope, Description
 *
 * 6) archiveDimensions
 *    Purpose: Archive existing custom dimensions (per property/parameter).
 *    Used by: archiveCustomDimensions()
 *    Columns: Property ID, Parameter Name
 *
 * 7) newMetrics
 *    Purpose: Ad-hoc creation of custom metrics across properties.
 *    Used by: createAdHocCustomMetrics()
 *    Columns: Property ID, Name, Parameter Name, Scope, Unit, Description
 *
 * 8) archiveMetrics
 *    Purpose: Archive existing custom metrics (per property/parameter).
 *    Used by: archiveCustomMetrics()
 *    Columns: Property ID, Parameter Name
 *
 * 9) newCalculatedMetrics
 *    Purpose: Ad-hoc creation of Calculated Metrics (v1alpha).
 *    Used by: createAdHocCalculatedMetrics()
 *    Columns: Property ID, Calculated Metric ID, Display Name, Formula, Metric Unit, Description
 *
 * 10) deleteCalculatedMetrics
 *     Purpose: Delete Calculated Metrics (v1alpha) by resource name.
 *     Used by: deleteCalculatedMetricsFromSheet()
 *     Columns: Property ID, Calculated Metric ID, Resource Name
 *     Notes: If Resource Name is blank, the script will try to list & resolve it
 *            from Calculated Metric ID.
 *
 * 11) newChannelGroups
 *     Purpose: Ad-hoc creation of Channel Groups (v1alpha).
 *     Used by: createNewChannelGroups()
 *     Columns: Property ID, displayName, description, groupingRule (JSON)
 *
 * 12) standardChannelGroups
 *     Purpose: Seed Channel Groups during property creation.
 *     Used by: createStandardChannelGroups(), createGA4Properties()
 *     Columns: displayName, description, groupingRule (JSON)
 *
 * 13) updateChannelGroups
 *     Purpose: Batch PATCH existing Channel Groups.
 *     Used by: updateChannelGroupsFromSheet()
 *     Columns: Property ID, Channel Group ID, displayName, description, groupingRule (JSON)
 *
 * 14) propertycreation_validation_sheet  (hidden)
 *     Purpose: Central source for validation lists (property types, time zones,
 *              currencies, stream types, scopes, measurement units, enable/disable).
 *     Used by: Data validation rules across CreateProperty/standardDimensions/standardMetrics/newDimensions/newMetrics.
 *
 * ── Output / Report Sheets (created on demand by list/export functions) ─────────
 * • "GA4 Account List <timestamp>"            ← listAccounts()
 * • "GA4 Properties <timestamp>"              ← listAllGA4PropertyDetails()
 * • "GA4 Custom Dimensions <timestamp>"       ← listCustomDimensions()
 * • "GA4 Custom Metrics <timestamp>"          ← listCustomMetrics()
 * • "GA4 Calculated Metrics <timestamp>"      ← listCalculatedMetrics()
 * • "GA4 Channel Groups <timestamp>"          ← listChannelGroups() / listChannelGroupsBatch()
 * • "propertyDimensions_<timestamp>"          ← exportAllCustomDimensions()
 *
 * ── Frequently-used helpers (live in helpers.js / ga4helpers.js) ────────────────
 * • formatPropertyId(id) → "properties/<id>"
 * • timestampForSheet()  → time-based suffix for new sheet names
 * • safeAlert_(title,msg), safeToast_(msg) → UI if available, logs otherwise
 * • getUserEmail_() → the spreadsheet user’s email (for completion emails)
 * • getAllAccountSummaries(token) / getAccountSummaries(token,pageToken)
 * • flattenProperties(accountSummaries) → [{accountId, accountName, propertyId, propertyName}]
 * • fetchPropertyMeta_(pid, token)      → property/account names from ID
 * • fetchPropertiesForAccount_(aid, token) → properties under an account
 *
 * ── Function ↔ Sheet quick matrix ───────────────────────────────────────────────
 *   createGA4Properties() .......... reads CreateProperty; seeds standardDimensions/standardMetrics/standardCalculatedMetrics/standardChannelGroups
 *   createAdHocCustomDimensions() ... reads newDimensions
 *   archiveCustomDimensions() ........ reads archiveDimensions
 *   createAdHocCustomMetrics() ....... reads newMetrics
 *   archiveCustomMetrics() ........... reads archiveMetrics
 *   createAdHocCalculatedMetrics() ... reads newCalculatedMetrics
 *   deleteCalculatedMetricsFromSheet() reads deleteCalculatedMetrics
 *   createNewChannelGroups() ......... reads newChannelGroups
 *   updateChannelGroupsFromSheet() ... reads updateChannelGroups
 *   list* / export* .................. write timestamped report sheets
 *
 * ── UI vs Script Editor ────────────────────────────────────────────────────────
 * • From Sheets menu: prompts (ui.prompt/alerts/toasts) are shown.
 * • From Script Editor / triggers: safeAlert_/safeToast_ no-op to Logger.
 * • Long-running jobs may paginate via nextPageToken loops; some export flows
 *   cache progress with CacheService if needed.
 *
 * Tip: If a list/create/archive function errors on headers, open the sheet it expects
 * and confirm the column names match exactly those documented above.
 */

// ---- UI-safe helpers ----
function hasUi_() {
  try { SpreadsheetApp.getUi(); return true; } catch (e) { return false; }
}

function safeAlert_(title, msg, buttons) {
  if (hasUi_()) {
    const ui = SpreadsheetApp.getUi();
    return ui.alert(title, msg, buttons || ui.ButtonSet.OK);
  } else {
    Logger.log(`${title}: ${msg}`);
    return 'OK'; // pretend OK when no UI
  }
}

function safeToast_(msg) {
  try { SpreadsheetApp.getActive().toast(msg); } catch (e) { Logger.log(msg); }
}

/**
 * Build or refresh a visible "README" sheet that documents all input/output sheets
 * and the functions that use them.
 */
function writeProjectReadmeSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const name = "README";
  let sh = ss.getSheetByName(name);
  if (sh) ss.deleteSheet(sh);        // recreate to keep it tidy/fresh
  sh = ss.insertSheet(name);

  const lines = [
    "GA4 Admin – README",
    "",
    "This spreadsheet is organized into different sheets for property creation, ad-hoc additions, archiving, and outputs.",
    "",
    "Conventions:",
    "• Sheets prefixed with 'standard' are used for property creation. Populate these with all dimensions, metrics, or calculated metrics you want created during initial property setup.",
    "• Sheets prefixed with 'new' are used for adding items ad-hoc to existing properties after creation.",
    "• Sheets prefixed with 'archive' or 'delete' are used for cleaning up existing items.",
    "",
    "Input Sheets (you edit):",
    "• CreateProperty – used by createGA4Properties()",
    "• standardDimensions – for createStandardCustomDimensions()",
    "• standardMetrics – for createStandardCustomMetrics()",
    "• standardCalculatedMetrics – for createStandardCalculatedMetrics()",
    "• standardChannelGroups – for createStandardChannelGroups()",
    "• newDimensions – for createAdHocCustomDimensions()",
    "• newMetrics – for createAdHocCustomMetrics()",
    "• newCalculatedMetrics – for createAdHocCalculatedMetrics()",
    "• newChannelGroups – for createNewChannelGroups()",
    "• archiveDimensions – for archiveCustomDimensions()",
    "• archiveMetrics – for archiveCustomMetrics()",
    "• deleteCalculatedMetrics – for deleteCalculatedMetricsFromSheet()",
    "• updateChannelGroups – for updateChannelGroupsFromSheet()",
    "",
    "Hidden Validation Sheet:",
    "• propertycreation_validation_sheet – dropdown sources for time zones, currencies, scopes, units, etc.",
    "",
    "Report/Output Sheets (auto-created):",
    "• GA4 Account List <timestamp> – listAccounts()",
    "• GA4 Properties <timestamp> – listAllGA4PropertyDetails()",
    "• GA4 Custom Dimensions <timestamp> – listCustomDimensions()",
    "• GA4 Custom Metrics <timestamp> – listCustomMetrics()",
    "• GA4 Calculated Metrics <timestamp> – listCalculatedMetrics()",
    "• GA4 Channel Groups <timestamp> – listChannelGroups() / listChannelGroupsBatch()",
    "• propertyDimensions_<timestamp> – exportAllCustomDimensions()",
    "",
    "General Notes:",
    "• Property IDs can be plain (123) or prefixed (properties/123); helpers normalize this automatically.",
    "• Run from the spreadsheet menu for prompts; when run from the editor, functions log and use safe defaults.",
    "• Long-running jobs paginate (nextPageToken); exports may use caching to resume progress.",
  ];

  sh.getRange(1, 1, lines.length, 1).setValues(lines.map(s => [s]));
  sh.setColumnWidths(1, 1, 820);
  sh.setFrozenRows(1);
  sh.getRange("A1").setFontWeight("bold").setFontSize(14);
}

/**
 * Pause so you can convert to GA4 360.
 * - In UI context: shows a blocking alert and waits for OK.
 * - In non-UI context: logs and immediately continues.
 * Returns true to continue; you can change to return false if you add Cancel support later.
 */
function pauseForGa360_(propertyId) {
  const message = `Property ${propertyId} created.\nConvert it to GA4 360, then click OK to continue.`;
  safeAlert_('GA4 Property Created', message, hasUi_() ? SpreadsheetApp.getUi().ButtonSet.OK : null);
  return true;
}

/**
 * Send a completion email after any export/task.
 * @param {string} userEmail
 * @param {string} taskName   e.g. "Custom Dimensions", "Custom Metrics", "Property Inventory"
 * @param {number} processed  count of items processed (properties, rows, etc.)
 * @param {string} sheetName  destination sheet name
 */
function sendCompletionEmail(userEmail, taskName, processed, sheetName) {
  if (!userEmail) return; // silently skip if no email available (e.g., some domains restrict Session)
  const subject = `${taskName} Export Completed`;
  const body =
    `The ${taskName.toLowerCase()} export has completed.\n\n` +
    `Processed: ${processed}\n` +
    `Sheet: ${sheetName}\n\n` +
    `You can open the spreadsheet to review the results.`;
  MailApp.sendEmail(userEmail, subject, body);
}

/**
 * Small shared helpers
 */
function formatPropertyId(id) {
  id = String(id || '').trim();
  return id.startsWith('properties/') ? id : 'properties/' + id;
}

function timestampForSheet() {
  return new Date().toISOString().replace(/[:.-]/g, "_");
}

function setupTemplateSheetsAndValidation() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  function ensure(name, headers) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (headers && headers.length) { sh.clear(); sh.appendRow(headers); }
    return sh;
  }

  // CreateProperty tab
  const createProperty = ensure("CreateProperty", [
    "propertyType","displayName","industryCategory","timeZone","currencyCode","accountId",
    "DataStreamType","streamURI",
    "streamEnabled","scrollsEnabled","outboundClicksEnabled","siteSearchEnabled",
    "videoEngagementEnabled","fileDownloadsEnabled","pageChangesEnabled","formInteractionsEnabled"
  ]);

  // Supporting tabs
  const standardDimensions = ensure("standardDimensions", ["Name","Parameter Name","Scope","Description"]);
  const standardMetrics    = ensure("standardMetrics",    ["Name","Parameter Name","Scope","Unit","Description"]);
  const standardCalculatedMetrics    = ensure("standardCalculatedMetrics",    ["Calculated Metric ID","Display Name","Formula","Metric Unit","Description"]);
  const standardChannelGroups = ensure("standardChannelGroups",["displayName","description","groupingRule"]);
  const newDimensions = ensure("newDimensions", ["Property ID","Name","Parameter Name","Scope","Description"]);
  const archiveDimensions = ensure("archiveDimensions", ["Property ID","Parameter Name"]);
  const newMetrics    = ensure("newMetrics",    ["Property ID","Name","Parameter Name","Scope","Unit","Description"]);
  const archiveMetrics = ensure("archiveMetrics", ["Property ID","Parameter Name"]);
  const newCalculatedMetrics    = ensure("newCalculatedMetrics",    ["Property ID", "Calculated Metric ID","Display Name","Formula","Metric Unit","Description"]);
  const deleteCalculatedMetrics    = ensure("deleteCalculatedMetrics",    ["Property ID", "Calculated Metric ID"]);
  const newChannelGroups = ensure("newChannelGroups",["Property ID","displayName","description","groupingRule"]);
  const updateChannelGroups = ensure("updateChannelGroups",["Property ID","Channel Group ID", "displayName","description","groupingRule"]);

  // ---------- Validation sheet ----------
  const VSN = "propertycreation_validation_sheet";
  let vs = ss.getSheetByName(VSN);
  if (!vs) vs = ss.insertSheet(VSN);

  const propTypes = ["PROPERTY_TYPE_ORDINARY","PROPERTY_TYPE_SUBPROPERTY","PROPERTY_TYPE_ROLLUP"];

  const timeZones = [
    "America/New_York","America/Chicago","America/Los_Angeles","Europe/Kaliningrad","Asia/Riyadh","Atlantic/Azores",
    "Europe/Berlin","Europe/Rome","Europe/Paris","America/Toronto","Etc/GMT","Asia/Tokyo","America/Bogota",
    "America/Buenos_Aires","America/Managua","America/Montevideo","America/La_Paz","America/Guatemala","America/Lima",
    "America/El_Salvador","America/Costa_Rica","America/Asuncion","America/Caracas","Pacific/Galapagos","America/Panama",
    "Pacific/Easter","America/Tijuana","Asia/Seoul","Asia/Taipei","Asia/Hong_Kong","Asia/Bangkok","Asia/Singapore",
    "Asia/Kuala_Lumpur","Pacific/Auckland","Asia/Manila","Asia/Jakarta","Asia/Saigon","Atlantic/Reykjavik","Europe/Zurich",
    "Asia/Calcutta","Europe/Budapest","Europe/Oslo","Europe/Brussels","Europe/Vienna","Europe/Copenhagen","Europe/Prague",
    "Europe/Madrid","Europe/Istanbul","Africa/Johannesburg","Europe/Helsinki","Europe/Athens","Asia/Jerusalem",
    "Europe/Stockholm","Europe/Amsterdam","Europe/Warsaw","Europe/Bucharest","Atlantic/Canary","Asia/Qatar","Asia/Dubai",
    "Asia/Kuwait","Australia/Sydney","Australia/Perth","Europe/London","America/Vancouver","America/Fortaleza",
    "America/Mexico_City","America/Rio_Branco","America/Sao_Paulo","America/Santiago","Etc/GMT+4"
  ];

  const currencies = [
    "AED","AFN","ALL","AMD","ANG","AOA","ARS","AUD","AWG","AZN","BAM","BBD","BDT","BGN","BHD","BIF","BMD","BND","BOB","BOV",
    "BRL","BSD","BTN","BWP","BYN","BZD","CAD","CDF","CHE","CHF","CHW","CLF","CLP","CNY","COP","COU","CRC","CUP","CVE","CZK",
    "DJF","DKK","DOP","DZD","EGP","ERN","ETB","EUR","FJD","FKP","GBP","GEL","GHS","GIP","GMD","GNF","GTQ","GYD","HKD","HNL",
    "HTG","HUF","IDR","ILS","INR","IQD","IRR","ISK","JMD","JOD","JPY","KES","KGS","KHR","KMF","KPW","KRW","KWD","KYD","KZT",
    "LAK","LBP","LKR","LRD","LSL","LYD","MAD","MDL","MGA","MKD","MMK","MNT","MOP","MRU","MUR","MVR","MWK","MXN","MXV","MYR",
    "MZN","NAD","NGN","NIO","NOK","NPR","NZD","OMR","PAB","PEN","PGK","PHP","PKR","PLN","PYG","QAR","RON","RSD","RUB","RWF",
    "SAR","SBD","SCR","SDG","SEK","SGD","SHP","SLE","SOS","SRD","SSP","STN","SVC","SYP","SZL","THB","TJS","TMT","TND","TOP",
    "TRY","TTD","TWD","TZS","UAH","UGX","USD","USN","UYI","UYU","UYW","UZS","VED","VES","VND","VUV","WST","XAF","XAG","XAU",
    "XBA","XBB","XBC","XBD","XCD","XDR","XOF","XPD","XPF","XPT","XSU","XTS","XUA","XXX","YER","ZAR","ZMW","ZWG"
  ];

  const streamTypes = ["WEB_DATA_STREAM","ANDROID_APP_DATA_STREAM","IOS_APP_DATA_STREAM"];
  const industryCategories = [
    "INDUSTRY_CATEGORY_UNSPECIFIED","AUTOMOTIVE","BUSINESS_AND_INDUSTRIAL_MARKETS","FINANCE","HEALTHCARE","TECHNOLOGY",
    "TRAVEL","OTHER","ARTS_AND_ENTERTAINMENT","BEAUTY_AND_FITNESS","BOOKS_AND_LITERATURE","FOOD_AND_DRINK","GAMES",
    "HOBBIES_AND_LEISURE","HOME_AND_GARDEN","INTERNET_AND_TELECOM","LAW_AND_GOVERNMENT","NEWS","ONLINE_COMMUNITIES",
    "PEOPLE_AND_SOCIETY","PETS_AND_ANIMALS","REAL_ESTATE","REFERENCE","SCIENCE","SPORTS","JOBS_AND_EDUCATION","SHOPPING"
  ];
  const enableDisable   = ["enable","disable"];   // F
  const dimensionScope  = ["EVENT","USER","ITEM"]; // G
  const metricScopeH    = ["EVENT"];               // H (your change)
  const measurementUnit = [                        // I
    "MEASUREMENT_UNIT_UNSPECIFIED","STANDARD","CURRENCY","FEET","METERS","KILOMETERS","MILES",
    "MILLISECONDS","SECONDS","MINUTES","HOURS"
  ];

  // Write lists (A..I)
  vs.clear();
  vs.getRange(1,1,1,9).setValues([[
    "Property Type","Time Zone","Currency","DataStreamType","IndustryCategory","EnableDisable",
    "DimensionScope","MetricScope","MeasurementUnit"
  ]]);

  const writeCol = (col, arr) => {
    const rows = Math.max(1, arr.length);
    const values = rows === 1 && arr.length === 0 ? [[""]] : arr.map(v => [v]);
    vs.getRange(2, col, rows, 1).setValues(values);
  };
  writeCol(1, propTypes);
  writeCol(2, timeZones);
  writeCol(3, currencies);
  writeCol(4, streamTypes);
  writeCol(5, industryCategories);
  writeCol(6, enableDisable);
  writeCol(7, dimensionScope);
  writeCol(8, metricScopeH);      // H: EVENT
  writeCol(9, measurementUnit);   // I: units

  vs.setFrozenRows(1);
  vs.autoResizeColumns(1,9);
  vs.hideSheet();

  // ---------- Apply Data Validations ----------
  const MAX_ROWS = 2000;

  // helper: apply list to target col; allowBlank toggles whether blanks are okay
  const applyValidation = (sheet, targetCol, listCol, allowBlank) => {
    const builder = SpreadsheetApp.newDataValidation().setAllowInvalid(!!allowBlank);
    const last = Math.max(2, vs.getLastRow());
    const listRange = vs.getRange(2, listCol, last - 1, 1);
    sheet.getRange(2, targetCol, MAX_ROWS, 1)
      .setDataValidation(builder.requireValueInRange(listRange, true).build());
  };

  // CreateProperty validations (unchanged)
  applyValidation(createProperty, 1, 1, false); // A <- A
  applyValidation(createProperty, 3, 5, false); // C <- E
  applyValidation(createProperty, 4, 2, false); // D <- B
  applyValidation(createProperty, 5, 3, false); // E <- C
  applyValidation(createProperty, 7, 4, false); // G <- D
  for (let col = 9; col <= 16; col++) {         // I:P <- F
    applyValidation(createProperty, col, 6, false);
  }

  // standardDimensions: Scope (C) <- DimensionScope (G)
  applyValidation(standardDimensions, 3, 7, false);

  // standardMetrics:
  //   Scope (C)      <- MetricScope (H) — allow blank per your note
  applyValidation(standardMetrics, 3, 8, true);
  //   Unit  (D)      <- MeasurementUnit (I) — required
  applyValidation(standardMetrics, 4, 9, false);

    // newDimensions:
  //   Scope (D) <- DimensionScope (G) — required
  applyValidation(newDimensions, 4, 7, false);

  // newMetrics:
  //   Scope (D) <- MetricScope (H) — allow blank (matches standardMetrics behavior)
  applyValidation(newMetrics, 4, 8, true);
  //   Unit  (E) <- MeasurementUnit (I) — required
  applyValidation(newMetrics, 5, 9, false);

  try {
    writeProjectReadmeSheet_();                 // <-- add this line
    ss.toast("Validation + README updated ✔");
  } catch (e) {
    Logger.log("README build failed: " + e.message);
    try { ss.toast("Validation updated (README build failed)"); } catch(_) {}
  }
}




function toBool_(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return undefined;
  if (["enabled","enable","true","t","yes","y","1"].includes(s)) return true;
  if (["disabled","disable","false","f","no","n","0"].includes(s)) return false;
  return undefined;
}


function buildEnhancedMeasurementFromRow_(row, columnMap) {
  // Read and normalize. Only include keys when value is explicitly set.
  const map = {
    streamEnabled:         toBool_(row[columnMap["streamenabled"]]),
    scrollsEnabled:        toBool_(row[columnMap["scrollsenabled"]]),
    outboundClicksEnabled: toBool_(row[columnMap["outboundclicksenabled"]]),
    siteSearchEnabled:     toBool_(row[columnMap["sitesearchenabled"]]),
    videoEngagementEnabled:toBool_(row[columnMap["videoengagementenabled"]]),
    fileDownloadsEnabled:  toBool_(row[columnMap["filedownloadsenabled"]]),
    pageChangesEnabled:    toBool_(row[columnMap["pagechangesenabled"]]),
    formInteractionsEnabled:toBool_(row[columnMap["forminteractionsenabled"]])
  };

  // Strip undefineds
  const payload = {};
  Object.keys(map).forEach(k => {
    if (typeof map[k] === "boolean") payload[k] = map[k];
  });
  return payload; // may be {}
}


function patchEnhancedMeasurement_(propertyId, dataStreamId, settingsObj) {
  // Nothing to update?
  if (!settingsObj || Object.keys(settingsObj).length === 0) {
    Logger.log("Enhanced Measurement: nothing to update (no fields set).");
    return null;
  }

  const base = `https://analyticsadmin.googleapis.com/v1alpha/properties/${encodeURIComponent(propertyId)}/dataStreams/${encodeURIComponent(dataStreamId)}/enhancedMeasurementSettings`;

  // Build masks
  const camelMask = Object.keys(settingsObj).join(",");
  const snakeMask = Object.keys(settingsObj)
    .map(k => k.replace(/[A-Z]/g, m => "_" + m.toLowerCase()))
    .join(",");

  // Try camelCase first
  const bodyCamel = JSON.stringify(settingsObj);
  const urlCamel  = `${base}?updateMask=${encodeURIComponent(camelMask)}`;

  const optionsBase = {
    method: "patch",
    headers: {
      Authorization: `Bearer ${ScriptApp.getOAuthToken()}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    muteHttpExceptions: true
  };

  let res = UrlFetchApp.fetch(urlCamel, { ...optionsBase, payload: bodyCamel });
  let code = res.getResponseCode();
  if (code === 200) {
    Logger.log("Enhanced Measurement updated (camelCase mask).");
    return JSON.parse(res.getContentText());
  }

  // Retry using snake_case body + mask (some Admin v1alpha resources prefer snake_case)
  const bodySnakeObj = {};
  Object.keys(settingsObj).forEach(k => {
    const snake = k.replace(/[A-Z]/g, m => "_" + m.toLowerCase());
    bodySnakeObj[snake] = settingsObj[k];
  });
  const bodySnake = JSON.stringify(bodySnakeObj);
  const urlSnake  = `${base}?updateMask=${encodeURIComponent(snakeMask)}`;

  res = UrlFetchApp.fetch(urlSnake, { ...optionsBase, payload: bodySnake });
  code = res.getResponseCode();
  if (code === 200) {
    Logger.log("Enhanced Measurement updated (snake_case mask).");
    return JSON.parse(res.getContentText());
  }

  Logger.log(`Enhanced Measurement PATCH failed.
  camelCase -> ${code} :: ${res.getContentText()}
  snake_case -> ${UrlFetchApp.fetch(urlSnake, { ...optionsBase, payload: bodySnake }).getContentText()}`);
  return null;
}


function getEnhancedMeasurement_(propertyId, dataStreamId) {
  const url = `https://analyticsadmin.googleapis.com/v1alpha/properties/${encodeURIComponent(propertyId)}/dataStreams/${encodeURIComponent(dataStreamId)}/enhancedMeasurementSettings`;
  const res = UrlFetchApp.fetch(url, {
    method: "get",
    headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}`, Accept: "application/json" },
    muteHttpExceptions: true
  });
  Logger.log(`GET EMS ${propertyId}/${dataStreamId}: ${res.getResponseCode()} :: ${res.getContentText()}`);
  if (res.getResponseCode() === 200) return JSON.parse(res.getContentText());
  return null;
}
