const fs = require("fs");
const path = require("path");
const express = require("express");
const sql = require("mssql");
const { buildViewsConfigFromSchemaTables } = require("./utils/buildViewsConfigFromSchema");

const app = express();
const PORT = process.env.PORT || 3000;

const appConfigPath = path.join(__dirname, "..", "config", "app.config.json");
const viewsConfigPath = path.join(__dirname, "..", "config", "views.config.json");
const servedFilesPath = path.join(__dirname, "..", "files");

let appConfig;
let viewsConfig;

function loadConfigs() {
  appConfig = JSON.parse(fs.readFileSync(appConfigPath, "utf8"));
  viewsConfig = JSON.parse(fs.readFileSync(viewsConfigPath, "utf8"));
}

function saveViewsConfig() {
  fs.writeFileSync(viewsConfigPath, `${JSON.stringify(viewsConfig, null, 2)}\n`, "utf8");
}

function saveAppConfig() {
  fs.writeFileSync(appConfigPath, `${JSON.stringify(appConfig, null, 2)}\n`, "utf8");
}

app.use(express.urlencoded({ extended: false }));

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toInlineJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function encodeBreadcrumbs(crumbs) {
  return Buffer.from(JSON.stringify(crumbs), "utf8").toString("base64url");
}

function decodeBreadcrumbs(value) {
  if (!value || typeof value !== "string") {
    return [];
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => ({
        label: String(item?.label || "").trim(),
        url: String(item?.url || "").trim()
      }))
      .filter((item) => item.label && item.url.startsWith("/"));
  } catch {
    return [];
  }
}

function stripQueryParam(urlPath, paramName) {
  const input = String(urlPath || "");
  const qIndex = input.indexOf("?");
  if (qIndex === -1) {
    return input;
  }
  const pathOnly = input.slice(0, qIndex);
  const params = new URLSearchParams(input.slice(qIndex + 1));
  params.delete(paramName);
  const query = params.toString();
  return query ? `${pathOnly}?${query}` : pathOnly;
}

function buildQueryString(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, String(item));
      }
      continue;
    }
    if (value === undefined || value === null) {
      continue;
    }
    params.set(key, String(value));
  }
  return params.toString();
}

function escapeCsv(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function quoteIdentifier(identifier, dbType) {
  const safe = String(identifier);
  if (dbType === "duckdb") {
    return `"${safe.replaceAll('"', '""')}"`;
  }
  return `[${safe.replaceAll("]", "]]" )}]`;
}

function normalizeDatabaseName(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function getDatabaseCatalog() {
  const databaseConfig = appConfig.database || {};
  const connections = {};
  let defaultConnection = normalizeDatabaseName(databaseConfig.defaultConnection || databaseConfig.activeConnection);

  if (databaseConfig.connections && typeof databaseConfig.connections === "object") {
    for (const [name, definition] of Object.entries(databaseConfig.connections)) {
      const normalizedName = normalizeDatabaseName(name);
      if (normalizedName) {
        connections[normalizedName] = definition;
      }
    }
  }

  if (!Object.keys(connections).length) {
    connections.default = {
      type: String(process.env.DB_TYPE || databaseConfig.type || "sqlserver").toLowerCase(),
      sqlserver: {
        server: process.env.DB_SERVER || databaseConfig.sqlserver?.server || databaseConfig.server || "",
        database: process.env.DB_DATABASE || databaseConfig.sqlserver?.database || databaseConfig.database || "",
        user: process.env.DB_USER || databaseConfig.sqlserver?.user || databaseConfig.user || "",
        password: process.env.DB_PASSWORD || databaseConfig.sqlserver?.password || databaseConfig.password || "",
        port: Number(process.env.DB_PORT || databaseConfig.sqlserver?.port || databaseConfig.port || 1433),
        options: {
          encrypt: databaseConfig.sqlserver?.options?.encrypt ?? databaseConfig.options?.encrypt ?? true,
          trustServerCertificate:
            databaseConfig.sqlserver?.options?.trustServerCertificate ??
            databaseConfig.options?.trustServerCertificate ??
            true
        }
      },
      duckdb: {
        path: process.env.DUCKDB_PATH || databaseConfig.duckdb?.path || ":memory:"
      }
    };
    defaultConnection = "default";
  }

  if (!defaultConnection || !connections[defaultConnection]) {
    defaultConnection = Object.keys(connections)[0] || "default";
  }

  return { connections, defaultConnection };
}

function resolveDatabaseConnection(databaseName = "") {
  const catalog = getDatabaseCatalog();
  const requestedName = normalizeDatabaseName(databaseName);
  if (requestedName && !catalog.connections[requestedName]) {
    throw new Error(`Database connection not found: ${requestedName}`);
  }
  const resolvedName = requestedName || catalog.defaultConnection;
  const connection = catalog.connections[resolvedName];
  if (!connection) {
    throw new Error(`Database connection not found: ${requestedName || catalog.defaultConnection || "default"}`);
  }
  return {
    name: resolvedName,
    type: String(connection.type || "sqlserver").trim().toLowerCase(),
    config: connection,
    defaultConnection: catalog.defaultConnection,
    availableNames: Object.keys(catalog.connections)
  };
}

function getViewDatabaseConnection(view) {
  return resolveDatabaseConnection(view?.database);
}

function getDatabaseType(view = null) {
  return view ? getViewDatabaseConnection(view).type : resolveDatabaseConnection().type;
}

function getView(viewName) {
  return viewsConfig.views[viewName] || null;
}

function collectAllowedColumns(view) {
  const columns = new Set();

  if (Array.isArray(view.columns)) {
    for (const column of view.columns) {
      columns.add(column.name);
    }
  }

  if (view.keyColumn) {
    columns.add(view.keyColumn);
  }

  for (const column of collectLinkLocalColumns(view)) {
    columns.add(column);
  }

  return columns;
}

function collectLinkLocalColumns(view) {
  const columns = new Set();
  for (const link of view.links || []) {
    for (const mapping of extractLinkKeyMappings(link)) {
      if (mapping.localColumn) {
        columns.add(mapping.localColumn);
      }
    }
    for (const templateColumn of extractTemplateKeys(link?.label)) {
      columns.add(templateColumn);
    }
    for (const templateColumn of extractTemplateKeys(link?.urlTemplate)) {
      columns.add(templateColumn);
    }
  }
  return columns;
}

function normalizeRowKeyVariants(input) {
  const text = String(input || "").trim();
  if (!text) {
    return [];
  }
  const variants = new Set();
  const add = (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized) {
      variants.add(normalized);
    }
  };

  const stripWrappers = (value) =>
    String(value || "")
      .trim()
      .replace(/^\[([^\]]+)\]$/u, "$1")
      .replace(/^"(.+)"$/u, "$1")
      .replace(/^`(.+)`$/u, "$1");

  add(text);
  const unwrapped = stripWrappers(text);
  add(unwrapped);

  const parts = unwrapped.split(".").map((part) => stripWrappers(part));
  if (parts.length > 1) {
    add(parts[parts.length - 1]);
  }

  return Array.from(variants);
}

function buildRowKeyIndex(row) {
  const index = new Map();
  for (const key of Object.keys(row || {})) {
    for (const variant of normalizeRowKeyVariants(key)) {
      if (!index.has(variant)) {
        index.set(variant, key);
      }
    }
    const lowered = key.toLowerCase();
    if (!index.has(lowered)) {
      index.set(lowered, key);
    }
  }
  return index;
}

function getRowValue(row, columnName, rowKeyIndex = null) {
  if (!row || !columnName) {
    return undefined;
  }
  const requestedKey = String(columnName).trim();
  if (Object.prototype.hasOwnProperty.call(row, requestedKey)) {
    return row[requestedKey];
  }
  const index = rowKeyIndex || buildRowKeyIndex(row);
  for (const variant of normalizeRowKeyVariants(requestedKey)) {
    const matchedKey = index.get(variant);
    if (matchedKey) {
      return row[matchedKey];
    }
  }
  return undefined;
}

function resolveTableName(view, dbType) {
  const table = quoteIdentifier(view.table, dbType);

  if (dbType === "duckdb" || !view.schema) {
    return table;
  }

  return `${quoteIdentifier(view.schema, dbType)}.${table}`;
}

function buildQuery(view, options, dbType) {
  const allowedColumns = collectAllowedColumns(view);
  const selectColumns = [];
  const selected = new Set();
  const addSelectColumn = (columnName) => {
    if (!columnName || selected.has(columnName)) {
      return;
    }
    selected.add(columnName);
    selectColumns.push(columnName);
  };

  for (const column of view.columns || []) {
    addSelectColumn(column.name);
  }
  if (view.keyColumn) {
    addSelectColumn(view.keyColumn);
  }
  for (const column of collectLinkLocalColumns(view)) {
    addSelectColumn(column);
  }

  const columns = selectColumns.map((columnName) => quoteIdentifier(columnName, dbType)).join(", ");

  const tableRef = resolveTableName(view, dbType);

  const whereClauses = [];
  const queryParams = [];
  let paramIndex = 0;

  for (const filter of options.filters || []) {
    if (
      filter.operator === "in" &&
      filter.column &&
      allowedColumns.has(filter.column) &&
      Array.isArray(filter.values) &&
      filter.values.length
    ) {
      const nonEmptyValues = filter.values
        .map((value) => String(value))
        .filter((value) => value.trim() !== "");

      if (!nonEmptyValues.length) {
        continue;
      }

      if (dbType === "duckdb") {
        const placeholders = nonEmptyValues.map(() => "?").join(", ");
        whereClauses.push(`${quoteIdentifier(filter.column, dbType)} IN (${placeholders})`);
        queryParams.push(...nonEmptyValues);
      } else {
        const paramNames = nonEmptyValues.map(() => `filterValue${paramIndex++}`);
        whereClauses.push(
          `${quoteIdentifier(filter.column, dbType)} IN (${paramNames.map((name) => `@${name}`).join(", ")})`
        );
        for (let i = 0; i < nonEmptyValues.length; i += 1) {
          queryParams.push({
            name: paramNames[i],
            value: nonEmptyValues[i]
          });
        }
      }
      continue;
    }

    if (
      !filter.column ||
      filter.value === undefined ||
      filter.value === null ||
      String(filter.value).trim() === "" ||
      !allowedColumns.has(filter.column)
    ) {
      continue;
    }

    const normalizedOperator = normalizeSearchOperator(filter.operator);
    const sqlOperator = resolveSqlOperator(normalizedOperator);

    if (dbType === "duckdb") {
      whereClauses.push(`${quoteIdentifier(filter.column, dbType)} ${sqlOperator} ?`);
      queryParams.push(applySearchPattern(String(filter.value), normalizedOperator));
      continue;
    }

    const paramName = `filterValue${paramIndex++}`;
    whereClauses.push(`${quoteIdentifier(filter.column, dbType)} ${sqlOperator} @${paramName}`);
    queryParams.push({
      name: paramName,
      value: applySearchPattern(String(filter.value), normalizedOperator)
    });
  }

  const whereSql = whereClauses.length ? ` WHERE ${whereClauses.join(" AND ")}` : "";

  const sorts = resolveSorts(view, options, allowedColumns);
  const orderByClause = sorts
    .map((item) => `${quoteIdentifier(item.column, dbType)} ${item.direction}`)
    .join(", ");
  const sortColumn = sorts[0].column;
  const direction = sorts[0].direction;

  const pageSize = parsePositiveInt(options.limit, 200);
  const page = parsePositiveInt(options.page, 1);
  const fetchLimit = parsePositiveInt(options.fetchLimit, pageSize);
  const offset = (page - 1) * pageSize;

  const query =
    dbType === "duckdb"
      ? `SELECT ${columns} FROM ${tableRef}${whereSql} ORDER BY ${orderByClause} LIMIT ${fetchLimit} OFFSET ${offset}`
      : `SELECT ${columns} FROM ${tableRef}${whereSql} ORDER BY ${orderByClause} OFFSET ${offset} ROWS FETCH NEXT ${fetchLimit} ROWS ONLY`;

  return { query, queryParams, sorts, sortColumn, direction, pageSize, page };
}

