const NAVIGATION_SHEET_ID = 222016322;

function navigationWithBlocks_(profile) {
  if (!profile.ok) return profile;

  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = spreadsheet.getSheetById(NAVIGATION_SHEET_ID);
    if (!sheet) throw new Error('Лист доступов до блоков приложения не найден');

    const positions = new Set(String(profile.position || profile.type || '').split(',').map(normalize_).filter(Boolean));
    const [headers, ...rows] = sheet.getDataRange().getValues();
    const columns = [];
    for (let col = 1; col < headers.length; col++) {
      if (positions.has(normalize_(headers[col]))) columns.push(col);
    }

    const blocks = new Set();
    for (const row of rows) {
      const title = String(row[0] || '').trim();
      if (title && columns.some(col => row[col] === true)) blocks.add(title);
    }

    return { ...profile, blocks: [...blocks] };
  } catch (error) {
    // Недоступность листа навигации не должна мешать входу и выдаче прав на журналы.
    console.error(error.message || error);
    return profile;
  }
}
