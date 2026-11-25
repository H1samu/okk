const MANAGEMENT_STATUSES = ['Активен', 'Не активен'];

function manageUsers_(req) {
  if (req.operation === 'list') {
    const actor = checkToken_(req.token, true);
    if (!actor.ok) return actor;
    if (actor.type !== CFG.ADMIN_POSITION) return { ok: false, error: 'forbidden' };

    const data = managementReadUsers_(getSheet_());
    return {
      ok: true,
      users: data.users,
      positions: managementPositions_(),
      statuses: MANAGEMENT_STATUSES
    };
  }

  if (!['create', 'setStatus', 'generatePin'].includes(req.operation)) {
    return { ok: false, error: 'bad_request' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { ok: false, error: 'busy' };
  try {
    const actor = checkToken_(req.token, true);
    if (!actor.ok) return actor;
    if (actor.type !== CFG.ADMIN_POSITION) return { ok: false, error: 'forbidden' };

    const sheet = getSheet_();
    const data = managementReadUsers_(sheet);
    const result = req.operation === 'create'
      ? managementCreateUser_(sheet, data, req)
      : managementChangeUser_(sheet, data, req);
    if (result.ok) managementFlushUsers_();
    return result;
  } finally {
    lock.releaseLock();
  }
}

function managementReadUsers_(sheet) {
  const values = sheet.getDataRange().getValues();
  const headers = values.shift().map(value => String(value).trim());
  const columns = {};
  Object.entries({ id: '№', ...CFG.COL }).forEach(([key, title]) => {
    columns[key] = headers.indexOf(title);
    if (columns[key] < 0) throw new Error('Нет столбца «' + title + '»');
  });

  const users = [];
  values.forEach((row, index) => {
    const name = String(row[columns.name]).trim();
    if (name) {
      users.push({
        row: index + 2,
        id: String(row[columns.id]).trim(),
        name,
        pin: String(row[columns.pin]).trim(),
        position: String(row[columns.position]).trim(),
        status: String(row[columns.status]).trim()
      });
    }
  });
  return { users, values, columns, width: headers.length };
}

function managementPositions_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CFG.ACCESS_SHEET);
  return [...new Set(sheet.getRange('B1:Z1').getDisplayValues()[0]
    .map(value => value.trim()).filter(Boolean))];
}

function managementCreateUser_(sheet, data, req) {
  const { users, values, columns, width } = data;
  const name = String(req.name || '').trim().replace(/\s+/g, ' ');
  if (name.length > 150 || !/^[\p{L}]/u.test(name)) {
    return { ok: false, error: 'invalid_name' };
  }
  if (users.some(user => normalize_(user.name) === normalize_(name))) {
    return { ok: false, error: 'duplicate_name' };
  }
  if (!managementPositions_().includes(req.position)) {
    return { ok: false, error: 'invalid_position' };
  }
  if (!MANAGEMENT_STATUSES.includes(req.status)) return { ok: false, error: 'invalid_status' };

  const pin = managementNewPin_(values, columns.pin);
  if (!pin) return { ok: false, error: 'pin_exhausted' };
  const id = 1 + values.reduce((max, row) => {
    const number = Number(row[columns.id]);
    return Number.isSafeInteger(number) ? Math.max(max, number) : max;
  }, 0);
  const row = values.length + 2;
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 1);

  const range = sheet.getRange(row, 1, 1, width);
  range.setDataValidations(sheet.getRange(2, 1, 1, width).getDataValidations());
  const entry = Array(width).fill('');
  entry[columns.id] = id;
  entry[columns.name] = name;
  entry[columns.pin] = Number(pin);
  entry[columns.position] = req.position;
  entry[columns.status] = req.status;
  entry[columns.gen] = false;
  range.setValues([entry]);
  return { ok: true, user: { row, id: String(id), name, pin, position: req.position, status: req.status } };
}

function managementChangeUser_(sheet, data, req) {
  const { users, values, columns } = data;
  const matches = users.filter(user => user.id === req.id && user.name === req.name);
  if (matches.length !== 1) return { ok: false, error: 'user_changed' };
  const user = matches[0];

  if (req.operation === 'setStatus') {
    if (!MANAGEMENT_STATUSES.includes(req.status)) return { ok: false, error: 'invalid_status' };
    if (req.status !== user.status) {
      sheet.getRange(user.row, columns.status + 1).setValue(req.status);
      user.status = req.status;
    }
  } else {
    if (req.currentPin !== user.pin) return { ok: false, error: 'user_changed' };
    const pin = managementNewPin_(values, columns.pin);
    if (!pin) return { ok: false, error: 'pin_exhausted' };
    sheet.getRange(user.row, columns.pin + 1).setValue(Number(pin));
    user.pin = pin;
  }

  return { ok: true, user };
}

function managementNewPin_(values, pinColumn) {
  const used = new Set(values.map(row => Number(row[pinColumn])));
  const available = [];
  for (let pin = 1000; pin <= 9999; pin++) {
    if (!used.has(pin)) available.push(pin);
  }
  if (!available.length) return '';
  const random = parseInt(Utilities.getUuid().slice(0, 8), 16);
  return String(available[random % available.length]);
}

function managementFlushUsers_() {
  SpreadsheetApp.flush();
  CacheService.getScriptCache().removeAll(['users_all', 'active_names']);
}

function managementSheetPin_(event) {
  if (!event || !event.range || event.value !== 'TRUE') return;
  const cell = event.range;
  const sheet = cell.getSheet();
  if (cell.getRow() < 2 || sheet.getName() !== CFG.SHEET_NAME) return;
  const header = sheet.getRange(1, cell.getColumn()).getDisplayValue();
  if (header.trim() !== CFG.COL.gen) return;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    cell.setValue(false);
    event.source.toast('Таблица сейчас обновляется. Повторите генерацию.');
    return;
  }

  try {
    const { values, columns } = managementReadUsers_(sheet);
    const pin = managementNewPin_(values, columns.pin);
    if (pin) {
      sheet.getRange(cell.getRow(), columns.pin + 1).setValue(Number(pin));
    } else {
      event.source.toast('Свободные четырёхзначные PIN-коды закончились.');
    }
    cell.setValue(false);
    managementFlushUsers_();
  } finally {
    lock.releaseLock();
  }
}

function managementTestResults_(token) {
  const actor = checkToken_(token, true);
  if (!actor.ok) return actor;
  const positions = String(actor.position || actor.type || '').split(',').map(normalize_);
  if (!positions.includes(normalize_(CFG.ADMIN_POSITION)) && !positions.includes('сотрудник окк')) {
    return { ok: false, error: 'forbidden' };
  }

  const sheet = SpreadsheetApp.openById(TEST_CFG.SPREADSHEET_ID).getSheetById(377642348);
  const [headers, ...values] = sheet.getDataRange().getDisplayValues();
  const rows = values.filter(row => row.some(value => value !== '')).reverse();
  return { ok: true, headers, rows, total: rows.length };
}
