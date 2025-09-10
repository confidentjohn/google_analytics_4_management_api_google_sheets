/**
 * GA4 Settings helpers: data retention & Google Signals
 */

function getDataRetentionSettings(propertyID) {
  try {
    const url = `https://analyticsadmin.googleapis.com/v1beta/properties/${propertyID}/dataRetentionSettings`;
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

    return {
      eventDataRetention: data.eventDataRetention || "Unknown",
      userDataRetention: data.userDataRetention || "Unknown"
    };
  } catch (e) {
    Logger.log(`Error fetching retention settings for property ${propertyID}: ${e.message}`);
    return { eventDataRetention: "Error", userDataRetention: "Error" };
  }
}

function getGoogleSignalsSettings(propertyID) {
  try {
    const url = `https://analyticsadmin.googleapis.com/v1alpha/properties/${propertyID}/googleSignalsSettings`;
    const options = {
      method: "get",
      headers: {
        Authorization: `Bearer ${ScriptApp.getOAuthToken()}`,
        Accept: "application/json",
      },
      muteHttpExceptions: true,
    };

    const response = UrlFetchApp.fetch(url, options);
    const responseText = response.getContentText();
    
    if (responseText.startsWith("<")) {
      Logger.log(`Unexpected HTML response for property ${propertyID}: ${responseText}`);
      return { googleSignalsState: "Error (Invalid Response)", googleSignalsConsent: "Error (Invalid Response)" };
    }

    const data = JSON.parse(responseText);
    return {
      googleSignalsState: data.state || "GOOGLE_SIGNALS_STATE_UNSPECIFIED",
      googleSignalsConsent: data.consent || "GOOGLE_SIGNALS_CONSENT_UNSPECIFIED"
    };
  } catch (e) {
    Logger.log(`Error fetching Google Signals settings for property ${propertyID}: ${e.message}`);
    return { googleSignalsState: "Error", googleSignalsConsent: "Error" };
  }
}
