function toLabel(name) {
  return String(name || "")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function toViewKey(schema, table) {
  return String(schema ? `${schema}_${table}` : table || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function inferSearchOperator(sqlType, columnName) {
  if (/id$/i.test(String(columnName || ""))) {
    return "exact";
  }
  if (/char|text|string|uuid|json/i.test(String(sqlType || ""))) {
    return "contains";
  }
  return "exact";
}

function inferColumnFormat(sqlType) {
  const normalized = String(sqlType || "").toLowerCase();
  if (normalized === "date") {
    return "date";
  }
  if (/datetime|timestamp|smalldatetime|datetimeoffset/.test(normalized)) {
    return "datetime";
  }
  if (normalized === "time") {
    return "time";
  }
  return null;
}

function chooseKeyColumn(columns) {
  const primaryKey = columns.find((column) => column.isPrimaryKey)?.name;
  if (primaryKey) {
    return primaryKey;
  }
  const idColumn = columns.find((column) => /id$/i.test(column.name))?.name;
  if (idColumn) {
    return idColumn;
  }
  return columns[0]?.name || "";
}

function buildViewsConfigFromSchemaTables(tables, options = {}) {
  const normalizedOptions = {
    limit: Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 200,
    maxSearchFields:
      Number.isInteger(options.maxSearchFields) && options.maxSearchFields > 0
        ? options.maxSearchFields
        : 3,
    databaseName: String(options.databaseName || "").trim()
  };

  const views = {};

  for (const table of tables || []) {
    const tableName = String(table?.table || "").trim();
    const schemaName = String(table?.schema || "").trim();
    const columns = Array.isArray(table?.columns)
      ? table.columns
          .map((column) => ({
            name: String(column?.name || "").trim(),
            label: toLabel(column?.name || ""),
            sqlType: String(column?.sqlType || "").trim(),
            isPrimaryKey: Boolean(column?.isPrimaryKey)
          }))
          .filter((column) => column.name)
      : [];

    if (!tableName || !columns.length) {
      continue;
    }

    const keyColumn = chooseKeyColumn(columns);
    let viewKey = toViewKey(schemaName, tableName) || "view";
    let suffix = 1;
    while (views[viewKey]) {
      suffix += 1;
      viewKey = `${toViewKey(schemaName, tableName) || "view"}_${suffix}`;
    }

    const searchable = columns.slice(0, normalizedOptions.maxSearchFields).map((column) => ({
      column: column.name,
      label: column.label,
      operator: inferSearchOperator(column.sqlType, column.name),
      placeholder: `Search ${column.label}...`
    }));

    const view = {
      title: toLabel(tableName),
      table: tableName,
      keyColumn,
      limit: normalizedOptions.limit,
      defaultSort: {
        column: keyColumn,
        direction: "ASC"
      },
      columns: columns.map((column) => {
        const format = inferColumnFormat(column.sqlType);
        if (!format) {
          return { name: column.name, label: column.label };
        }
        return { name: column.name, label: column.label, format };
      }),
      searchFields: searchable,
      links: []
    };

    if (schemaName) {
      view.schema = schemaName;
    }
    if (normalizedOptions.databaseName) {
      view.database = normalizedOptions.databaseName;
    }

    views[viewKey] = view;
  }

  return { views };
}

module.exports = {
  buildViewsConfigFromSchemaTables
};
