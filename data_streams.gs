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
