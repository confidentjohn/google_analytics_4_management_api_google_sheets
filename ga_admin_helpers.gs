/**
 * GA4 Admin API helpers (shared by dimensions, metrics, exports)
 * Keep UI/sheet utilities in helpers.gs; keep GA4 discovery here.
 */

/** Fetch one page of account summaries. */
function getAccountSummaries(accessToken, pageToken) {
  let url = "https://analyticsadmin.googleapis.com/v1beta/accountSummaries";
  if (pageToken) url += `?pageToken=${encodeURIComponent(pageToken)}`;

  const options = {
    method: "get",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    muteHttpExceptions: true
  };

  try {
    const res = UrlFetchApp.fetch(url, options);
    return JSON.parse(res.getContentText());
  } catch (e) {
    Logger.log(`Error fetching account summaries: ${e.message}`);
    return {};
  }
}

/** Fetch all account summaries (handles pagination). */
function getAllAccountSummaries(accessToken) {
  let all = [];
  let nextPageToken = null;

  do {
    const page = getAccountSummaries(accessToken, nextPageToken) || {};
    if (page.accountSummaries) all = all.concat(page.accountSummaries);
    nextPageToken = page.nextPageToken || null;
  } while (nextPageToken);

  return all;
}

/** Flatten AccountSummaries → [{accountId, accountName, propertyId, propertyName}] */
function flattenProperties(accountSummaries) {
  const results = [];
  (accountSummaries || []).forEach(acc => {
    const accountId = (acc.account || "").split("/").pop();
    const accountName = acc.displayName || "";
    (acc.propertySummaries || []).forEach(ps => {
      const propertyId = (ps.property || "").replace("properties/", "");
      const propertyName = ps.displayName || "";
      results.push({ accountId, accountName, propertyId, propertyName });
    });
  });
  return results;
}

/**
 * Property metadata: {accountId, accountName, propertyId, propertyName} or null.
 * Useful when user supplies a propertyId and you want account + name.
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
    if (res.getResponseCode() !== 200) {
      Logger.log(`Property meta fetch failed (${res.getResponseCode()}) for ${propertyId}: ${res.getContentText()}`);
      return null;
    }
    const json = JSON.parse(res.getContentText());
    const propertyName = json.displayName || "";
    const parent = json.parent || ""; // "accounts/123"
    const accountId = parent.replace("accounts/", "");

    // Optionally enrich accountName from summaries
    let accountName = "";
    try {
      const summaries = getAllAccountSummaries(accessToken) || [];
      const list = summaries.accountSummaries || summaries;
      const match = (list || []).find(s => (s.account || "").endsWith(accountId));
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
  // Try to resolve account name via summaries (optional)
  let accountName = "";
  try {
    const summaries = getAllAccountSummaries(accessToken) || [];
    const list = summaries.accountSummaries || summaries;
    const match = (list || []).find(s => (s.account || "").endsWith(accountId));
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

/** Paged fetch for custom dimensions (scoped helper; avoids global name collision). */
function getCustomDimensionsPage_(accessToken, propertyId, pageToken) {
  let url = `https://analyticsadmin.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}/customDimensions`;
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
    Logger.log(`Error fetching custom dimensions for property ${propertyId}: ${e.message}`);
    return {};
  }
}

/** Paged fetch for custom metrics (scoped helper; avoids global name collision). */
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

/**
 * Filter a list of properties by user input.
 * - Blank input: return all
 * - Numeric IDs (comma-separated): filter by propertyId
 * - Otherwise: case-insensitive substring match on propertyName
 *
 * @param {Array<Object>} allProps  [{accountId, accountName, propertyId, propertyName}]
 * @param {string} input
 * @return {Array<Object>}
 */
function filterPropertiesByInput(allProps, input) {
  if (!input) return allProps;

  const trimmed = String(input).trim();
  const looksLikeIds = /^[0-9,\s]+$/.test(trimmed);

  if (looksLikeIds) {
    const ids = trimmed.split(",").map(s => s.trim()).filter(Boolean);
    return allProps.filter(p => ids.includes(p.propertyId));
  }

  const needle = trimmed.toLowerCase();
  return allProps.filter(p => (p.propertyName || "").toLowerCase().includes(needle));
}
