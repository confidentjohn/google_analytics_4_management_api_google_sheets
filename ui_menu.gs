function onOpen() {
  const ui = SpreadsheetApp.getUi();
  const menu = ui.createMenu('GA4 Admin');

  // --- Properties ---
  menu.addSubMenu(
    ui.createMenu('Account & Properties')
      .addItem('List Accounts Summary', 'listAccounts')
      .addItem('List All GA4 Properties', 'listAllGA4PropertyDetails')
  );

  // --- Custom Dimensions ---
  menu.addSubMenu(
    ui.createMenu('Custom Dimensions')
      .addItem('List Custom Dimensions', 'listCustomDimensions')
      .addItem('Create Ad-hoc Dimensions', 'createAdHocCustomDimensions')
      .addItem('Archive Dimensions', 'archiveCustomDimensions')
  );

  // --- Custom Metrics ---
  menu.addSubMenu(
    ui.createMenu('Custom Metrics')
      .addItem('List Custom Metrics', 'listCustomMetrics')
      .addItem('Create Ad-hoc Metrics', 'createAdHocCustomMetrics')
      .addItem('Archive Metrics', 'archiveCustomMetrics')
  );

  // --- Calculated Metrics ---
  menu.addSubMenu(
    ui.createMenu('Calculated Metrics')
      .addItem('List Calculated Metrics', 'listCalculatedMetrics')
      .addItem('Create Ad-hoc Calculated Metrics', 'createAdHocCalculatedMetrics')
      .addItem('Delete Calculated Metrics', 'deleteCalculatedMetricsFromSheet')
  );

  // --- Channel Groups ---
  menu.addSubMenu(
    ui.createMenu('Channel Groups')
      .addItem('List Channel Groups', 'listChannelGroups')
      .addItem('Create Channel Groups', 'createNewChannelGroups')
      .addItem('Update Channel Groups', 'updateChannelGroups')
  );

// --- All Dimensions, metrics, channels, calculations Groups ---
  menu.addSubMenu(
    ui.createMenu('All Dimensions, Metrics, Channels & Calculated Metrics')
      .addItem('Pull All', 'listAllAdminResourcesOnce')
  );


  // --- Properties ---
  menu.addSubMenu(
    ui.createMenu('admin - Property Creation (YOU CAN BREAK THINGS WITHIN THIS MENU)')
      .addItem('Create All Helper Sheets', 'setupTemplateSheetsAndValidation')
      .addSeparator()
      .addItem('Create GA4 Properties', 'createGA4Properties')
  );

  // Add to UI
  menu.addToUi();
}
