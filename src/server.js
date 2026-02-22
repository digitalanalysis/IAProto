const fs = require("fs");
const path = require("path");
const express = require("express");
const sql = require("mssql");

const app = express();
const PORT = process.env.PORT || 3000;

const appConfigPath = path.join(__dirname, "..", "config", "app.config.json");
const viewsConfigPath = path.join(__dirname, "..", "config", "views.config.json");

let appConfig;
let viewsConfig;

function loadConfigs() {
  appConfig = JSON.parse(fs.readFileSync(appConfigPath, "utf8"));
  viewsConfig = JSON.parse(fs.readFileSync(viewsConfigPath, "utf8"));
}

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

function getDatabaseType() {
  return String(process.env.DB_TYPE || appConfig.database.type || "sqlserver").toLowerCase();
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

  return columns;
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
  const columns = view.columns
    .map((column) => quoteIdentifier(column.name, dbType))
    .join(", ");

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

  const sortColumn = allowedColumns.has(options.sortBy)
    ? options.sortBy
    : view.defaultSort?.column || view.columns[0].name;

  const direction =
    String(options.sortDir || view.defaultSort?.direction || "ASC").toUpperCase() === "DESC"
      ? "DESC"
      : "ASC";

  const topOrLimit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 200;

  const query =
    dbType === "duckdb"
      ? `SELECT ${columns} FROM ${tableRef}${whereSql} ORDER BY ${quoteIdentifier(sortColumn, dbType)} ${direction} LIMIT ${topOrLimit}`
      : `SELECT TOP (${topOrLimit}) ${columns} FROM ${tableRef}${whereSql} ORDER BY ${quoteIdentifier(sortColumn, dbType)} ${direction}`;

  return { query, queryParams, sortColumn, direction };
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

  for (const mapping of mappings) {
    const localValue = row[mapping.localColumn];
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

function formatCellValue(value, column) {
  if (value === null || value === undefined) {
    return "";
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

function renderLayout(title, content) {
  const banner = appConfig.ui?.banner || {};
  const bannerTitle = banner.title || "Configurable Data Viewer";
  const bannerSubtitle = banner.subtitle || "SQL Server and DuckDB table explorer";

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
      }
      body {
        margin: 0;
        padding: 0;
        font-family: "Segoe UI", Tahoma, sans-serif;
        background: linear-gradient(180deg, #eef3ff 0%, var(--bg) 30%);
        color: var(--text);
      }
      .site-banner {
        background: linear-gradient(120deg, #0f6fff 0%, #0a4fbc 100%);
        color: #fff;
        padding: 16px 24px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.2);
      }
      .site-banner-title {
        font-size: 20px;
        font-weight: 600;
      }
      .site-banner-subtitle {
        margin-top: 4px;
        font-size: 13px;
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
        font-size: 14px;
      }
      th {
        background: #f0f4fc;
      }
      a {
        color: var(--accent);
        text-decoration: none;
      }
      .muted {
        color: #60708f;
        font-size: 13px;
      }
      .toolbar {
        display: flex;
        gap: 12px;
        margin: 8px 0 16px;
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
        font-size: 12px;
      }
      .breadcrumbs {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin: 0 0 10px;
        font-size: 13px;
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
      .search-form {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 10px;
        align-items: end;
      }
      .search-form > label {
        display: grid;
        gap: 4px;
        font-size: 13px;
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
        font-size: 13px;
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
        font-size: 13px;
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
        font-size: 16px;
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
        font-size: 12px;
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
        font-size: 12px;
        color: #60708f;
      }
      .details-grid dd {
        margin: 2px 0 0;
        font-size: 14px;
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
  const dbType = getDatabaseType();
  const viewItems = Object.entries(viewsConfig.views)
    .filter(([, view]) => !view.hideOnHome)
    .map(([viewName, view]) => {
      const tableLabel = view.schema && dbType !== "duckdb" ? `${view.schema}.${view.table}` : view.table;
      const searchFields = (view.searchFields || [])
        .map((field) => renderSearchFieldControl(field))
        .join("");
      const searchForm = searchFields
        ? `<form method="get" action="/table/${encodeURIComponent(viewName)}" class="search-form">${searchFields}<button type="submit" class="search-submit">Search</button></form>`
        : `<p class="muted">No search fields configured.</p>`;

      return `<li>
        <div class="view-title"><a href="/table/${encodeURIComponent(viewName)}">${escapeHtml(view.title || viewName)}</a> <span class="muted">(${escapeHtml(tableLabel)})</span></div>
        ${searchForm}
      </li>`;
    })
    .join("\n");

  return renderLayout(
    "Search",
    `<h1>Search</h1>
     <ul class="view-list">${viewItems}</ul>`
  );
}

function renderTable(viewName, view, rows, context) {
  const gridColumns = getGridColumns(view);
  const headers = gridColumns.map((column) => `<th>${escapeHtml(column.label || column.name)}</th>`).join("");
  const nextBreadcrumbsToken = context.nextBreadcrumbsToken || "";

  const relatedHeader = Array.isArray(view.links) && view.links.length ? "<th>Related</th>" : "";

  const rowDetails = [];
  const rowRawDetails = [];

  const body = rows
    .map((row, index) => {
      const detail = {};
      const cells = gridColumns
        .map((column) => {
          const value = formatCellValue(row[column.name], column);
          return `<td>${escapeHtml(value)}</td>`;
        })
        .join("");
      for (const column of view.columns) {
        detail[column.name] = formatCellValue(row[column.name], column);
      }
      rowDetails.push(detail);
      const rawDetail = {};
      for (const column of view.columns) {
        rawDetail[column.name] = row[column.name];
      }
      rowRawDetails.push(rawDetail);

      const related =
        Array.isArray(view.links) && view.links.length
          ? `<td>${view.links
              .map((link) => {
                const linkFilters = buildLinkFilters(link, row);
                if (!linkFilters.length || !link.targetView) {
                  return "";
                }
                const linkParams = new URLSearchParams();
                for (const filter of linkFilters) {
                  linkParams.set(`f_${filter.column}`, filter.value);
                }
                if (nextBreadcrumbsToken) {
                  linkParams.set("crumbs", nextBreadcrumbsToken);
                }
                const url = `/table/${encodeURIComponent(link.targetView)}?${linkParams.toString()}`;
                return `<a href="${url}">${escapeHtml(link.label || link.targetView)}</a>`;
              })
              .filter(Boolean)
              .join(" | ")}</td>`
          : "";

      return `<tr class="data-row" data-row-index="${index}">${cells}${related}</tr>`;
    })
    .join("\n");

  const chips = [
    `Rows: ${rows.length}`,
    `Sort: ${context.sortColumn} ${context.direction}`,
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
    label: column.label || column.name
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
      label: link.label || link.targetView,
      targetView: link.targetView,
      keys: extractLinkKeyMappings(link)
    }))
    .filter((link) => link.targetView && link.keys.length);
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
       <a href="${downloadUrl}">Download CSV</a>
     </div>
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
               return '<div><dt>' + escapeText(column.label) + '</dt><dd>' + escapeText(renderedValue) + '</dd></div>';
             })
             .join("");
           fieldsEmpty.style.display = index === null || index === undefined || !detailsByRow[index] ? "" : "none";
         }

         function buildLinkUrl(linkDef, rawDetail) {
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
               return '<li><a href="' + url + '">' + escapeText(linkDef.label) + "</a></li>";
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

async function createSqlServerPool() {
  return sql.connect({
    server: process.env.DB_SERVER || appConfig.database.sqlserver?.server || appConfig.database.server,
    database: process.env.DB_DATABASE || appConfig.database.sqlserver?.database || appConfig.database.database,
    user: process.env.DB_USER || appConfig.database.sqlserver?.user || appConfig.database.user,
    password: process.env.DB_PASSWORD || appConfig.database.sqlserver?.password || appConfig.database.password,
    port: Number(process.env.DB_PORT || appConfig.database.sqlserver?.port || appConfig.database.port || 1433),
    options: {
      encrypt:
        appConfig.database.sqlserver?.options?.encrypt ?? appConfig.database.options?.encrypt ?? true,
      trustServerCertificate:
        appConfig.database.sqlserver?.options?.trustServerCertificate ??
        appConfig.database.options?.trustServerCertificate ??
        true
    }
  });
}

function createDuckDbConnection() {
  // Lazy load so SQL Server-only installs do not require duckdb dependency.
  const duckdb = require("duckdb");
  const dbPath = process.env.DUCKDB_PATH || appConfig.database.duckdb?.path || ":memory:";
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

let sqlServerPoolPromise;
let duckDbConnection;

async function fetchViewRows(view, query) {
  const dbType = getDatabaseType();
  const filters = collectSearchFilters(view, query);
  const options = {
    sortBy: query.sortBy,
    sortDir: query.sortDir,
    filters,
    limit: Number(query.limit || view.limit || 200)
  };

  const built = buildQuery(view, options, dbType);
  let rows;

  if (dbType === "duckdb") {
    if (!duckDbConnection) {
      duckDbConnection = createDuckDbConnection();
    }
    rows = await runDuckDbQuery(duckDbConnection, built.query, built.queryParams);
  } else {
    if (!sqlServerPoolPromise) {
      sqlServerPoolPromise = createSqlServerPool();
    }

    const pool = await sqlServerPoolPromise;
    const request = pool.request();

    for (const queryParam of built.queryParams) {
      request.input(queryParam.name, queryParam.value);
    }

    const result = await request.query(built.query);
    rows = result.recordset || [];
  }

  return { rows, built, filters };
}

app.get("/", (_req, res) => {
  res.send(renderHome());
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
    const lines = rows.map((row) =>
      view.columns.map((column) => escapeCsv(formatCellValue(row[column.name], column))).join(",")
    );
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
    const { rows, built, filters } = await fetchViewRows(view, req.query);
    const currentQueryString = buildQueryString(req.query);

    res.send(
      renderTable(req.params.viewName, view, rows, {
        sortColumn: built.sortColumn,
        direction: built.direction,
        filters,
        breadcrumbs,
        nextBreadcrumbsToken,
        currentQueryString
      })
    );
  } catch (error) {
    res
      .status(500)
      .send(renderLayout("Error", `<h1>Database error</h1><pre>${escapeHtml(error.message)}</pre>`));
  }
});

loadConfigs();

app.listen(PORT, () => {
  console.log(`App running at http://localhost:${PORT}`);
});
