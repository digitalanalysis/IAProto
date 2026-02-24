# Code Documentation

## Overview

This project is a config-driven data explorer built with Node.js + Express. It serves HTML pages directly (no template engine) and queries either SQL Server (`mssql`) or DuckDB (`duckdb`) based on `config/app.config.json` and environment overrides.

Core goals:

- Render configurable table views from `config/views.config.json`
- Provide query/filter/sort support from URL params
- Support related-view navigation links (single/composite keys)
- Export current results as CSV

## Repository Layout

- `src/server.js`: main web app, rendering, query builder, data access, routes
- `src/generate-views-config-from-ddl.js`: CLI for generating starter views config from SQL Server DDL
- `src/utils/buildViewsConfigFromSqlServerDdl.js`: DDL parser + config builder
- `config/app.config.json`: database and UI settings
- `config/views.config.json`: manually maintained view definitions
- `config/views.generated.config.json`: generated starter config

## Runtime Architecture

### Startup

1. `loadConfigs()` reads:
   - `config/app.config.json`
   - `config/views.config.json`
2. `app.listen(PORT)` starts the HTTP server.
3. DB connections are lazy:
   - SQL Server pool created on first SQL Server query
   - DuckDB connection created on first DuckDB query

### Request Flow (Table Page)

For `GET /table/:viewName`:

1. Resolve view with `getView(viewName)`
2. Parse filters from query params using `collectSearchFilters(view, req.query)`
3. Build SQL with `buildQuery(view, options, dbType)`
4. Execute query via `fetchViewRows(view, req.query)`
5. Render HTML with `renderTable(...)`
6. Inline client-side script controls row selection, side-panel fields, and side-panel links

### Request Flow (CSV Export)

For `GET /table/:viewName/download.csv`:

1. Reuses `fetchViewRows(view, req.query)` so filter/sort/limit behavior matches table UI
2. Uses configured `view.columns` order
3. Applies `formatCellValue()` to each exported cell
4. Returns CSV with content-disposition attachment

## HTTP Endpoints

- `GET /`
  - Renders search/home page with all visible views
- `GET /table/:viewName`
  - Renders table grid + related links + side panel
- `GET /table/:viewName/download.csv`
  - Returns CSV for current query state

## Configuration Model (Code Behavior)

### `config/app.config.json`

- `database.type`: `sqlserver` or `duckdb`
- SQL Server settings:
  - `database.sqlserver.server`, `.database`, `.user`, `.password`, `.port`, `.options`
- DuckDB settings:
  - `database.duckdb.path`
- UI settings:
  - `ui.banner.title`, `ui.banner.subtitle`
  - `ui.fontFamily`, `ui.fontSize`
  - `ui.dateFormat`

Environment overrides used in code:

- `DB_TYPE`, `DB_SERVER`, `DB_DATABASE`, `DB_USER`, `DB_PASSWORD`, `DB_PORT`, `DUCKDB_PATH`

### `config/views.config.json`

Each view controls:

- Source table (`schema`, `table`)
- Selected/displayed columns (`columns`)
- Sort/limit (`defaultSort`, `limit`)
- Search controls (`searchFields`)
- Related links (`links`)

Important implementation detail:

- Query selection includes `view.columns`, `view.keyColumn`, and local link-key columns so composite links can render even if some key fields are hidden from the grid.

## Query and Filter System

### SQL Safety

- Identifiers are quoted with `quoteIdentifier()` based on DB type:
  - SQL Server: `[Column]`
  - DuckDB: `"Column"`
- Filter column names are validated against `collectAllowedColumns(view)`
- Values are parameterized:
  - SQL Server named params (`@filterValueN`)
  - DuckDB positional params (`?`)

### Filter Sources

- Search form fields: `s_<column>` (+ date range variants)
- Exact filters for links: `f_<column>`
- Legacy fallback: `filterColumn` + `filterValue`

Supported operators after normalization:

- `exact`, `contains`, `startsWith`, `endsWith`, `gt`, `gte`, `lt`, `lte`, `in`

## Rendering System

### Server-Side Rendering

`renderLayout(title, content)` builds a full HTML document including CSS.

`renderTable(...)` composes:

- grid headers and rows
- related links column
- breadcrumbs
- row-details payload (formatted and raw values)
- inline JS for client interactions

### Client-Side Behavior (Inline Script)

- Row click selection
- Side panel tab switching (`Fields` / `Links`)
- Field details rendering from preloaded JSON
- Link rendering from preloaded link definitions + raw row data
- Horizontal scrollbar synchronization for wide tables

## Cell Formatting Behavior

`formatCellValue(value, column)` applies formatting in this order:

1. Numeric formatting (if numeric config present)
   - `format: "number"` and/or `precision`, `thousandSeparator`/`thousandsSeparator`, `decimalSeparator`, `numberFormat`
2. Date/time formatting
   - column `dateFormat` (string/object), `format` (`date`, `time`, `datetime`), global `ui.dateFormat`
3. Fallback
   - `String(value)`

## Related Link System

### Link Key Mapping Forms

`extractLinkKeyMappings(link)` supports:

- `keys: [{ localColumn, targetColumn }, ...]` (recommended)
- `localColumns[]` + `targetColumns[]`
- single pair `localColumn` + `targetColumn`

### URL Generation

- Link filters become `f_<targetColumn>=<value>`
- Breadcrumb token (`crumbs`) is propagated
- Composite links require all mapped local values to be present for sidebar link rendering

### Label Templating

Link labels support row-field replacement tags:

- `{{FieldName}}`
- `{FieldName}`

Missing field values resolve to empty strings.

## Database Access Layer

### SQL Server

- `createSqlServerPool()` calls `sql.connect(...)`
- Pool promise cached in `sqlServerPoolPromise`
- Query execution via `pool.request().input(...).query(...)`

### DuckDB

- `createDuckDbConnection()` lazy-loads `duckdb` package
- Connection cached in `duckDbConnection`
- Query execution wrapped in Promise by `runDuckDbQuery()`

## DDL-to-Config Generator

### Entry Script

- `src/generate-views-config-from-ddl.js`
  - Reads input DDL
  - Calls `buildViewsConfigFromSqlServerDdl(ddl, options)`
  - Writes output JSON

### Parser/Builder

- `src/utils/buildViewsConfigFromSqlServerDdl.js`
  - Removes SQL comments
  - Extracts `CREATE TABLE` blocks
  - Parses column definitions and table PK
  - Infers:
    - `keyColumn`
    - search fields
    - basic date/time column formats
  - Produces `{ views: { ... } }` structure compatible with app runtime

## Error Handling

- Missing view:
  - HTML 404 on table route
  - plain text 404 on CSV route
- Query/export failures:
  - HTML 500 page for table route
  - plain text 500 for CSV route
- Invalid breadcrumb token:
  - safely ignored (falls back to empty breadcrumb list)

## Extension Points

Common changes and where to implement them:

- New search operator:
  - `normalizeSearchOperator()`
  - `resolveSqlOperator()`
  - `applySearchPattern()`
- New field/search UI control:
  - `normalizeSearchFieldType()`
  - `renderSearchFieldControl()`
  - `collectSearchFilters()`
- New cell format type:
  - `formatCellValue()` + helper functions
- Additional route/output format:
  - add route near existing `app.get(...)` handlers and reuse `fetchViewRows()`

## Operational Notes

- Config is loaded once at startup; runtime edits require process restart.
- No automated tests are currently included.
- The app currently renders HTML/CSS/JS from `server.js`; extracting templates/components is a good future refactor if complexity grows.