function buildCountQuery(view, options, dbType) {
  const allowedColumns = collectAllowedColumns(view);
  const tableRef = resolveTableName(view, dbType);
  const whereClauses = [];
  const queryParams = [];
  let paramIndex = 0;

  for (const filter of options.filters || []) {
    if (
      filter.operator === "in" &&
      filter.column &&
      allowedColumns.has(filter.column) &&
      Array.isArray(filter.values) &&
      filter.values.length
    ) {
      const nonEmptyValues = filter.values
        .map((value) => String(value))
        .filter((value) => value.trim() !== "");
      if (!nonEmptyValues.length) {
        continue;
      }
      if (dbType === "duckdb") {
        const placeholders = nonEmptyValues.map(() => "?").join(", ");
        whereClauses.push(`${quoteIdentifier(filter.column, dbType)} IN (${placeholders})`);
        queryParams.push(...nonEmptyValues);
      } else {
        const paramNames = nonEmptyValues.map(() => `filterValue${paramIndex++}`);
        whereClauses.push(
          `${quoteIdentifier(filter.column, dbType)} IN (${paramNames.map((name) => `@${name}`).join(", ")})`
        );
        for (let i = 0; i < nonEmptyValues.length; i += 1) {
          queryParams.push({
            name: paramNames[i],
            value: nonEmptyValues[i]
          });
        }
      }
      continue;
    }

    if (
      !filter.column ||
      filter.value === undefined ||
      filter.value === null ||
      String(filter.value).trim() === "" ||
      !allowedColumns.has(filter.column)
    ) {
      continue;
    }

    const normalizedOperator = normalizeSearchOperator(filter.operator);
    const sqlOperator = resolveSqlOperator(normalizedOperator);

    if (dbType === "duckdb") {
      whereClauses.push(`${quoteIdentifier(filter.column, dbType)} ${sqlOperator} ?`);
      queryParams.push(applySearchPattern(String(filter.value), normalizedOperator));
      continue;
    }

    const paramName = `filterValue${paramIndex++}`;
    whereClauses.push(`${quoteIdentifier(filter.column, dbType)} ${sqlOperator} @${paramName}`);
    queryParams.push({
      name: paramName,
      value: applySearchPattern(String(filter.value), normalizedOperator)
    });
  }

  const whereSql = whereClauses.length ? ` WHERE ${whereClauses.join(" AND ")}` : "";
  const query = `SELECT COUNT(1) AS totalCount FROM ${tableRef}${whereSql}`;
  return { query, queryParams };
}

function normalizeSearchOperator(operator) {
  switch (String(operator || "contains").toLowerCase()) {
    case "exact":
      return "exact";
    case "startswith":
      return "startswith";
    case "endswith":
      return "endswith";
    case "gt":
      return "gt";
    case "gte":
      return "gte";
    case "lt":
      return "lt";
    case "lte":
      return "lte";
    default:
      return "contains";
  }
}

function resolveSqlOperator(operator) {
  switch (operator) {
    case "exact":
      return "=";
    case "gt":
      return ">";
    case "gte":
      return ">=";
    case "lt":
      return "<";
    case "lte":
      return "<=";
    default:
      return "LIKE";
  }
}

function applySearchPattern(value, operator) {
  if (operator === "exact" || operator === "gt" || operator === "gte" || operator === "lt" || operator === "lte") {
    return value;
  }
  if (operator === "startswith") {
    return `${value}%`;
  }
  if (operator === "endswith") {
    return `%${value}`;
  }
  return `%${value}%`;
}

function normalizeSortDirection(direction, fallback = "ASC") {
  return String(direction || fallback).toUpperCase() === "DESC" ? "DESC" : "ASC";
}

function splitSortValues(value) {
  const parts = [];
  for (const item of asArray(value)) {
    if (item === undefined || item === null) {
      continue;
    }
    for (const piece of String(item).split(",")) {
      const normalized = piece.trim();
      if (normalized) {
        parts.push(normalized);
      }
    }
  }
  return parts;
}

function normalizeDefaultSorts(defaultSort) {
  if (Array.isArray(defaultSort)) {
    return defaultSort
      .map((entry) => ({
        column: entry?.column,
        direction: normalizeSortDirection(entry?.direction, "ASC")
      }))
      .filter((entry) => entry.column);
  }

  if (defaultSort && typeof defaultSort === "object" && defaultSort.column) {
    return [
      {
        column: defaultSort.column,
        direction: normalizeSortDirection(defaultSort.direction, "ASC")
      }
    ];
  }

  return [];
}

function collectRequestedSorts(sortBy, sortDir) {
  const columns = splitSortValues(sortBy);
  const directions = splitSortValues(sortDir);
  return columns.map((column, index) => ({
    column,
    direction: normalizeSortDirection(directions[index], "ASC")
  }));
}

function resolveSorts(view, options, allowedColumns) {
  const normalizeAndFilter = (items) => {
    const seen = new Set();
    const result = [];
    for (const item of items) {
      if (!item?.column || !allowedColumns.has(item.column) || seen.has(item.column)) {
        continue;
      }
      seen.add(item.column);
      result.push({
        column: item.column,
        direction: normalizeSortDirection(item.direction, "ASC")
      });
    }
    return result;
  };

  const requestedSorts = normalizeAndFilter(collectRequestedSorts(options.sortBy, options.sortDir));
  if (requestedSorts.length) {
    return requestedSorts;
  }

  const defaultSorts = normalizeAndFilter(normalizeDefaultSorts(view.defaultSort));
  if (defaultSorts.length) {
    return defaultSorts;
  }

  return [{ column: view.columns[0].name, direction: "ASC" }];
}

function asArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function firstQueryValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function normalizeSearchFieldType(type) {
  switch (String(type || "text").toLowerCase()) {
    case "select":
      return "select";
    case "multiselect":
    case "multi_select":
    case "multicheckbox":
    case "multi_checkbox":
    case "checkboxes":
      return "multiSelect";
    case "date":
      return "date";
    case "daterange":
    case "date_range":
    case "range":
      return "dateRange";
    default:
      return "text";
  }
}

function getSearchFieldType(field) {
  if (field?.type !== undefined && field?.type !== null && String(field.type).trim() !== "") {
    return normalizeSearchFieldType(field.type);
  }
  return normalizeSearchFieldType(field?.operator);
}

function extractLinkKeyMappings(link) {
  if (Array.isArray(link.keys)) {
    return link.keys
      .map((item) => ({
        localColumn: item?.localColumn,
        targetColumn: item?.targetColumn
      }))
      .filter((item) => item.localColumn && item.targetColumn);
  }

  if (Array.isArray(link.localColumns) && Array.isArray(link.targetColumns)) {
    const count = Math.min(link.localColumns.length, link.targetColumns.length);
    const pairs = [];
    for (let i = 0; i < count; i += 1) {
      if (link.localColumns[i] && link.targetColumns[i]) {
        pairs.push({
          localColumn: link.localColumns[i],
          targetColumn: link.targetColumns[i]
        });
      }
    }
    if (pairs.length) {
      return pairs;
    }
  }

  if (link.localColumn && link.targetColumn) {
    return [{ localColumn: link.localColumn, targetColumn: link.targetColumn }];
  }

  return [];
}

function buildLinkFilters(link, row) {
  const mappings = extractLinkKeyMappings(link);
  const filters = [];
  const rowKeyIndex = buildRowKeyIndex(row);

  for (const mapping of mappings) {
    const localValue = getRowValue(row, mapping.localColumn, rowKeyIndex);
    if (localValue === undefined || localValue === null) {
      continue;
    }
    filters.push({
      column: mapping.targetColumn,
      value: String(localValue)
    });
  }

  return filters;
}

function renderLinkLabel(template, row) {
  const fallback = template === undefined || template === null ? "" : String(template);
  const rowKeyIndex = buildRowKeyIndex(row);
  return fallback.replace(/\{\{\s*([^{}]+?)\s*\}\}|\{([^{}]+?)\}/g, (match, keyA, keyB) => {
    const key = String(keyA || keyB || "").trim();
    if (!key) {
      return match;
    }
    const value = getRowValue(row, key, rowKeyIndex);
    if (value === undefined || value === null) {
      return "";
    }
    return String(value);
  });
}

function renderLinkTemplate(template, row, options = {}) {
  const fallback = template === undefined || template === null ? "" : String(template);
  const encodeValues = Boolean(options.encodeValues);
  const rowKeyIndex = buildRowKeyIndex(row);
  return fallback.replace(/\{\{\s*([^{}]+?)\s*\}\}|\{([^{}]+?)\}/g, (match, keyA, keyB) => {
    const key = String(keyA || keyB || "").trim();
    if (!key) {
      return match;
    }
    const value = getRowValue(row, key, rowKeyIndex);
    if (value === undefined || value === null) {
      return "";
    }
    const text = String(value);
    return encodeValues ? encodeURIComponent(text) : text;
  });
}

function extractTemplateKeys(template) {
  const text = template === undefined || template === null ? "" : String(template);
  const keys = new Set();
  const pattern = /\{\{\s*([^{}]+?)\s*\}\}|\{([^{}]+?)\}/g;
  let match = pattern.exec(text);
  while (match) {
    const key = String(match[1] || match[2] || "").trim();
    if (key) {
      keys.add(key);
    }
    match = pattern.exec(text);
  }
  return keys;
}

function isHttpUrl(url) {
  const value = String(url || "").trim();
  return /^https?:\/\//i.test(value);
}

function isSafeLinkUrl(url) {
  const value = String(url || "").trim();
  return isHttpUrl(value) || value.startsWith("/");
}

function buildLinkUrl(link, row, nextBreadcrumbsToken = "") {
  const urlTemplate = String(link?.urlTemplate || "").trim();
  if (urlTemplate) {
    const rendered = renderLinkTemplate(urlTemplate, row, { encodeValues: true }).trim();
    if (!isSafeLinkUrl(rendered)) {
      return null;
    }
    return rendered;
  }

  const linkFilters = buildLinkFilters(link, row);
  if (!linkFilters.length || !link.targetView) {
    return null;
  }

  const linkParams = new URLSearchParams();
  for (const filter of linkFilters) {
    linkParams.set(`f_${filter.column}`, filter.value);
  }
  if (nextBreadcrumbsToken) {
    linkParams.set("crumbs", nextBreadcrumbsToken);
  }
  return `/table/${encodeURIComponent(link.targetView)}?${linkParams.toString()}`;
}

function shouldOpenLinkInNewTab(link, url) {
  if (typeof link?.openInNewTab === "boolean") {
    return link.openInNewTab;
  }
  return isHttpUrl(url);
}

function renderLinkAnchor(link, label, url) {
  if (!url) {
    return "";
  }
  const targetAttr = shouldOpenLinkInNewTab(link, url) ? ` target="_blank" rel="noopener noreferrer"` : "";
  return `<a href="${escapeHtml(url)}"${targetAttr}>${escapeHtml(label)}</a>`;
}

