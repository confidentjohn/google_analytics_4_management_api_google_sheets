# google_analytics_4_management_api_google_sheets
A tool you can add to google sheets app scripts to manage properties, dimensions, metrics channels etc via the management api



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
