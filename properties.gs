/**
 * GA4 properties: list & create (property creation delegates to data stream + dims/metrics)
 * Note: createGA4Properties expects createDataStream, createCustomDimensions, createCustomMetrics to exist globally.
 */

/**
 * listAccounts() from Code.js (kept as-is, includes UA section)
 */
function listAccounts() {
  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const timestamp = new Date().toISOString().replace(/[:.-]/g, "_");
    const sheetName = "GA4 Account List " + timestamp;
    const sheet = spreadsheet.insertSheet(sheetName);
    sheet.appendRow(['Account Name', 'Account ID', 'Property Type', 'Property Name', 'Property ID', 'Profile Name']);

    const accounts = AnalyticsAdmin.AccountSummaries.list();

    if (!accounts.accountSummaries || !accounts.accountSummaries.length) {
      Logger.log('No accounts found.');
      return;
    }

    Logger.log(accounts.accountSummaries.length + ' accounts found');

    for (let i = 0; i < accounts.accountSummaries.length; i++) {
      const account = accounts.accountSummaries[i];
      const accountID = account.account.replace('accounts/', '');

      if (account.propertySummaries) {
        let properties;
        let nextPageToken = null;

        do {
          properties = AnalyticsAdmin.Properties.list({
            filter: 'parent:' + account.account,
            pageToken: nextPageToken
          });

          if (properties.properties) {
            for (let j = 0; j < properties.properties.length; j++) {
              const propertyID = properties.properties[j].name.replace('properties/', '');
              const propertyName = properties.properties[j].displayName;
              sheet.appendRow([account.displayName, accountID, 'GA4', propertyName, propertyID, '']);

              const subProperties = AnalyticsAdmin.Properties.list({
                filter: 'parent:' + properties.properties[j].name
              });

              if (subProperties.properties && subProperties.properties.length > 0) {
                for (let k = 0; k < subProperties.properties.length; k++) {
                  const subPropertyID = subProperties.properties[k].name.replace('properties/', '');
                  const subPropertyName = subProperties.properties[k].displayName;
                  sheet.appendRow([account.displayName, accountID, 'GA4 (Subproperty)', subPropertyName, subPropertyID, '']);
                }
              }
            }
          }

          nextPageToken = properties.nextPageToken;

        } while (nextPageToken);
      } else {
        const webProperties = Analytics.Management.Webproperties.list(accountID);
        if (webProperties.items) {
          for (let j = 0; j < webProperties.items.length; j++) {
            const webProperty = webProperties.items[j];
            const webPropertyID = webProperty.id;
            sheet.appendRow([account.displayName, accountID, 'UA', webProperty.name, webPropertyID, '']);

            const profiles = Analytics.Management.Profiles.list(accountID, webPropertyID);
            if (profiles.items) {
              for (let k = 0; k < profiles.items.length; k++) {
                const profileName = profiles.items[k].name;
                sheet.getRange(sheet.getLastRow(), 6).setValue(profileName);
              }
            }
          }
        }
      }
    }
  } catch (e) {
    Logger.log('Failed with error: %s', e.message);
  }
}

/**
 * listAllGA4PropertyDetails() with optional Account ID filter via prompt.
 * - Leave blank: all accessible accounts
 * - One ID: that account only
 * - Comma-separated IDs: only those accounts
 */