function collectSearchFilters(view, query) {
  const filters = [];
  const addedColumns = new Set();

  for (const field of view.searchFields || []) {
    const column = field.column;
    if (!column) {
      continue;
    }
    const fieldType = getSearchFieldType(field);

    if (fieldType === "dateRange") {
      const fromParam = `s_${column}_from`;
      const toParam = `s_${column}_to`;
      const fromValue = firstQueryValue(query[fromParam]);
      const toValue = firstQueryValue(query[toParam]);

      if (fromValue !== undefined && fromValue !== null && String(fromValue).trim() !== "") {
        addedColumns.add(column);
        filters.push({
          column,
          value: String(fromValue),
          operator: "gte",
          label: `${field.label || column} from`,
          source: "search"
        });
      }
      if (toValue !== undefined && toValue !== null && String(toValue).trim() !== "") {
        addedColumns.add(column);
        filters.push({
          column,
          value: String(toValue),
          operator: "lte",
          label: `${field.label || column} to`,
          source: "search"
        });
      }
      continue;
    }

    if (fieldType === "multiSelect") {
      const paramName = `s_${column}`;
      const values = asArray(query[paramName])
        .map((value) => String(value))
        .filter((value) => value.trim() !== "");
      if (!values.length) {
        continue;
      }
      addedColumns.add(column);
      filters.push({
        column,
        values,
        operator: "in",
        label: field.label || column,
        source: "search"
      });
      continue;
    }

    const paramName = `s_${column}`;
    const value = firstQueryValue(query[paramName]);
    if (value === undefined || value === null || String(value).trim() === "") {
      continue;
    }

    addedColumns.add(column);
    filters.push({
      column,
      value: String(value),
      operator:
        fieldType === "select" || fieldType === "date"
          ? "exact"
          : normalizeSearchOperator(field.operator),
      label: field.label || column,
      source: "search"
    });
  }

  for (const [queryKey, queryValue] of Object.entries(query)) {
    if (!queryKey.startsWith("f_")) {
      continue;
    }
    const filterColumn = queryKey.slice(2);
    const filterValue = firstQueryValue(queryValue);
    if (
      !filterColumn ||
      filterValue === undefined ||
      filterValue === null ||
      String(filterValue).trim() === "" ||
      addedColumns.has(filterColumn)
    ) {
      continue;
    }
    addedColumns.add(filterColumn);
    filters.push({
      column: filterColumn,
      value: String(filterValue),
      operator: "exact",
      label: filterColumn,
      source: "exact"
    });
  }

  for (const [queryKey, queryValue] of Object.entries(query)) {
    if (!queryKey.startsWith("cf_")) {
      continue;
    }
    const filterColumn = queryKey.slice(3);
    const filterValue = firstQueryValue(queryValue);
    if (
      !filterColumn ||
      filterValue === undefined ||
      filterValue === null ||
      String(filterValue).trim() === "" ||
      addedColumns.has(filterColumn)
    ) {
      continue;
    }
    addedColumns.add(filterColumn);
    filters.push({
      column: filterColumn,
      value: String(filterValue),
      operator: "contains",
      label: `${filterColumn} contains`,
      source: "column"
    });
  }

  const legacyColumns = asArray(query.filterColumn);
  const legacyValues = asArray(query.filterValue);
  const maxLegacyFilters = Math.max(legacyColumns.length, legacyValues.length);

  for (let i = 0; i < maxLegacyFilters; i += 1) {
    const filterColumn = String(legacyColumns[i] ?? legacyColumns[0] ?? "").trim();
    const filterValue = legacyValues[i] ?? legacyValues[0];
    if (
      !filterColumn ||
      filterValue === undefined ||
      filterValue === null ||
      String(filterValue).trim() === "" ||
      addedColumns.has(filterColumn)
    ) {
      continue;
    }
    if (!query[`s_${filterColumn}`]) {
      addedColumns.add(filterColumn);
      filters.push({
        column: filterColumn,
        value: String(filterValue),
        operator: "exact",
        label: filterColumn,
        source: "exact"
      });
    }
  }

  return filters;
}

function toDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return null;
  }
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  // Avoid turning numeric-looking values (e.g. "1", "12345") into arbitrary dates.
  if (!isLikelyDateString(text)) {
    return null;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isLikelyDateString(text) {
  if (!text) {
    return false;
  }
  if (/^\d+$/.test(text)) {
    return false;
  }
  return /[-/:T ]/.test(text);
}

function getDateParts(date, timeZone) {
  if (!timeZone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds()
    };
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second)
  };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatDateWithPattern(date, pattern, timeZone) {
  const part = getDateParts(date, timeZone);
  const tokens = {
    YYYY: String(part.year),
    YY: String(part.year).slice(-2),
    MM: pad2(part.month),
    M: String(part.month),
    DD: pad2(part.day),
    D: String(part.day),
    HH: pad2(part.hour),
    H: String(part.hour),
    mm: pad2(part.minute),
    m: String(part.minute),
    ss: pad2(part.second),
    s: String(part.second)
  };

  return String(pattern).replace(/YYYY|YY|MM|M|DD|D|HH|H|mm|m|ss|s/g, (token) => tokens[token]);
}

function resolveDateTimeOptions(column) {
  if (column.dateFormat && typeof column.dateFormat === "object") {
    return column.dateFormat;
  }

  const format = String(column.format || "").toLowerCase();
  if (format === "date") {
    return { year: "numeric", month: "2-digit", day: "2-digit" };
  }
  if (format === "time") {
    return { hour: "2-digit", minute: "2-digit", second: "2-digit" };
  }
  if (format === "datetime") {
    return {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    };
  }
  return null;
}

function isDateLikeColumn(column) {
  const format = String(column.format || "").toLowerCase();
  if (format === "date" || format === "time" || format === "datetime") {
    return true;
  }

  const columnName = String(column.name || "");
  return /(date|time)/i.test(columnName);
}

function resolveDateFormatPattern(column) {
  if (typeof column.dateFormat === "string" && column.dateFormat.trim()) {
    return column.dateFormat.trim();
  }
  if (typeof column.formatString === "string" && column.formatString.trim()) {
    return column.formatString.trim();
  }
  if (
    isDateLikeColumn(column) &&
    typeof appConfig?.ui?.dateFormat === "string" &&
    appConfig.ui.dateFormat.trim()
  ) {
    return appConfig.ui.dateFormat.trim();
  }
  return null;
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePrecision(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const rounded = Math.round(numeric);
  return Math.min(20, Math.max(0, rounded));
}

function coerceNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const normalized = value.replaceAll(",", "").trim();
    if (!normalized) {
      return null;
    }
    const numeric = Number(normalized);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
}

function resolveNumberFormatOptions(column) {
  const numberConfig = column.numberFormat && typeof column.numberFormat === "object" ? column.numberFormat : {};
  const format = String(column.format || "").toLowerCase();
  const hasNumberConfig =
    format === "number" ||
    column.precision !== undefined ||
    column.thousandSeparator !== undefined ||
    column.thousandsSeparator !== undefined ||
    column.decimalSeparator !== undefined ||
    numberConfig.precision !== undefined ||
    numberConfig.thousandSeparator !== undefined ||
    numberConfig.thousandsSeparator !== undefined ||
    numberConfig.decimalSeparator !== undefined ||
    numberConfig.useGrouping !== undefined;

  if (!hasNumberConfig) {
    return null;
  }

  const precision = parsePrecision(
    numberConfig.precision !== undefined ? numberConfig.precision : column.precision
  );
  const useGroupingCandidate =
    numberConfig.useGrouping !== undefined
      ? numberConfig.useGrouping
      : column.useGrouping !== undefined
        ? column.useGrouping
        : column.thousandSeparator !== undefined || column.thousandsSeparator !== undefined
          ? true
          : format === "number";

  const useGrouping = Boolean(useGroupingCandidate);
  const thousandSeparator =
    numberConfig.thousandSeparator ?? numberConfig.thousandsSeparator ?? column.thousandSeparator ?? column.thousandsSeparator;
  const decimalSeparator = numberConfig.decimalSeparator ?? column.decimalSeparator;

  return {
    locale: column.locale || undefined,
    precision,
    useGrouping,
    thousandSeparator: typeof thousandSeparator === "string" && thousandSeparator ? thousandSeparator : null,
    decimalSeparator: typeof decimalSeparator === "string" && decimalSeparator ? decimalSeparator : null
  };
}

function applyCustomSeparators(text, formatter, options) {
  const parts = formatter.formatToParts(12345.6);
  const groupPart = parts.find((part) => part.type === "group");
  const decimalPart = parts.find((part) => part.type === "decimal");

  let output = text;
  if (options.thousandSeparator && groupPart?.value) {
    output = output.replace(new RegExp(escapeRegex(groupPart.value), "g"), options.thousandSeparator);
  }
  if (options.decimalSeparator && decimalPart?.value) {
    output = output.replace(new RegExp(escapeRegex(decimalPart.value), "g"), options.decimalSeparator);
  }
  return output;
}

function formatNumberValue(value, options) {
  const numeric = coerceNumber(value);
  if (numeric === null) {
    return String(value);
  }

  const intlOptions = {
    useGrouping: options.useGrouping
  };
  if (options.precision !== null) {
    intlOptions.minimumFractionDigits = options.precision;
    intlOptions.maximumFractionDigits = options.precision;
  }

  const formatter = new Intl.NumberFormat(options.locale, intlOptions);
  const formatted = formatter.format(numeric);
  return applyCustomSeparators(formatted, formatter, options);
}

function formatCellValue(value, column) {
  if (value === null || value === undefined) {
    return "";
  }

  const numberOptions = resolveNumberFormatOptions(column);
  if (numberOptions) {
    return formatNumberValue(value, numberOptions);
  }

  const datePattern = resolveDateFormatPattern(column);
  const dateOptions = resolveDateTimeOptions(column);
  if (!dateOptions && !datePattern) {
    return String(value);
  }

  const date = toDate(value);
  if (!date) {
    return String(value);
  }

  if (datePattern) {
    return formatDateWithPattern(date, datePattern, column.timeZone || undefined);
  }

  const locale = column.locale || undefined;
  const timeZone = column.timeZone || undefined;
  return new Intl.DateTimeFormat(locale, { ...dateOptions, timeZone }).format(date);
}

function getGridColumns(view) {
  return (view.columns || []).filter((column) => !column.hideOnGrid);
}

function normalizeColumnAlign(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "right" || normalized === "center" || normalized === "left") {
    return normalized;
  }
  return "left";
}

function renderSearchFieldControl(field) {
  const column = field.column;
  const label = escapeHtml(field.label || column || "");
  if (!column) {
    return "";
  }

  const fieldType = getSearchFieldType(field);

  if (fieldType === "select") {
    const options = (field.options || [])
      .map((option) => {
        if (typeof option === "string") {
          return { value: option, label: option };
        }
        return {
          value: option?.value ?? "",
          label: option?.label ?? option?.value ?? ""
        };
      })
      .filter((option) => String(option.value).trim() !== "")
      .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
      .join("");

    return `<label>${label}<select name="s_${escapeHtml(column)}"><option value="">Any</option>${options}</select></label>`;
  }

  if (fieldType === "multiSelect") {
    const options = (field.options || [])
      .map((option) => {
        if (typeof option === "string") {
          return { value: option, label: option };
        }
        return {
          value: option?.value ?? "",
          label: option?.label ?? option?.value ?? ""
        };
      })
      .filter((option) => String(option.value).trim() !== "")
      .map(
        (option) =>
          `<label class="check-option"><input type="checkbox" name="s_${escapeHtml(
            column
          )}" value="${escapeHtml(option.value)}" /> ${escapeHtml(option.label)}</label>`
      )
      .join("");

    return `<label>${label}
      <details class="multi-select">
        <summary>${escapeHtml(field.placeholder || "Select one or more")}</summary>
        <div class="multi-options">${options}</div>
      </details>
    </label>`;
  }

  if (fieldType === "date") {
    return `<label>${label}<input type="date" name="s_${escapeHtml(column)}" /></label>`;
  }

  if (fieldType === "dateRange") {
    return `<label>${label} From<input type="date" name="s_${escapeHtml(column)}_from" /></label>
    <label>${label} To<input type="date" name="s_${escapeHtml(column)}_to" /></label>`;
  }

  return `<label>${label}<input type="text" name="s_${escapeHtml(column)}" placeholder="${escapeHtml(field.placeholder || "")}" /></label>`;
}

function renderHiddenQueryInputs(query, excludedPrefixes = [], excludedKeys = []) {
  return Object.entries(query || {})
    .filter(([key]) => {
      if (excludedKeys.includes(key)) {
        return false;
      }
      return !excludedPrefixes.some((prefix) => key.startsWith(prefix));
    })
    .flatMap(([key, value]) => asArray(value).map((item) => ({ key, value: item })))
    .map(
      (entry) =>
        `<input type="hidden" name="${escapeHtml(entry.key)}" value="${escapeHtml(entry.value === undefined || entry.value === null ? "" : String(entry.value))}" />`
    )
    .join("");
}

function resolveUiFontFamily(value) {
  const fallback = '"Segoe UI", Tahoma, sans-serif';
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  if (/[^a-zA-Z0-9 ,"'_\-]/.test(trimmed)) {
    return fallback;
  }
  return trimmed;
}

function resolveUiFontSize(value) {
  const fallback = 14;
  const min = 10;
  const max = 24;

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(max, Math.max(min, Math.round(value)));
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    const match = normalized.match(/^(\d+(?:\.\d+)?)(px)?$/);
    if (match) {
      const numeric = Number(match[1]);
      if (Number.isFinite(numeric)) {
        return Math.min(max, Math.max(min, Math.round(numeric)));
      }
    }
  }
  return fallback;
}

