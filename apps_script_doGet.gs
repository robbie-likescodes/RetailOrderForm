function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || "").trim();
    if (!action) {
      return jsonResponse({ ok: false, error: "Missing action." });
    }

    if (action === "categories") {
      const rows = getSheetRows_(SHEET_CATEGORIES)
        .filter(isRowActive_);
      return jsonResponse({
        ok: true,
        categories: rows,
        updated_at: new Date().toISOString(),
      });
    }

    if (action === "products") {
      const rows = getSheetRows_(SHEET_PRODUCTS)
        .filter(isRowActive_);
      return jsonResponse({
        ok: true,
        products: rows,
        updated_at: new Date().toISOString(),
      });
    }

    return jsonResponse({ ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: String(err),
      updated_at: new Date().toISOString(),
    });
  }
}
