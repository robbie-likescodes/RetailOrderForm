const SHEET_CATEGORIES = "Categories";
const SHEET_PRODUCTS = "Products";

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheetRows_(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error(`Missing sheet: ${sheetName}`);
  }

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(h => String(h || "").trim());
  return values.slice(1)
    .filter(row => row.some(cell => String(cell || "").trim() !== ""))
    .map(row => headers.reduce((acc, header, idx) => {
      acc[header] = row[idx];
      return acc;
    }, {}));
}

function isRowActive_(row) {
  if (!Object.prototype.hasOwnProperty.call(row, "active")) return true;
  const raw = row.active;
  if (raw === true) return true;
  if (raw === false || raw === 0) return false;
  const normalized = String(raw || "").trim().toLowerCase();
  if (!normalized) return false;
  return ["true", "yes", "y", "1"].includes(normalized);
}