function renderLayout(title, content) {
  const banner = appConfig.ui?.banner || {};
  const bannerTitle = banner.title || "Configurable Data Viewer";
  const bannerSubtitle = banner.subtitle || "SQL Server and DuckDB table explorer";
  const fontFamily = resolveUiFontFamily(appConfig.ui?.fontFamily);
  const baseFontSizePx = resolveUiFontSize(appConfig.ui?.fontSize);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        --bg: #f5f7fb;
        --panel: #ffffff;
        --text: #1f2a44;
        --border: #dbe2ef;
        --accent: #0f6fff;
        --font-family: ${fontFamily};
        --font-size-base: ${baseFontSizePx}px;
        --font-size-xs: calc(var(--font-size-base) * 0.86);
        --font-size-sm: calc(var(--font-size-base) * 0.93);
        --font-size-lg: calc(var(--font-size-base) * 1.14);
        --font-size-xl: calc(var(--font-size-base) * 1.43);
      }
      body {
        margin: 0;
        padding: 0;
        font-family: var(--font-family);
        font-size: var(--font-size-base);
        background: linear-gradient(180deg, #eef3ff 0%, var(--bg) 30%);
        color: var(--text);
      }
      .site-banner {
        background: linear-gradient(120deg, #0f6fff 0%, #0a4fbc 100%);
        color: #fff;
        padding: 16px 24px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.2);
        position: sticky;
        top: 0;
        z-index: 1200;
      }
      .site-banner-title {
        font-size: var(--font-size-xl);
        font-weight: 600;
      }
      .site-banner-subtitle {
        margin-top: 4px;
        font-size: var(--font-size-sm);
        opacity: 0.92;
      }
      .container {
        max-width: none;
        width: calc(100% - 32px);
        margin: 16px;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 20px;
        box-sizing: border-box;
      }
      h1 {
        margin-top: 0;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        border-bottom: 1px solid var(--border);
        text-align: left;
        padding: 8px;
        font-size: var(--font-size-base);
      }
      th {
        background: #f0f4fc;
        position: relative;
      }
      a {
        color: var(--accent);
        text-decoration: none;
      }
      .muted {
        color: #60708f;
        font-size: var(--font-size-sm);
      }
      .toolbar {
        display: flex;
        gap: 12px;
        margin: 8px 0 16px;
        flex-wrap: wrap;
      }
      .toolbar.secondary {
        margin-top: 0;
      }
      .pager {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 0 0 10px;
        font-size: var(--font-size-sm);
        flex-wrap: wrap;
      }
      .pager form {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin: 0;
      }
      .pager input[type="number"] {
        width: 88px;
        padding: 4px 6px;
      }
      .th-wrap {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        position: relative;
      }
      .col-filter-toggle {
        border: 1px solid var(--border);
        background: #fff;
        color: #4f6387;
        border-radius: 999px;
        width: 20px;
        height: 20px;
        padding: 0;
        line-height: 1;
        font-size: 12px;
      }
      .col-filter-toggle svg {
        width: 11px;
        height: 11px;
        display: block;
        margin: 0 auto;
        fill: currentColor;
      }
      .col-filter-toggle.active {
        border-color: var(--accent);
        color: #fff;
        background: var(--accent);
      }
      .col-filter-popover {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        min-width: 240px;
        max-width: 280px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: #fff;
        box-shadow: 0 10px 20px rgba(31, 42, 68, 0.18);
        padding: 8px;
        z-index: 40;
      }
      .col-filter-popover[hidden] {
        display: none;
      }
      .col-filter-popover form {
        display: grid;
        gap: 8px;
      }
      .col-filter-popover label {
        display: grid;
        gap: 4px;
        font-size: var(--font-size-xs);
      }
      .col-filter-popover input[type="text"] {
        padding: 6px;
      }
      .col-filter-popover-actions {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .col-filter-popover-actions a {
        font-size: var(--font-size-sm);
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .chip {
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 4px 10px;
        font-size: var(--font-size-xs);
      }
      .breadcrumbs {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin: 0 0 10px;
        font-size: var(--font-size-sm);
      }
      .crumb-sep {
        color: #60708f;
      }
      .view-list {
        list-style: none;
        padding: 0;
        margin: 0;
      }
      .view-list li {
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 12px;
        margin-bottom: 12px;
        background: #fafcff;
      }
      .view-title {
        margin-bottom: 8px;
      }
      .view-actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        font-size: var(--font-size-sm);
      }
      .badge {
        display: inline-block;
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 2px 8px;
        font-size: var(--font-size-xs);
        background: #fff;
        color: #4f6387;
      }
      .search-form {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 10px;
        align-items: end;
      }
      .search-form > label {
        display: grid;
        gap: 4px;
        font-size: var(--font-size-sm);
        position: relative;
        overflow: visible;
      }
      .multi-select {
        border: 1px solid var(--border);
        border-radius: 6px;
        background: #fff;
        padding: 6px 8px;
        position: relative;
      }
      .multi-select summary {
        cursor: pointer;
        font-size: var(--font-size-sm);
        color: #3a4b6b;
      }
      .multi-options {
        display: grid;
        gap: 6px;
        max-height: 220px;
        overflow: auto;
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        right: 0;
        z-index: 30;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: #fff;
        box-shadow: 0 8px 20px rgba(31, 42, 68, 0.16);
        padding: 8px;
      }
      .check-option {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: var(--font-size-sm);
      }
      .search-submit {
        width: 120px;
        min-width: 120px;
        justify-self: start;
      }
      input[type="text"], input[type="date"], select {
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 8px;
        font: inherit;
        color: inherit;
        background: #fff;
        box-sizing: border-box;
        width: 100%;
      }
      button {
        border: 1px solid var(--accent);
        background: var(--accent);
        color: #fff;
        border-radius: 6px;
        padding: 8px 12px;
        font: inherit;
        cursor: pointer;
      }
      .table-page {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 340px;
        gap: 16px;
        align-items: start;
      }
      .table-grid {
        min-width: 0;
      }
      .table-main {
        min-width: 0;
        overflow-x: auto;
        overflow-y: visible;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
        margin-top: 8px;
      }
      .table-main::-webkit-scrollbar {
        height: 0;
      }
      .table-main table {
        width: max-content;
        min-width: 100%;
        table-layout: auto;
      }
      .table-scrollbar {
        margin: 8px 0 0;
        overflow-x: auto;
        overflow-y: hidden;
        height: 14px;
        position: sticky;
        bottom: 8px;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 999px;
        z-index: 5;
      }
      .table-scrollbar-inner {
        height: 1px;
      }
      .sidebar {
        border: 1px solid var(--border);
        border-radius: 10px;
        background: #fafcff;
        padding: 12px;
        position: sticky;
        top: 12px;
        max-height: calc(100vh - 24px);
        overflow: auto;
      }
      .sidebar h2 {
        margin: 0 0 8px;
        font-size: var(--font-size-lg);
      }
      .tabs {
        display: flex;
        gap: 8px;
        margin-bottom: 10px;
        justify-content: flex-start;
      }
      .tab-button {
        border: 1px solid var(--border);
        background: #fff;
        color: var(--text);
        padding: 6px 10px;
        border-radius: 999px;
        font-size: var(--font-size-xs);
      }
      .tab-button.active {
        border-color: var(--accent);
        background: #eaf2ff;
        color: #0a4fbc;
      }
      .tab-panel {
        display: none;
      }
      .tab-panel.active {
        display: block;
      }
      .row-links {
        margin: 0;
        padding-left: 18px;
        display: grid;
        gap: 6px;
      }
      tr.data-row {
        cursor: pointer;
      }
      tr.data-row:hover {
        background: #f7faff;
      }
      tr.data-row.selected-row {
        background: #e9f1ff;
      }
      .details-grid {
        margin: 0;
        display: grid;
        gap: 8px;
      }
      .details-grid dt {
        font-size: var(--font-size-xs);
        color: #60708f;
      }
      .details-grid dd {
        margin: 2px 0 0;
        font-size: var(--font-size-base);
      }
      .config-layout {
        display: grid;
        gap: 16px;
      }
      .config-panel {
        border: 1px solid var(--border);
        border-radius: 10px;
        background: #fafcff;
        padding: 16px;
      }
      .config-panel h2 {
        margin: 0 0 12px;
        font-size: var(--font-size-lg);
      }
      .config-columns {
        display: grid;
        gap: 10px;
      }
      .config-column-row {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 10px;
        align-items: start;
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: #fff;
      }
      .config-column-row input[type="checkbox"] {
        margin-top: 2px;
      }
      .config-column-meta {
        display: grid;
        gap: 4px;
      }
      .config-column-title {
        font-weight: 600;
      }
      .config-order-controls {
        display: inline-flex;
        gap: 6px;
        align-items: center;
      }
      .config-order-button {
        border: 1px solid var(--border);
        background: #fff;
        color: var(--text);
        min-width: 34px;
        padding: 6px 8px;
      }
      .config-order-button[disabled] {
        opacity: 0.45;
        cursor: default;
      }
      .config-actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
        margin-top: 16px;
      }
      .notice {
        border: 1px solid #b7d6ff;
        background: #edf5ff;
        color: #0a4fbc;
        border-radius: 8px;
        padding: 10px 12px;
        margin-bottom: 16px;
      }
      .error-notice {
        border-color: #f3b8b8;
        background: #fff2f2;
        color: #b42318;
      }
      .config-summary {
        display: grid;
        gap: 8px;
        font-size: var(--font-size-sm);
      }
      .config-summary code {
        font-size: inherit;
      }
      .settings-grid {
        display: grid;
        gap: 16px;
      }
      .settings-card {
        border: 1px solid var(--border);
        border-radius: 10px;
        background: #fafcff;
        padding: 16px;
      }
      .settings-card h2 {
        margin: 0 0 12px;
        font-size: var(--font-size-lg);
      }
      .form-grid {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      .form-grid label {
        display: grid;
        gap: 4px;
        font-size: var(--font-size-sm);
      }
      .form-grid input[type="text"],
      .form-grid input[type="password"],
      .form-grid input[type="number"],
      .form-grid select {
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 8px;
        font: inherit;
        color: inherit;
        background: #fff;
        box-sizing: border-box;
        width: 100%;
      }
      .settings-actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
        margin-top: 14px;
      }
      .inline-checks {
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
        align-items: center;
      }
      .inline-checks label {
        display: inline-flex;
        gap: 6px;
        align-items: center;
      }
      .database-card {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: #fff;
        padding: 14px;
      }
      .database-card + .database-card {
        margin-top: 12px;
      }
      .database-card-title {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        align-items: center;
        margin-bottom: 10px;
      }
      @media (max-width: 900px) {
        .table-page {
          grid-template-columns: 1fr;
        }
        .sidebar {
          position: static;
          max-height: none;
        }
      }
    </style>
  </head>
  <body>
    <header class="site-banner">
      <div class="site-banner-title">${escapeHtml(bannerTitle)}</div>
      <div class="site-banner-subtitle">${escapeHtml(bannerSubtitle)}</div>
    </header>
    <div class="container">
      ${content}
    </div>
  </body>
</html>`;
}

function renderHome() {
  const viewItems = Object.entries(viewsConfig.views)
    .filter(([, view]) => !view.hideOnHome)
    .map(([viewName, view]) => {
      const connection = getViewDatabaseConnection(view);
      const dbType = connection.type;
      const tableLabel = view.schema && dbType !== "duckdb" ? `${view.schema}.${view.table}` : view.table;
      const searchFields = (view.searchFields || [])
        .map((field) => renderSearchFieldControl(field))
        .join("");
      const searchForm = searchFields
        ? `<form method="get" action="/table/${encodeURIComponent(viewName)}" class="search-form">${searchFields}<button type="submit" class="search-submit">Search</button></form>`
        : `<p class="muted">No search fields configured.</p>`;

      return `<li>
        <div class="view-title"><a href="/table/${encodeURIComponent(viewName)}">${escapeHtml(view.title || viewName)}</a> <span class="muted">(${escapeHtml(tableLabel)})</span></div>
        <div class="view-actions"><span class="badge">${escapeHtml(connection.name)}</span></div>
        <div class="view-actions">
          <a href="/table/${encodeURIComponent(viewName)}">Open table</a>
          <a href="/config/${encodeURIComponent(viewName)}">Edit view config</a>
        </div>
        ${searchForm}
      </li>`;
    })
    .join("\n");

  return renderLayout(
    "Search",
    `<h1>Search</h1>
     <div class="toolbar secondary"><a href="/settings">Settings</a></div>
     <ul class="view-list">${viewItems}</ul>`
  );
}

function renderViewConfig(viewName, view, options = {}) {
  const connection = getViewDatabaseConnection(view);
  const tableLabel = view.schema && connection.type !== "duckdb" ? `${view.schema}.${view.table}` : view.table;
  const saveError = String(options.error || "").trim();
  const saveMessage = String(options.message || "").trim();
  const selectedColumns = new Set(
    (options.selectedColumns || getGridColumns(view).map((column) => column.name))
      .map((column) => String(column || "").trim())
      .filter(Boolean)
  );
  const visibleCount = (view.columns || []).filter((column) => selectedColumns.has(column.name)).length;
  const hiddenCount = Math.max(0, (view.columns || []).length - visibleCount);
  const noticeHtml = saveError
    ? `<div class="notice error-notice">${escapeHtml(saveError)}</div>`
    : saveMessage
      ? `<div class="notice">${escapeHtml(saveMessage)}</div>`
      : "";
  const columnItems = (view.columns || [])
    .map((column, index) => {
      const checked = selectedColumns.has(column.name) ? " checked" : "";
      const label = column.label || column.name;
      const meta = [];
      meta.push(`Column: <code>${escapeHtml(column.name)}</code>`);
      if (column.align) {
        meta.push(`Align: <code>${escapeHtml(column.align)}</code>`);
      }
      if (column.format) {
        meta.push(`Format: <code>${escapeHtml(column.format)}</code>`);
      }
      return `<div class="config-column-row" data-column-name="${escapeHtml(column.name)}">
        <input type="hidden" name="columnOrder" value="${escapeHtml(column.name)}" />
        <input type="checkbox" name="visibleColumns" value="${escapeHtml(column.name)}"${checked} />
        <span class="config-column-meta">
          <span class="config-column-title">${escapeHtml(label)}</span>
          <span class="muted">${meta.join(" | ")}</span>
          <span class="muted">Order: ${index + 1} in configured column list</span>
        </span>
        <span class="config-order-controls">
          <button type="button" class="config-order-button" data-move="up" aria-label="Move ${escapeHtml(label)} up">Up</button>
          <button type="button" class="config-order-button" data-move="down" aria-label="Move ${escapeHtml(label)} down">Down</button>
        </span>
      </div>`;
    })
    .join("");

  return renderLayout(
    `${view.title || viewName} Config`,
    `<h1>${escapeHtml(view.title || viewName)} Config</h1>
     <div class="toolbar secondary">
       <a href="/">All views</a>
       <a href="/table/${encodeURIComponent(viewName)}">Back to table</a>
       <a href="/settings">Settings</a>
      </div>
     ${noticeHtml}
     <div class="config-layout">
       <section class="config-panel">
         <h2>View Summary</h2>
         <div class="config-summary">
            <div>View key: <code>${escapeHtml(viewName)}</code></div>
            <div>Database: <code>${escapeHtml(connection.name)}</code> <span class="badge">${escapeHtml(connection.type)}</span></div>
            <div>Source: <code>${escapeHtml(tableLabel)}</code></div>
           <div>Configured columns: ${view.columns.length}</div>
           <div>Shown in grid: ${visibleCount}</div>
           <div>Hidden from grid: ${hiddenCount}</div>
         </div>
       </section>
       <section class="config-panel">
          <h2>Grid Columns</h2>
         <p class="muted">Select which configured columns appear in the main table. Use Up and Down to change column order. Unselected columns stay available in the row details panel and CSV export.</p>
         <form method="post" action="/config/${encodeURIComponent(viewName)}">
           <div class="config-columns" id="config-columns">${columnItems}</div>
           <div class="config-actions">
             <button type="submit">Save view config</button>
             <a href="/table/${encodeURIComponent(viewName)}">Cancel</a>
           </div>
         </form>
       </section>
     </div>
     <script>
       (() => {
         const root = document.getElementById("config-columns");
         if (!root) {
           return;
         }

         function refreshOrderUi() {
           const rows = Array.from(root.querySelectorAll(".config-column-row"));
           rows.forEach((row, index) => {
             const meta = row.querySelector(".config-column-meta .muted:last-child");
             if (meta) {
               meta.textContent = "Order: " + (index + 1) + " in configured column list";
             }
             const upButton = row.querySelector('[data-move="up"]');
             const downButton = row.querySelector('[data-move="down"]');
             if (upButton) {
               upButton.disabled = index === 0;
             }
             if (downButton) {
               downButton.disabled = index === rows.length - 1;
             }
           });
         }

         root.addEventListener("click", (event) => {
           const button = event.target.closest(".config-order-button");
           if (!button) {
             return;
           }
           const row = button.closest(".config-column-row");
           if (!row) {
             return;
           }
           if (button.dataset.move === "up") {
             const previous = row.previousElementSibling;
             if (previous) {
               root.insertBefore(row, previous);
             }
           }
           if (button.dataset.move === "down") {
             const next = row.nextElementSibling;
             if (next) {
               root.insertBefore(next, row);
             }
           }
           refreshOrderUi();
         });

         refreshOrderUi();
       })();
     </script>`
  );
}

function renderSettings(options = {}) {
  const noticeMessage = String(options.message || "").trim();
  const noticeError = String(options.error || "").trim();
  const catalog = getDatabaseCatalog();
  const connectionOptions = Object.entries(catalog.connections);
  const selectedScanConnection =
    normalizeDatabaseName(options.scanConnectionName) || options.lastSavedConnectionName || catalog.defaultConnection;
  const noticeHtml = noticeError
    ? `<div class="notice error-notice">${escapeHtml(noticeError)}</div>`
    : noticeMessage
      ? `<div class="notice">${escapeHtml(noticeMessage)}</div>`
      : "";

  const connectionCards = connectionOptions
    .map(([name, connection]) => {
      const type = String(connection.type || "sqlserver").toLowerCase();
      const isDefault = name === catalog.defaultConnection;
      const sqlServerConfig = connection.sqlserver || {};
      const sqlServerOptions = sqlServerConfig.options || {};
      const duckdbConfig = connection.duckdb || {};
      return `<div class="database-card">
        <div class="database-card-title">
          <strong>${escapeHtml(name)}</strong>
          <span class="badge">${escapeHtml(type)}</span>
          ${isDefault ? '<span class="badge">default</span>' : ""}
        </div>
        <form method="post" action="/settings/database/save" data-database-form>
          <input type="hidden" name="originalName" value="${escapeHtml(name)}" />
          <div class="form-grid">
            <label>Name
              <input type="text" name="name" value="${escapeHtml(name)}" required />
            </label>
            <label>Type
              <select name="type" data-database-type>
                <option value="sqlserver"${type === "sqlserver" ? " selected" : ""}>SQL Server</option>
                <option value="duckdb"${type === "duckdb" ? " selected" : ""}>DuckDB</option>
              </select>
            </label>
            <label data-sqlserver-field>Server
              <input type="text" name="server" value="${escapeHtml(sqlServerConfig.server || "")}" />
            </label>
            <label data-sqlserver-field>Port
              <input type="number" name="port" min="1" value="${escapeHtml(
                sqlServerConfig.port === undefined || sqlServerConfig.port === null ? "" : String(sqlServerConfig.port)
              )}" />
            </label>
            <label data-sqlserver-field>Database
              <input type="text" name="database" value="${escapeHtml(sqlServerConfig.database || "")}" />
            </label>
            <label data-sqlserver-field>User
              <input type="text" name="user" value="${escapeHtml(sqlServerConfig.user || "")}" />
            </label>
            <label data-sqlserver-field>Password
              <input type="password" name="password" value="${escapeHtml(sqlServerConfig.password || "")}" />
            </label>
            <label data-duckdb-field>DuckDB Path
              <input type="text" name="path" value="${escapeHtml(duckdbConfig.path || "")}" />
            </label>
          </div>
          <div class="settings-actions">
            <span class="inline-checks" data-sqlserver-field>
              <label><input type="checkbox" name="encrypt"${sqlServerOptions.encrypt ? " checked" : ""} /> Encrypt</label>
              <label><input type="checkbox" name="trustServerCertificate"${
                sqlServerOptions.trustServerCertificate ? " checked" : ""
              } /> Trust server certificate</label>
            </span>
            <label><input type="checkbox" name="setDefault"${isDefault ? " checked" : ""} /> Default connection</label>
          </div>
          <div class="settings-actions">
            <button type="submit">Save connection</button>
          </div>
        </form>
        ${
          connectionOptions.length > 1
            ? `<form method="post" action="/settings/database/delete" onsubmit="return confirm('Delete connection ${escapeHtml(
                name
              )}?');">
                <input type="hidden" name="name" value="${escapeHtml(name)}" />
                <div class="settings-actions">
                  <button type="submit">Delete connection</button>
                </div>
              </form>`
            : ""
        }
      </div>`;
    })
    .join("");

  const scanOptionsHtml = connectionOptions
    .map(
      ([name, connection]) =>
        `<option value="${escapeHtml(name)}"${
          name === selectedScanConnection ? " selected" : ""
        }>${escapeHtml(name)} (${escapeHtml(connection.type || "sqlserver")})</option>`
    )
    .join("");

  return renderLayout(
    "Settings",
    `<h1>Settings</h1>
     <div class="toolbar secondary">
       <a href="/">All views</a>
     </div>
     ${noticeHtml}
     <div class="settings-grid">
       <section class="settings-card">
         <h2>Database Connections</h2>
         <p class="muted">Views can point at a named database connection. The default connection is used when a view does not specify one.</p>
         ${connectionCards}
       </section>
       <section class="settings-card">
         <h2>Add Database</h2>
         <form method="post" action="/settings/database/save" data-database-form>
           <div class="form-grid">
             <label>Name
               <input type="text" name="name" value="" required />
             </label>
             <label>Type
               <select name="type" data-database-type>
                 <option value="sqlserver">SQL Server</option>
                 <option value="duckdb">DuckDB</option>
               </select>
             </label>
             <label data-sqlserver-field>Server
               <input type="text" name="server" value="" />
             </label>
             <label data-sqlserver-field>Port
               <input type="number" name="port" min="1" value="1433" />
             </label>
             <label data-sqlserver-field>Database
               <input type="text" name="database" value="" />
             </label>
             <label data-sqlserver-field>User
               <input type="text" name="user" value="" />
             </label>
             <label data-sqlserver-field>Password
               <input type="password" name="password" value="" />
             </label>
             <label data-duckdb-field>DuckDB Path
               <input type="text" name="path" value="" />
             </label>
           </div>
           <div class="settings-actions">
             <span class="inline-checks" data-sqlserver-field>
               <label><input type="checkbox" name="encrypt" checked /> Encrypt</label>
               <label><input type="checkbox" name="trustServerCertificate" checked /> Trust server certificate</label>
             </span>
             <label><input type="checkbox" name="setDefault" /> Default connection</label>
           </div>
           <div class="settings-actions">
             <button type="submit">Add connection</button>
           </div>
         </form>
       </section>
       <section class="settings-card">
         <h2>Scan Database Into Views Config</h2>
         <p class="muted">This reads live table metadata from the selected database and replaces the current <code>config/views.config.json</code>.</p>
         <form method="post" action="/settings/scan">
           <div class="form-grid">
             <label>Connection
               <select name="connectionName">${scanOptionsHtml}</select>
             </label>
             <label>Default row limit
               <input type="number" name="limit" min="1" value="${escapeHtml(String(options.limit || 200))}" />
             </label>
             <label>Max search fields
               <input type="number" name="maxSearchFields" min="1" value="${escapeHtml(
                 String(options.maxSearchFields || 3)
               )}" />
             </label>
           </div>
           <div class="settings-actions">
             <button type="submit">Scan and rebuild views config</button>
           </div>
         </form>
       </section>
     </div>
     <script>
       (() => {
         const forms = Array.from(document.querySelectorAll("[data-database-form]"));
         function syncForm(form) {
           const typeSelect = form.querySelector("[data-database-type]");
           const currentType = typeSelect ? String(typeSelect.value || "sqlserver").toLowerCase() : "sqlserver";
           form.querySelectorAll("[data-sqlserver-field]").forEach((field) => {
             field.style.display = currentType === "sqlserver" ? "" : "none";
           });
           form.querySelectorAll("[data-duckdb-field]").forEach((field) => {
             field.style.display = currentType === "duckdb" ? "" : "none";
           });
         }
         forms.forEach((form) => {
           syncForm(form);
           const typeSelect = form.querySelector("[data-database-type]");
           if (typeSelect) {
             typeSelect.addEventListener("change", () => syncForm(form));
           }
         });
       })();
     </script>`
  );
}

function renderTable(viewName, view, rows, context) {
  const gridColumns = getGridColumns(view);
  const currentQuery = context.currentQuery || {};
  const currentPage = parsePositiveInt(context.page, 1);
  const totalPages = parsePositiveInt(context.totalPages, 1);
  const hasPrevPage = currentPage > 1;
  const hasNextPage = Boolean(context.hasNext);
  const headers = gridColumns
    .map((column) => {
      const align = normalizeColumnAlign(column.align);
      const label = column.label || column.name;
      const paramName = `cf_${column.name}`;
      const filterValue = firstQueryValue(currentQuery[paramName]);
      const hasFilterValue = filterValue !== undefined && filterValue !== null && String(filterValue).trim() !== "";
      const filterId = `filter_${String(column.name).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      const clearParams = new URLSearchParams();
      for (const [key, value] of Object.entries(currentQuery || {})) {
        if (key === "page" || key === paramName) {
          continue;
        }
        for (const item of asArray(value)) {
          if (item === undefined || item === null) {
            continue;
          }
          clearParams.append(key, String(item));
        }
      }
      const clearQuery = clearParams.toString();
      const clearUrl = clearQuery
        ? `/table/${encodeURIComponent(viewName)}?${clearQuery}`
        : `/table/${encodeURIComponent(viewName)}`;
      return `<th style="text-align:${align}">
        <div class="th-wrap">
          <span>${escapeHtml(label)}</span>
          <button type="button" class="col-filter-toggle${hasFilterValue ? " active" : ""}" data-filter-target="${escapeHtml(
            filterId
          )}" aria-expanded="false" aria-label="Filter ${escapeHtml(label)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5h13L10 8.6v3.2l-4 2V8.6z"/></svg></button>
          <div class="col-filter-popover" id="${escapeHtml(filterId)}" hidden>
            <form method="get" action="/table/${encodeURIComponent(viewName)}">
              ${renderHiddenQueryInputs(currentQuery, [], ["page", paramName])}
              <label>${escapeHtml(label)} contains
                <input type="text" name="${escapeHtml(paramName)}" value="${escapeHtml(
                  hasFilterValue ? String(filterValue) : ""
                )}" />
              </label>
              <div class="col-filter-popover-actions">
                <button type="submit">Apply</button>
                ${hasFilterValue ? `<a href="${escapeHtml(clearUrl)}">Clear</a>` : ""}
              </div>
            </form>
          </div>
        </div>
      </th>`;
    })
    .join("");
  const nextBreadcrumbsToken = context.nextBreadcrumbsToken || "";
  const linkLocalColumns = Array.from(collectLinkLocalColumns(view));

  const relatedHeader = Array.isArray(view.links) && view.links.length ? "<th>Related</th>" : "";

  const makePageUrl = (targetPage) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(currentQuery || {})) {
      if (key === "page") {
        continue;
      }
      for (const item of asArray(value)) {
        if (item === undefined || item === null) {
          continue;
        }
        params.append(key, String(item));
      }
    }
    if (targetPage > 1) {
      params.set("page", String(targetPage));
    }
    const queryString = params.toString();
    return queryString ? `/table/${encodeURIComponent(viewName)}?${queryString}` : `/table/${encodeURIComponent(viewName)}`;
  };
  const pager = `<div class="pager">
    ${hasPrevPage ? `<a href="${makePageUrl(1)}">First</a>` : `<span class="muted">First</span>`}
    ${hasPrevPage ? `<a href="${makePageUrl(currentPage - 1)}">Previous</a>` : `<span class="muted">Previous</span>`}
    <span>Page ${currentPage} of ${totalPages}</span>
    ${hasNextPage ? `<a href="${makePageUrl(currentPage + 1)}">Next</a>` : `<span class="muted">Next</span>`}
    ${hasNextPage ? `<a href="${makePageUrl(totalPages)}">Last</a>` : `<span class="muted">Last</span>`}
    <form method="get" action="/table/${encodeURIComponent(viewName)}">
      ${renderHiddenQueryInputs(currentQuery, [], ["page"])}
      <label>Go to page <input type="number" name="page" min="1" max="${totalPages}" value="${currentPage}" /></label>
      <button type="submit">Go</button>
    </form>
  </div>`;

  const rowDetails = [];
  const rowRawDetails = [];

  const body = rows
    .map((row, index) => {
      const rowKeyIndex = buildRowKeyIndex(row);
      const detail = {};
      const cells = gridColumns
        .map((column) => {
          const value = formatCellValue(getRowValue(row, column.name, rowKeyIndex), column);
          const align = normalizeColumnAlign(column.align);
          return `<td style="text-align:${align}">${escapeHtml(value)}</td>`;
        })
        .join("");
      for (const column of view.columns) {
        detail[column.name] = formatCellValue(getRowValue(row, column.name, rowKeyIndex), column);
      }
      rowDetails.push(detail);
      const rawDetail = {};
      for (const column of view.columns) {
        rawDetail[column.name] = getRowValue(row, column.name, rowKeyIndex);
      }
      for (const localColumn of linkLocalColumns) {
        rawDetail[localColumn] = getRowValue(row, localColumn, rowKeyIndex);
      }
      rowRawDetails.push(rawDetail);

      const related =
        Array.isArray(view.links) && view.links.length
          ? `<td>${view.links
              .map((link) => {
                const url = buildLinkUrl(link, row, nextBreadcrumbsToken);
                if (!url) {
                  return "";
                }
                const defaultLabel = link.targetView || link.urlTemplate || "Link";
                const label = renderLinkLabel(link.label || defaultLabel, row);
                return renderLinkAnchor(link, label, url);
              })
              .filter(Boolean)
              .join(" | ")}</td>`
          : "";

      return `<tr class="data-row" data-row-index="${index}">${cells}${related}</tr>`;
    })
    .join("\n");

  const chips = [
    `Rows: ${rows.length}`,
    `Sort: ${(context.sorts || [{ column: context.sortColumn, direction: context.direction }])
      .map((item) => `${item.column} ${item.direction}`)
      .join(", ")}`,
    context.filters.length
      ? `Filters: ${context.filters
          .map((item) => {
            const symbol =
              item.operator === "in"
                ? "in"
                : item.operator === "exact"
                ? "="
                : item.operator === "gte"
                  ? ">="
                  : item.operator === "lte"
                    ? "<="
                    : item.operator === "gt"
                      ? ">"
                      : item.operator === "lt"
                        ? "<"
                        : "~";
            const valueDisplay = item.operator === "in" ? (item.values || []).join(", ") : item.value;
            return `${item.label} ${symbol} ${valueDisplay}`;
          })
          .join(", ")}`
      : "Filters: none"
  ]
    .map((item) => `<span class="chip">${escapeHtml(item)}</span>`)
    .join("");

  const detailColumns = view.columns.map((column) => ({
    name: column.name,
    label: column.label || column.name,
    align: normalizeColumnAlign(column.align)
  }));
  const breadcrumbItems = [...(context.breadcrumbs || []), { label: view.title || viewName, url: null }];
  const breadcrumbsHtml = breadcrumbItems
    .map((crumb, index) => {
      const isLast = index === breadcrumbItems.length - 1;
      const crumbHtml = isLast
        ? `<span>${escapeHtml(crumb.label)}</span>`
        : `<a href="${escapeHtml(crumb.url)}">${escapeHtml(crumb.label)}</a>`;
      const separator = isLast ? "" : `<span class="crumb-sep">/</span>`;
      return `${crumbHtml}${separator}`;
    })
    .join("");
  const linkDefinitions = (view.links || [])
    .map((link) => ({
      labelTemplate: link.label || link.targetView || link.urlTemplate || "Link",
      targetView: link.targetView,
      keys: extractLinkKeyMappings(link),
      urlTemplate: String(link.urlTemplate || "").trim(),
      openInNewTab: typeof link.openInNewTab === "boolean" ? link.openInNewTab : null
    }))
    .filter((link) => (link.targetView && link.keys.length) || link.urlTemplate);
  const detailsJson = toInlineJson(rowDetails);
  const rawDetailsJson = toInlineJson(rowRawDetails);
  const detailColumnsJson = toInlineJson(detailColumns);
  const linkDefinitionsJson = toInlineJson(linkDefinitions);
  const downloadQuery = context.currentQueryString ? `?${context.currentQueryString}` : "";
  const downloadUrl = `/table/${encodeURIComponent(viewName)}/download.csv${downloadQuery}`;

  return renderLayout(
    view.title || viewName,
      `<h1>${escapeHtml(view.title || viewName)}</h1>
      <nav class="breadcrumbs">${breadcrumbsHtml}</nav>
       <div class="toolbar">
         <a href="/">All views</a>
         <a href="/settings">Settings</a>
         <a href="/config/${encodeURIComponent(viewName)}">Edit view config</a>
         <a href="${downloadUrl}">Download CSV</a>
       </div>
       ${pager}
      <div class="table-page">
       <div class="table-grid">
         <div class="chips">${chips}</div>
         <div class="table-main">
           <table>
            <thead><tr>${headers}${relatedHeader}</tr></thead>
            <tbody>${body}</tbody>
           </table>
         </div>
         <div class="table-scrollbar" id="table-scrollbar">
           <div class="table-scrollbar-inner" id="table-scrollbar-inner"></div>
         </div>
        </div>
        <aside class="sidebar">
         <h2>Row Panel</h2>
         <div class="tabs">
           <button type="button" class="tab-button active" data-tab="fields" data-order="1">Fields</button>
           <button type="button" class="tab-button" data-tab="links" data-order="2">Links</button>
         </div>
         <div class="tab-panel" id="tab-links">
           <p class="muted" id="row-links-empty">Click a row to view related links.</p>
           <ul class="row-links" id="row-links"></ul>
         </div>
         <div class="tab-panel active" id="tab-fields">
           <p class="muted" id="row-fields-empty">Click a row to view field values.</p>
           <dl class="details-grid" id="row-fields"></dl>
         </div>
       </aside>
     </div>
     <script>
       (() => {
         const rows = Array.from(document.querySelectorAll("tr.data-row"));
         const detailsByRow = ${detailsJson};
         const rawDetailsByRow = ${rawDetailsJson};
         const columns = ${detailColumnsJson};
         const linkDefinitions = ${linkDefinitionsJson};
         const nextBreadcrumbsToken = ${toInlineJson(nextBreadcrumbsToken)};
         const linksRoot = document.getElementById("row-links");
         const linksEmpty = document.getElementById("row-links-empty");
         const fieldsRoot = document.getElementById("row-fields");
         const fieldsEmpty = document.getElementById("row-fields-empty");
         const tableMain = document.querySelector(".table-main");
         const dataTable = tableMain ? tableMain.querySelector("table") : null;
         const tableScrollbar = document.getElementById("table-scrollbar");
          const tableScrollbarInner = document.getElementById("table-scrollbar-inner");
          const tabButtons = Array.from(document.querySelectorAll(".tab-button"))
            .sort((a, b) => Number(a.dataset.order || 0) - Number(b.dataset.order || 0));
          const tabPanels = Array.from(document.querySelectorAll(".tab-panel"));
          const filterToggles = Array.from(document.querySelectorAll(".col-filter-toggle"));
          const filterPopovers = Array.from(document.querySelectorAll(".col-filter-popover"));
          let selectedRow = null;
          let syncingMain = false;
          let syncingBar = false;
         function escapeText(value) {
           return String(value ?? "")
             .replaceAll("&", "&amp;")
             .replaceAll("<", "&lt;")
             .replaceAll(">", "&gt;")
             .replaceAll('"', "&quot;")
             .replaceAll("'", "&#39;");
         }

         function activateTab(tabName) {
           tabButtons.forEach((button) => {
             button.classList.toggle("active", button.dataset.tab === tabName);
           });
           tabPanels.forEach((panel) => {
             panel.classList.toggle("active", panel.id === "tab-" + tabName);
           });
         }

         function renderFields(index) {
           const detail = detailsByRow[index] || {};

           fieldsRoot.innerHTML = columns
             .map((column) => {
                const value = detail[column.name];
                const renderedValue = value === undefined || value === null || value === "" ? "-" : value;
                return '<div><dt>' + escapeText(column.label) + '</dt><dd style="text-align:' + escapeText(column.align || "left") + '">' + escapeText(renderedValue) + '</dd></div>';
              })
              .join("");
           fieldsEmpty.style.display = index === null || index === undefined || !detailsByRow[index] ? "" : "none";
         }

          function isHttpUrl(url) {
            return /^https?:\/\//i.test(String(url || "").trim());
          }

          function isSafeLinkUrl(url) {
            const value = String(url || "").trim();
            return isHttpUrl(value) || value.startsWith("/");
          }

          function renderTemplate(template, rawDetail, encodeValues) {
            return String(template ?? "").replace(/\{\{\s*([^{}]+?)\s*\}\}|\{([^{}]+?)\}/g, (match, keyA, keyB) => {
              const key = String(keyA || keyB || "").trim();
              if (!key) {
                return match;
              }
              const value = rawDetail[key];
              if (value === undefined || value === null) {
                return "";
              }
              const text = String(value);
              return encodeValues ? encodeURIComponent(text) : text;
            });
          }

          function buildLinkUrl(linkDef, rawDetail) {
            if (linkDef.urlTemplate) {
              const rendered = renderTemplate(linkDef.urlTemplate, rawDetail, true).trim();
              return isSafeLinkUrl(rendered) ? rendered : null;
            }
            const params = [];
            for (const key of linkDef.keys) {
              const value = rawDetail[key.localColumn];
             if (value === undefined || value === null || value === "") {
               return null;
             }
             params.push("f_" + encodeURIComponent(key.targetColumn) + "=" + encodeURIComponent(String(value)));
           }
           if (nextBreadcrumbsToken) {
             params.push("crumbs=" + encodeURIComponent(nextBreadcrumbsToken));
           }
           if (!params.length) {
             return null;
            }
            return "/table/" + encodeURIComponent(linkDef.targetView) + "?" + params.join("&");
          }

          function shouldOpenInNewTab(linkDef, url) {
            if (typeof linkDef.openInNewTab === "boolean") {
              return linkDef.openInNewTab;
            }
            return isHttpUrl(url);
          }

          function renderLinkLabel(labelTemplate, rawDetail) {
            return renderTemplate(labelTemplate, rawDetail, false);
          }

          function renderLinks(index) {
            const rawDetail = rawDetailsByRow[index];
            if (!rawDetail) {
             linksRoot.innerHTML = "";
             linksEmpty.style.display = "";
             return;
           }

           const items = linkDefinitions
             .map((linkDef) => {
               const url = buildLinkUrl(linkDef, rawDetail);
                if (!url) {
                  return "";
                }
                const label = renderLinkLabel(linkDef.labelTemplate, rawDetail);
                const targetAttrs = shouldOpenInNewTab(linkDef, url) ? ' target="_blank" rel="noopener noreferrer"' : "";
                return '<li><a href="' + escapeText(url) + '"' + targetAttrs + ">" + escapeText(label) + "</a></li>";
              })
              .filter(Boolean);

           linksRoot.innerHTML = items.join("");
           linksEmpty.style.display = items.length ? "none" : "";
         }

          tabButtons.forEach((button) => {
            button.addEventListener("click", () => {
              activateTab(button.dataset.tab);
            });
          });

          function closeHeaderFilters(exceptId) {
            filterPopovers.forEach((popover) => {
              if (exceptId && popover.id === exceptId) {
                return;
              }
              popover.hidden = true;
            });
            filterToggles.forEach((toggle) => {
              if (exceptId && toggle.dataset.filterTarget === exceptId) {
                toggle.setAttribute("aria-expanded", "true");
                return;
              }
              toggle.setAttribute("aria-expanded", "false");
            });
          }

          filterToggles.forEach((toggle) => {
            toggle.addEventListener("click", (event) => {
              event.stopPropagation();
              const targetId = toggle.dataset.filterTarget;
              const popover = targetId ? document.getElementById(targetId) : null;
              if (!popover) {
                return;
              }
              const willOpen = popover.hidden;
              closeHeaderFilters(willOpen ? targetId : "");
              popover.hidden = !willOpen;
              toggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
              if (willOpen) {
                const input = popover.querySelector('input[type="text"]');
                if (input) {
                  input.focus();
                  input.select();
                }
              }
            });
          });

          filterPopovers.forEach((popover) => {
            popover.addEventListener("click", (event) => {
              event.stopPropagation();
            });
          });

          document.addEventListener("click", () => {
            closeHeaderFilters("");
          });

         const defaultTab = "fields";
         activateTab(defaultTab);
         renderFields(null);

         function syncHorizontalScrollbar() {
           if (!tableMain || !dataTable || !tableScrollbar || !tableScrollbarInner) {
             return;
           }
            tableScrollbarInner.style.width = Math.max(dataTable.scrollWidth, tableMain.clientWidth) + "px";
            tableScrollbar.scrollLeft = tableMain.scrollLeft;
          }

         if (tableMain && tableScrollbar) {
           tableMain.addEventListener("scroll", () => {
             if (syncingBar) {
               syncingBar = false;
               return;
             }
             syncingMain = true;
             tableScrollbar.scrollLeft = tableMain.scrollLeft;
           });

           tableScrollbar.addEventListener("scroll", () => {
             if (syncingMain) {
               syncingMain = false;
               return;
             }
             syncingBar = true;
             tableMain.scrollLeft = tableScrollbar.scrollLeft;
           });

           syncHorizontalScrollbar();
           window.addEventListener("resize", syncHorizontalScrollbar);
         }

         function renderSidePanel(index) {
           renderLinks(index);
           renderFields(index);
         }

         rows.forEach((row) => {
           row.addEventListener("click", () => {
             if (selectedRow) {
               selectedRow.classList.remove("selected-row");
             }
             row.classList.add("selected-row");
             selectedRow = row;
             const rowIndex = Number(row.dataset.rowIndex);
             renderSidePanel(rowIndex);
           });
         });
       })();
     </script>`
  );
}