function listAllGA4PropertyDetails() {
  try {
    // --- Get filter input (UI if available; otherwise default to "all") ---
    let idInput = "";
    try {
      const ui = SpreadsheetApp.getUi();
      const resp = ui.prompt(
        "Filter by Account IDs",
        "Enter GA4 Account IDs (comma-separated) or leave blank for ALL accounts:",
        ui.ButtonSet.OK_CANCEL
      );
      if (resp.getSelectedButton() === ui.Button.OK) {
        idInput = String(resp.getResponseText() || "").trim();
      } else {
        // Cancel just behaves like "all" to avoid throwing
        idInput = "";
      }
    } catch (e) {
      // No UI context (running from editor/trigger) -> treat as ALL
      Logger.log("No UI context; proceeding with ALL accounts.");
      idInput = "";
    }

    // Parse IDs if provided
    let filterSet = null; // null => all
    if (idInput) {
      const parts = idInput.split(",")
        .map(s => s.trim())
        .filter(s => s.length > 0);
      // keep only numeric-looking IDs
      const valid = parts.filter(s => /^[0-9]+$/.test(s));
      if (valid.length === 0) {
        Logger.log(`No valid numeric Account IDs found in input "${idInput}". Proceeding with ALL accounts.`);
      } else {
        filterSet = new Set(valid);
        Logger.log(`Filtering to Account IDs: ${valid.join(", ")}`);
      }
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const timestamp = new Date().toISOString().replace(/[:.-]/g, "_");
    const sheetName = "GA4 Properties " + timestamp;
    const sheet = ss.insertSheet(sheetName);

    sheet.appendRow([
      "Account Name", "Account ID", "Property ID", "Property Name", "Property Type",
      "Time Zone", "Currency Code", "Create Time", "Update Time", "Industry Category",
      "Service Level", "Deletion Request", "Display Name", "Parent Account",
      "Event Data Retention", "User Data Retention",
      "Google Signals State", "Google Signals Consent",
      "E-tag"
    ]);

    // Pull account summaries once; use them for names & to filter
    const accounts = AnalyticsAdmin.AccountSummaries.list();
    if (!accounts.accountSummaries || !accounts.accountSummaries.length) {
      Logger.log("No accounts found.");
      return;
    }
    Logger.log(accounts.accountSummaries.length + " accounts found");

    // Track which requested IDs were missing (for user feedback)
    const requestedIds = filterSet ? new Set([...filterSet]) : null;

    for (let i = 0; i < accounts.accountSummaries.length; i++) {
      const summary = accounts.accountSummaries[i];
      const accountNameFull = summary.account;              // e.g. "accounts/123"
      const accountID = accountNameFull.replace("accounts/", "");
      const accountDisplay = summary.displayName || "";

      // If filtering, skip accounts not in the set
      if (filterSet && !filterSet.has(accountID)) continue;

      // Mark this requested id as found
      if (requestedIds) requestedIds.delete(accountID);

      // Page through properties for this account
      let nextPageToken = null;
      do {
        let url = `https://analyticsadmin.googleapis.com/v1beta/properties?pageSize=200&filter=parent:accounts/${accountID}`;
        if (nextPageToken) url += `&pageToken=${nextPageToken}`;

        const options = {
          method: "get",
          headers: {
            Authorization: `Bearer ${ScriptApp.getOAuthToken()}`,
            Accept: "application/json",
          },
          muteHttpExceptions: true,
        };

        const response = UrlFetchApp.fetch(url, options);
        const data = JSON.parse(response.getContentText());

        if (data.properties && data.properties.length) {
          data.properties.forEach((property) => {
            const propertyID = property.name.replace("properties/", "");
            const { eventDataRetention, userDataRetention } = getDataRetentionSettings(propertyID);
            const { googleSignalsState, googleSignalsConsent } = getGoogleSignalsSettings(propertyID);

            sheet.appendRow([
              accountDisplay,
              accountID,
              propertyID,
              property.displayName,
              "GA4",
              property.timeZone || "",
              property.currencyCode || "",
              property.createTime || "",
              property.updateTime || "",
              property.industryCategory || "",
              property.serviceLevel || "",
              property.deleteRequested ? "Yes" : "No",
              property.displayName || "",
              property.parent || "",
              eventDataRetention,
              userDataRetention,
              googleSignalsState,
              googleSignalsConsent,
              property.etag || ""
            ]);
          });
        }

        nextPageToken = data.nextPageToken || null;
      } while (nextPageToken);
    }

    // Log any requested IDs that we didn't find in summaries
    if (requestedIds && requestedIds.size > 0) {
      Logger.log(`Warning: The following Account IDs were not found or accessible: ${[...requestedIds].join(", ")}`);
    }

    Logger.log("GA4 property details retrieved successfully.");
  } catch (e) {
    Logger.log("Error fetching GA4 properties: " + e.message);
  }
}

/**
 * createGA4Properties() and createProperty() from createGA4Property.js
 */
function createGA4Properties() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('CreateProperty');
  const dimensionSheet = ss.getSheetByName("standardDimensions");
  const metricSheet    = ss.getSheetByName("standardMetrics");
  const clacMetricSheet    = ss.getSheetByName("standardCalculatedMetrics");
  const channelSheet    = ss.getSheetByName("standardChannelGroups");

  const data = sheet.getDataRange().getValues();
  const header = data[0];
  const columnMap = {};
  header.forEach((h,i) => columnMap[String(h).toLowerCase()] = i);

  for (let i = 1; i < data.length; i++) {
    const row = data[i];

    // Inputs
    const propertyType     = row[columnMap['propertytype']];
    const displayName      = row[columnMap['displayname']];
    const industryCategory = row[columnMap['industrycategory']];
    const timeZone         = row[columnMap['timezone']];
    const currencyCode     = row[columnMap['currencycode']];
    const accountId        = row[columnMap['accountid']];
    const dataStreamType   = row[columnMap['datastreamtype']];
    const streamURI        = row[columnMap['streamuri']];

    // Basic validation
    if (!propertyType || !displayName || !industryCategory || !timeZone || !currencyCode || !accountId) {
      Logger.log('Missing data in row ' + (i + 1));
      continue;
    }

    // Create property
    const propertyPayload = {
      propertyType, displayName, industryCategory, timeZone, currencyCode,
      parent: `accounts/${accountId}`
    };
    const propertyResponse = createProperty(propertyPayload);

    if (propertyResponse && propertyResponse.name) {
      const propertyId = propertyResponse.name.split('/')[1];
      Logger.log('Property Created: ' + propertyId);

      // UI-safe toast + pause (works from menu OR editor)
      safeToast_(`Property ${propertyId} created`);
      pauseForGa360_(propertyId); // shows blocking alert if UI exists; logs & continues otherwise

      // Create data stream
      const dataStreamPayload = {
        "displayName": displayName,
        "type": String(dataStreamType || '').toUpperCase(),
        "webStreamData": { "defaultUri": streamURI }
      };
      const dataStreamResponse = createDataStream(propertyId, dataStreamPayload);
      Logger.log('Data Stream Created: ' + JSON.stringify(dataStreamResponse));

    // Only apply Enhanced Measurement for WEB streams
    if (dataStreamResponse && dataStreamResponse.type === "WEB_DATA_STREAM") {
    const fullName = dataStreamResponse.name || "";  // e.g. "properties/123/dataStreams/456"
    const parts = fullName.split("/");
    const dsId = parts[parts.length - 1];

    // Build settings from the CreateProperty sheet row (columns I–P)
    const emSettings = buildEnhancedMeasurementFromRow_(row, columnMap);

    // Patch Enhanced Measurement settings
    patchEnhancedMeasurement_(propertyId, dsId, emSettings);
    } else {
    Logger.log("Enhanced Measurement skipped: not a WEB_DATA_STREAM or missing response.");
    }



      // Seed standard dimensions/metrics
      createStandardCustomDimensions(propertyId, dimensionSheet);
      createStandardCustomMetrics(propertyId, metricSheet);
      createStandardCalculatedMetrics(propertyId, clacMetricSheet);
      createStandardChannelGroups(propertyId, channelSheet);
    } else {
      Logger.log('Property creation failed for row ' + (i + 1));
    }
  }
} 

function createProperty(payload) {
  const url = 'https://analyticsadmin.googleapis.com/v1beta/properties';
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
