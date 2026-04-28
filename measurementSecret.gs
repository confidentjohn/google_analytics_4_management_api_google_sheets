/**
 * Measurement Protocol Secrets
 * API: v1beta (stable)
 *
 * Sheet: "newMPSecrets"
 * ┌─────────────┬────────────────┬──────────────┬─────────────┬──────────────┬────────┐
 * │ Property ID │ Data Stream ID │ Display Name │ Secret Name │ Secret Value │ Status │
 * └─────────────┴────────────────┴──────────────┴─────────────┴──────────────┴────────┘
 *
 * You fill in columns A–C. The script fills in D–F.
 *
 * The script automatically calls acknowledgeUserDataCollection for each unique
 * property ID before creating secrets. This is required by the API and is a
 * one-time operation per property — re-acknowledging an already-acknowledged
 * property is a no-op (returns 200 with empty body).
 *
 * ⚠️  Secret Value is ONLY returned by the API at creation time and is never
 *     returned again by list or get. Treat this sheet as the record of it.
 */
function createMeasurementProtocolSecrets() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("newMPSecrets");

  if (!sheet) {
    safeAlert_("Sheet not found", "Sheet 'newMPSecrets' not found. Run 'Create All Helper Sheets' first.");
    return;
  }

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    safeAlert_("No data", "No rows found in 'newMPSecrets'. Add at least one row below the header.");
    return;
  }

  // ── Header mapping ──────────────────────────────────────────────────
  const norm    = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const headers = data[0].map(norm);
  const col     = want => headers.indexOf(norm(want));

  const pidCol            = col("property id");
  const dsCol             = col("data stream id");
  const nameCol           = col("display name");
  const outSecretNameCol  = col("secret name");
  const outSecretValueCol = col("secret value");
  const outStatusCol      = col("status");

  if ([pidCol, dsCol, nameCol, outSecretNameCol, outSecretValueCol, outStatusCol].some(i => i === -1)) {
    safeAlert_("Missing headers",
      "Sheet must have columns: Property ID, Data Stream ID, Display Name, Secret Name, Secret Value, Status.\n" +
      "Run 'Create All Helper Sheets' to rebuild the sheet with the correct headers.");
    return;
  }

  const accessToken = ScriptApp.getOAuthToken();

  // ── Collect unique property IDs from unprocessed rows ──────────────
  // Acknowledge once per property up front — avoids hammering the API
  // with duplicate calls when multiple streams exist on the same property.
  const propertyIdsToAcknowledge = new Set();
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const propertyId = String(row[pidCol] || "").trim().replace(/^properties\//, "");
    const alreadyDone = String(row[outSecretValueCol] || "").trim();
    if (propertyId && !alreadyDone) {
      propertyIdsToAcknowledge.add(propertyId);
    }
  }

  if (!propertyIdsToAcknowledge.size) {
    safeAlert_("Nothing to do", "All rows already have a Secret Value — nothing to create.");
    return;
  }

  // ── Acknowledge user data collection for each unique property ───────
  Logger.log(`Acknowledging user data collection for ${propertyIdsToAcknowledge.size} properties...`);
  const ackFailed = new Set();

  propertyIdsToAcknowledge.forEach(propertyId => {
    const ok = acknowledgeUserDataCollection_(propertyId, accessToken);
    if (!ok) ackFailed.add(propertyId);
  });

  if (ackFailed.size) {
    Logger.log(`Acknowledgement failed for: ${[...ackFailed].join(", ")}`);
  }

  // ── Create secrets ──────────────────────────────────────────────────
  let created = 0, skipped = 0, failed = 0;

  for (let r = 1; r < data.length; r++) {
    const row = data[r];

    const propertyId   = String(row[pidCol]  || "").trim().replace(/^properties\//, "");
    const dataStreamId = String(row[dsCol]   || "").trim().replace(/^.*\/dataStreams\//, "");
    const displayName  = String(row[nameCol] || "").trim();

    // Skip blank rows
    if (!propertyId && !dataStreamId && !displayName) continue;

    // Skip rows already processed
    if (String(row[outSecretValueCol] || "").trim()) {
      sheet.getRange(r + 1, outStatusCol + 1).setValue("Skipped: already created");
      skipped++;
      continue;
    }

    // Validate required fields
    if (!propertyId || !dataStreamId || !displayName) {
      sheet.getRange(r + 1, outStatusCol + 1).setValue("Failed: missing Property ID, Data Stream ID, or Display Name");
      failed++;
      continue;
    }

    // Guard: catch Measurement IDs (G-XXXXXXXX) pasted into the wrong column
    if (/^G-/i.test(dataStreamId)) {
      sheet.getRange(r + 1, outStatusCol + 1).setValue(
        "Failed: Data Stream ID looks like a Measurement ID (G-...). Use the numeric Stream ID from the 'Data Stream ID' column of the GA4 Data Streams sheet."
      );
      failed++;
      continue;
    }

    // Skip if acknowledgement failed for this property
    if (ackFailed.has(propertyId)) {
      sheet.getRange(r + 1, outStatusCol + 1).setValue("Failed: user data collection acknowledgement failed for this property");
      failed++;
      continue;
    }

    const url = `https://analyticsadmin.googleapis.com/v1beta/properties/${propertyId}/dataStreams/${dataStreamId}/measurementProtocolSecrets`;
    Logger.log(`Row ${r + 1} → POST ${url}`);

    try {
      const res  = UrlFetchApp.fetch(url, {
        method:      "post",
        contentType: "application/json",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept:        "application/json"
        },
        muteHttpExceptions: true,
        payload: JSON.stringify({ displayName: displayName })
      });

      const code = res.getResponseCode();
      const body = JSON.parse(res.getContentText() || "{}");

      if (code === 200 || code === 201) {
        sheet.getRange(r + 1, outSecretNameCol  + 1).setValue(body.name        || "");
        sheet.getRange(r + 1, outSecretValueCol + 1).setValue(body.secretValue || "");
        sheet.getRange(r + 1, outStatusCol      + 1).setValue("Created");
        Logger.log(`Created: '${displayName}' → ${body.name}`);
        created++;
      } else {
        const errMsg = (body.error && body.error.message) ? body.error.message : res.getContentText();
        sheet.getRange(r + 1, outStatusCol + 1).setValue(`Failed: ${code} – ${errMsg}`);
        Logger.log(`Failed row ${r + 1}: ${code} – ${errMsg}`);
        failed++;
      }
    } catch (e) {
      sheet.getRange(r + 1, outStatusCol + 1).setValue(`Error: ${e.message}`);
      Logger.log(`Error row ${r + 1}: ${e.message}`);
      failed++;
    }
  }

  safeAlert_("Create MP Secrets",
    `Done.\nCreated: ${created}\nSkipped: ${skipped}\nFailed: ${failed}`);
}


// acknowledgeUserDataCollection_() is defined in data_streams.gs and shared globally.