async function createSqlServerPool(connectionConfig) {
  const sqlServerConfig = connectionConfig.sqlserver || {};
  const pool = new sql.ConnectionPool({
    server: sqlServerConfig.server,
    database: sqlServerConfig.database,
    user: sqlServerConfig.user,
    password: sqlServerConfig.password,
    port: Number(sqlServerConfig.port || 1433),
    options: {
      encrypt: sqlServerConfig.options?.encrypt ?? true,
      trustServerCertificate: sqlServerConfig.options?.trustServerCertificate ?? true
    }
  });
  return pool.connect();
}

function createDuckDbConnection(connectionConfig) {
  // Lazy load so SQL Server-only installs do not require duckdb dependency.
  const duckdb = require("duckdb");
  const dbPath = connectionConfig.duckdb?.path || ":memory:";
  const db = new duckdb.Database(dbPath);
  return db.connect();
}

function runDuckDbQuery(connection, query, params) {
  return new Promise((resolve, reject) => {
    connection.all(query, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
    });
  });
}

const sqlServerPoolPromises = new Map();
const duckDbConnections = new Map();

async function getSqlServerPool(connection) {
  if (!sqlServerPoolPromises.has(connection.name)) {
    sqlServerPoolPromises.set(connection.name, createSqlServerPool(connection.config));
  }
  return sqlServerPoolPromises.get(connection.name);
}

function getDuckDbConnection(connection) {
  if (!duckDbConnections.has(connection.name)) {
    duckDbConnections.set(connection.name, createDuckDbConnection(connection.config));
  }
  return duckDbConnections.get(connection.name);
}

async function resetDatabaseClients() {
  for (const poolPromise of sqlServerPoolPromises.values()) {
    try {
      const pool = await poolPromise;
      if (pool?.close) {
        await pool.close();
      }
    } catch {
      // Ignore failed/half-open pool shutdowns during config changes.
    }
  }
  sqlServerPoolPromises.clear();

  for (const connection of duckDbConnections.values()) {
    try {
      if (connection?.close) {
        connection.close();
      }
    } catch {
      // Ignore close failures for cached DuckDB connections.
    }
  }
  duckDbConnections.clear();
}

async function scanSqlServerSchema(connection) {
  const pool = await getSqlServerPool(connection);
  const result = await pool.request().query(`
    SELECT
      t.TABLE_SCHEMA AS table_schema,
      t.TABLE_NAME AS table_name,
      c.COLUMN_NAME AS column_name,
      c.DATA_TYPE AS data_type,
      c.ORDINAL_POSITION AS ordinal_position,
      CASE WHEN pk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS is_primary_key
    FROM INFORMATION_SCHEMA.TABLES t
    INNER JOIN INFORMATION_SCHEMA.COLUMNS c
      ON c.TABLE_SCHEMA = t.TABLE_SCHEMA
      AND c.TABLE_NAME = t.TABLE_NAME
    LEFT JOIN (
      SELECT kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      INNER JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
        ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
        AND kcu.TABLE_NAME = tc.TABLE_NAME
      WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
    ) pk
      ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA
      AND pk.TABLE_NAME = c.TABLE_NAME
      AND pk.COLUMN_NAME = c.COLUMN_NAME
    WHERE t.TABLE_TYPE IN ('BASE TABLE', 'VIEW')
    ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME, c.ORDINAL_POSITION
  `);
  const groups = new Map();

  for (const row of result.recordset || []) {
    const schema = String(row.table_schema || "").trim();
    const table = String(row.table_name || "").trim();
    const key = `${schema}.${table}`;
    if (!groups.has(key)) {
      groups.set(key, { schema, table, columns: [] });
    }
    groups.get(key).columns.push({
      name: row.column_name,
      sqlType: row.data_type,
      isPrimaryKey: Boolean(row.is_primary_key)
    });
  }

  return Array.from(groups.values());
}

async function scanDuckDbSchema(connection) {
  const db = getDuckDbConnection(connection);
  const tableRows = await runDuckDbQuery(
    db,
    `SELECT table_schema, table_name
     FROM information_schema.tables
     WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
       AND table_type IN ('BASE TABLE', 'VIEW')
     ORDER BY table_schema, table_name`,
    []
  );
  const tables = [];

  for (const row of tableRows) {
    const schema = String(row.table_schema || "").trim();
    const table = String(row.table_name || "").trim();
    const targetName = (schema ? `${schema}.` : "") + table;
    const pragmaRows = await runDuckDbQuery(
      db,
      `SELECT * FROM pragma_table_info('${targetName.replaceAll("'", "''")}')`,
      []
    );
    tables.push({
      schema,
      table,
      columns: pragmaRows.map((column) => ({
        name: column.name,
        sqlType: column.type,
        isPrimaryKey: Boolean(column.pk)
      }))
    });
  }

  return tables;
}

async function scanDatabaseSchema(connection) {
  if (connection.type === "duckdb") {
    return scanDuckDbSchema(connection);
  }
  return scanSqlServerSchema(connection);
}

async function fetchViewRows(view, query) {
  const connection = getViewDatabaseConnection(view);
  const dbType = connection.type;
  const filters = collectSearchFilters(view, query);
  const limit = parsePositiveInt(query.limit, parsePositiveInt(view.limit, 200));
  const requestedPage = parsePositiveInt(query.page, 1);
  const baseOptions = {
    sortBy: query.sortBy,
    sortDir: query.sortDir,
    filters,
    limit
  };
  const countBuilt = buildCountQuery(view, baseOptions, dbType);
  let totalCount = 0;

  if (dbType === "duckdb") {
    const duckDbConnection = getDuckDbConnection(connection);
    const countRows = await runDuckDbQuery(duckDbConnection, countBuilt.query, countBuilt.queryParams);
    const countRow = countRows[0] || {};
    totalCount = Number(countRow.totalCount ?? Object.values(countRow)[0] ?? 0) || 0;
  } else {
    const pool = await getSqlServerPool(connection);
    const countRequest = pool.request();
    for (const queryParam of countBuilt.queryParams) {
      countRequest.input(queryParam.name, queryParam.value);
    }
    const countResult = await countRequest.query(countBuilt.query);
    const countRow = (countResult.recordset || [])[0] || {};
    totalCount = Number(countRow.totalCount ?? Object.values(countRow)[0] ?? 0) || 0;
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / limit));
  const page = Math.max(1, Math.min(requestedPage, totalPages));
  const options = {
    ...baseOptions,
    page,
    fetchLimit: limit + 1
  };
  const built = buildQuery(view, options, dbType);
  let rows;

  if (dbType === "duckdb") {
    const duckDbConnection = getDuckDbConnection(connection);
    rows = await runDuckDbQuery(duckDbConnection, built.query, built.queryParams);
  } else {
    const pool = await getSqlServerPool(connection);
    const request = pool.request();
    for (const queryParam of built.queryParams) {
      request.input(queryParam.name, queryParam.value);
    }
    const result = await request.query(built.query);
    rows = result.recordset || [];
  }

  const hasNext = page < totalPages;
  const pagedRows = rows.slice(0, limit);

  return {
    rows: pagedRows,
    built,
    filters,
    page,
    limit,
    hasNext,
    totalCount,
    totalPages
  };
}

function buildRowDebugSummary(view, rows) {
  const configuredColumns = (view.columns || []).map((column) => column.name).filter(Boolean);
  const rowSummaries = rows.map((row, index) => {
    const keyIndex = buildRowKeyIndex(row);
    const rawKeys = Object.keys(row || {});
    const resolved = [];
    const missing = [];

    for (const columnName of configuredColumns) {
      const value = getRowValue(row, columnName, keyIndex);
      const keyVariants = normalizeRowKeyVariants(columnName);
      const matchedVariant = keyVariants.find((variant) => keyIndex.has(variant));
      const matchedKey = matchedVariant ? keyIndex.get(matchedVariant) : null;
      const entry = {
        column: columnName,
        matchedKey: matchedKey || null,
        hasValue: !(value === undefined || value === null || value === "")
      };
      resolved.push(entry);
      if (!matchedKey) {
        missing.push(columnName);
      }
    }

    return {
      rowIndex: index,
      rawKeys,
      missingColumns: missing,
      resolvedColumns: resolved
    };
  });

  return {
    configuredColumns,
    rowCount: rows.length,
    rows: rowSummaries
  };
}

app.get("/", (_req, res) => {
  res.send(renderHome());
});

app.get("/settings", (req, res) => {
  res.send(
    renderSettings({
      message: firstQueryValue(req.query.message),
      error: firstQueryValue(req.query.error),
      scanConnectionName: firstQueryValue(req.query.connectionName),
      limit: parsePositiveInt(req.query.limit, 200),
      maxSearchFields: parsePositiveInt(req.query.maxSearchFields, 3)
    })
  );
});

app.post("/settings/database/save", async (req, res) => {
  const originalName = normalizeDatabaseName(req.body?.originalName);
  const name = normalizeDatabaseName(req.body?.name);
  const type = String(req.body?.type || "sqlserver").trim().toLowerCase();
  const catalog = getDatabaseCatalog();
  const connections = { ...catalog.connections };

  if (!name) {
    res.status(400).send(renderSettings({ error: "Database connection name is required." }));
    return;
  }
  if (type !== "sqlserver" && type !== "duckdb") {
    res.status(400).send(renderSettings({ error: "Database type must be sqlserver or duckdb." }));
    return;
  }
  if (originalName && originalName !== name && connections[name]) {
    res.status(400).send(renderSettings({ error: `A database connection named ${name} already exists.` }));
    return;
  }

  const nextConnection =
    type === "duckdb"
      ? {
          type: "duckdb",
          duckdb: {
            path: String(req.body?.path || "").trim() || ":memory:"
          }
        }
      : {
          type: "sqlserver",
          sqlserver: {
            server: String(req.body?.server || "").trim(),
            database: String(req.body?.database || "").trim(),
            user: String(req.body?.user || "").trim(),
            password: String(req.body?.password || ""),
            port: parsePositiveInt(req.body?.port, 1433),
            options: {
              encrypt: req.body?.encrypt === "on",
              trustServerCertificate: req.body?.trustServerCertificate === "on"
            }
          }
        };

  if (type === "sqlserver" && (!nextConnection.sqlserver.server || !nextConnection.sqlserver.database)) {
    res
      .status(400)
      .send(renderSettings({ error: "SQL Server connections require both server and database values." }));
    return;
  }

  if (originalName && originalName !== name) {
    delete connections[originalName];
    for (const view of Object.values(viewsConfig.views || {})) {
      if (view?.database === originalName) {
        view.database = name;
      }
    }
    saveViewsConfig();
  }

  connections[name] = nextConnection;
  appConfig.database = {
    ...(appConfig.database || {}),
    defaultConnection:
      req.body?.setDefault === "on"
        ? name
        : normalizeDatabaseName(appConfig.database?.defaultConnection) || (connections[name] ? name : Object.keys(connections)[0]),
    connections
  };

  if (!appConfig.database.defaultConnection || !connections[appConfig.database.defaultConnection]) {
    appConfig.database.defaultConnection = name;
  }

  saveAppConfig();
  loadConfigs();
  await resetDatabaseClients();
  res.redirect(`/settings?message=${encodeURIComponent(`Saved database connection ${name}.`)}`);
});

app.post("/settings/database/delete", async (req, res) => {
  const name = normalizeDatabaseName(req.body?.name);
  const catalog = getDatabaseCatalog();
  const connections = { ...catalog.connections };

  if (!name || !connections[name]) {
    res.status(400).send(renderSettings({ error: "Database connection not found." }));
    return;
  }
  if (Object.keys(connections).length <= 1) {
    res.status(400).send(renderSettings({ error: "At least one database connection must remain configured." }));
    return;
  }

  const dependentViews = Object.entries(viewsConfig.views || {})
    .filter(([, view]) => normalizeDatabaseName(view?.database) === name)
    .map(([viewName]) => viewName);

  if (dependentViews.length) {
    res
      .status(400)
      .send(
        renderSettings({
          error: `Cannot delete ${name} because these views still use it: ${dependentViews.join(", ")}.`
        })
      );
    return;
  }

  delete connections[name];
  appConfig.database = {
    ...(appConfig.database || {}),
    defaultConnection:
      catalog.defaultConnection === name ? Object.keys(connections)[0] : appConfig.database?.defaultConnection,
    connections
  };

  saveAppConfig();
  loadConfigs();
  await resetDatabaseClients();
  res.redirect(`/settings?message=${encodeURIComponent(`Deleted database connection ${name}.`)}`);
});

app.post("/settings/scan", async (req, res) => {
  const connectionName = normalizeDatabaseName(req.body?.connectionName);
  const limit = parsePositiveInt(req.body?.limit, 200);
  const maxSearchFields = parsePositiveInt(req.body?.maxSearchFields, 3);

  try {
    const connection = resolveDatabaseConnection(connectionName);
    const tables = await scanDatabaseSchema(connection);
    const generatedConfig = buildViewsConfigFromSchemaTables(tables, {
      limit,
      maxSearchFields,
      databaseName: connection.name
    });
    const viewCount = Object.keys(generatedConfig.views || {}).length;

    if (!viewCount) {
      res
        .status(400)
        .send(
          renderSettings({
            error: `Scan completed for ${connection.name}, but no tables or views were discovered.`,
            scanConnectionName: connection.name,
            limit,
            maxSearchFields
          })
        );
      return;
    }

    viewsConfig = generatedConfig;
    saveViewsConfig();
    loadConfigs();
    res.redirect(
      `/settings?message=${encodeURIComponent(
        `Scanned ${connection.name} and rebuilt views config with ${viewCount} view(s).`
      )}&connectionName=${encodeURIComponent(connection.name)}&limit=${limit}&maxSearchFields=${maxSearchFields}`
    );
  } catch (error) {
    res
      .status(500)
      .send(
        renderSettings({
          error: `Scan failed: ${error.message}`,
          scanConnectionName: connectionName,
          limit,
          maxSearchFields
        })
      );
  }
});

app.get("/config/:viewName", (req, res) => {
  const view = getView(req.params.viewName);

  if (!view) {
    res
      .status(404)
      .send(
        renderLayout(
          "Not Found",
          `<h1>View not found</h1><p>No config exists for <code>${escapeHtml(req.params.viewName)}</code>.</p>`
        )
      );
    return;
  }

  const message = firstQueryValue(req.query.saved) ? "View config saved." : "";
  res.send(renderViewConfig(req.params.viewName, view, { message }));
});

app.post("/config/:viewName", (req, res) => {
  const viewName = req.params.viewName;
  const view = getView(viewName);

  if (!view) {
    res
      .status(404)
      .send(
        renderLayout(
          "Not Found",
          `<h1>View not found</h1><p>No config exists for <code>${escapeHtml(viewName)}</code>.</p>`
        )
      );
    return;
  }

  const selectedColumns = new Set(
    asArray(req.body?.visibleColumns)
      .map((column) => String(column || "").trim())
      .filter(Boolean)
  );
  const existingColumns = view.columns || [];
  const validColumns = new Set(existingColumns.map((column) => column.name).filter(Boolean));
  const requestedOrder = asArray(req.body?.columnOrder)
    .map((column) => String(column || "").trim())
    .filter((column) => column && validColumns.has(column));
  const normalizedOrder = [];
  const seenOrderedColumns = new Set();
  for (const columnName of requestedOrder) {
    if (!seenOrderedColumns.has(columnName)) {
      seenOrderedColumns.add(columnName);
      normalizedOrder.push(columnName);
    }
  }
  for (const column of existingColumns) {
    if (column?.name && !seenOrderedColumns.has(column.name)) {
      seenOrderedColumns.add(column.name);
      normalizedOrder.push(column.name);
    }
  }
  const normalizedSelectedColumns = Array.from(selectedColumns).filter((column) => validColumns.has(column));

  if (!normalizedSelectedColumns.length) {
    res
      .status(400)
      .send(
        renderViewConfig(viewName, view, {
          error: "Select at least one column to show in the grid.",
          selectedColumns: []
        })
      );
    return;
  }

  const columnByName = new Map(existingColumns.map((column) => [column.name, column]));
  view.columns = normalizedOrder.map((columnName) => columnByName.get(columnName)).filter(Boolean);

  for (const column of view.columns || []) {
    if (selectedColumns.has(column.name)) {
      delete column.hideOnGrid;
      continue;
    }
    column.hideOnGrid = true;
  }

  saveViewsConfig();
  loadConfigs();
  res.redirect(`/config/${encodeURIComponent(viewName)}?saved=1`);
});

app.get("/table/:viewName/download.csv", async (req, res) => {
  const view = getView(req.params.viewName);

  if (!view) {
    res.status(404).send("View not found");
    return;
  }

  try {
    const { rows } = await fetchViewRows(view, req.query);
    const headers = view.columns.map((column) => escapeCsv(column.label || column.name)).join(",");
    const lines = rows.map((row) => {
      const rowKeyIndex = buildRowKeyIndex(row);
      return view.columns
        .map((column) => escapeCsv(formatCellValue(getRowValue(row, column.name, rowKeyIndex), column)))
        .join(",");
    });
    const csv = [headers, ...lines].join("\r\n");

    const fileBase = String(view.title || req.params.viewName)
      .replace(/[^a-z0-9_-]+/gi, "_")
      .replace(/^_+|_+$/g, "") || "data";

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileBase}.csv"`);
    res.send(csv);
  } catch (error) {
    res.status(500).send(`Export error: ${error.message}`);
  }
});

app.get("/table/:viewName", async (req, res) => {
  const view = getView(req.params.viewName);

  if (!view) {
    res
      .status(404)
      .send(
        renderLayout(
          "Not Found",
          `<h1>View not found</h1><p>No config exists for <code>${escapeHtml(req.params.viewName)}</code>.</p>`
        )
      );
    return;
  }

  try {
    const breadcrumbs = decodeBreadcrumbs(firstQueryValue(req.query.crumbs));
    const currentUrl = stripQueryParam(req.originalUrl, "crumbs");
    const currentCrumb = { label: view.title || req.params.viewName, url: currentUrl };
    const nextBreadcrumbsToken = encodeBreadcrumbs([...breadcrumbs, currentCrumb]);
    const { rows, built, filters, page, limit, hasNext, totalCount, totalPages } = await fetchViewRows(view, req.query);
    const currentQueryString = buildQueryString(req.query);

    res.send(
      renderTable(req.params.viewName, view, rows, {
        sorts: built.sorts,
        sortColumn: built.sortColumn,
        direction: built.direction,
        filters,
        breadcrumbs,
        nextBreadcrumbsToken,
        currentQueryString,
        currentQuery: req.query,
        page,
        limit,
        hasNext,
        totalCount,
        totalPages
      })
    );
  } catch (error) {
    res
      .status(500)
      .send(renderLayout("Error", `<h1>Database error</h1><pre>${escapeHtml(error.message)}</pre>`));
  }
});

app.get("/debug/:viewName/keys", async (req, res) => {
  const view = getView(req.params.viewName);
  if (!view) {
    res.status(404).json({ error: `View not found: ${req.params.viewName}` });
    return;
  }

  try {
    const sampleLimit = Math.min(parsePositiveInt(req.query.sample, 25), 200);
    const debugQuery = {
      ...req.query,
      limit: sampleLimit,
      page: 1
    };
    delete debugQuery.sample;
    const { rows, built, filters } = await fetchViewRows(view, debugQuery);
    const summary = buildRowDebugSummary(view, rows);

    res.json({
      viewName: req.params.viewName,
      title: view.title || req.params.viewName,
      sampleLimit,
      filters,
      generatedQuery: built.query,
      summary
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

loadConfigs();
fs.mkdirSync(servedFilesPath, { recursive: true });
app.use("/files", express.static(servedFilesPath));

app.listen(PORT, () => {
  console.log(`App running at http://localhost:${PORT}`);
});
