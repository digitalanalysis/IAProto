# SQL Server / DuckDB Configurable Table Viewer

A Node.js web application that reads table/view definitions from configuration files and renders SQL Server or DuckDB data in configurable tabular pages.

## Features

- SQL Server data access via `mssql`
- DuckDB data access via `duckdb`
- Config-driven table definitions (schema, table, columns, sort, row limit)
- Config-driven links between views/tables
- Config-driven front-page search forms per view
- Simple in-browser sort controls
- Optional cross-table filtering using query parameters
- CSV export for current grid query (all configured fields, formatted values)

## Project Structure

- `src/server.js`: Express app and DB query logic
- `config/app.config.json`: Database connection config
- `config/views*.json`: Per-source table view + link definitions
- `files/`: Static files served at `/files/...`
- `docs/CODE_DOCUMENTATION.md`: Detailed code architecture and function reference

## Setup

1. Install dependencies:

```bash
npm install
```

2. Set database type and connection in `config/app.config.json`.

3. Update the relevant source views config file to match your schema/tables.

## Run

```bash
npm start
```

Open `http://localhost:3000`

## Electron Build

To build a portable Windows Electron executable:

```bat
build-electron.bat
```

Equivalent manual commands:

```bash
npm install
npm run build:electron
```

The packaged output is written to `dist/`.

In the packaged Electron build, the app uses `config/` and `files/` in the same directory as the executable. On first launch it copies the packaged defaults there if they do not already exist, and if a sibling legacy `Files/` folder is present it is copied into lowercase `files/`. In development mode, Electron uses `.electron-runtime/` in the project root instead.

Static files:

- Put files under `files/`
- Access them at `http://localhost:3000/files/<path>`
- Legacy attachment URLs under `http://localhost:3000/Files/<path>` also resolve to the same folder

On table pages, use **Download CSV** to export the current query result.

- Includes all fields from `views.<name>.columns`, even if `hideOnGrid` is `true`
- Applies configured formatting (date/time formats, global date format fallback)
- Uses current filters, sort, and limit from the page query

Each view also has an **Edit view config** screen at `/config/:viewName`.

- Saves column visibility and order changes back to the active source's views config file
- Updates `views.<name>.columns[].hideOnGrid`
- Updates the order of `views.<name>.columns`
- Keeps hidden grid columns available in the row details panel and CSV export

## Generate Config From SQL Server DDL

You can generate a starter views config structure from a SQL Server DDL file:

```bash
npm run generate:views-config -- ./schema.sql ./config/views.generated.config.json
```

Arguments:

- `input.ddl.sql` (required): SQL file containing `CREATE TABLE` statements
- `output.json` (optional): output path (default: `config/views.generated.config.json`)
- `limit` (optional): default row limit per view (default: `200`)
- `maxSearchFields` (optional): number of generated search fields per view (default: `3`)

Example with all arguments:

```bash
npm run generate:views-config -- ./schema.sql ./config/views.generated.config.json 500 4
```

## Database Config

The app now supports multiple named database connections in `config/app.config.json`, managed from the UI at `/settings`.

Recommended structure:

- `database.defaultConnection`: name of the default connection
- `database.connections.<name>.type`: `"sqlserver"` or `"duckdb"`
- `database.connections.<name>.viewsConfigPath`: optional path to that source's views config file
- `database.connections.<name>.sqlserver.server`
- `database.connections.<name>.sqlserver.database`
- `database.connections.<name>.sqlserver.user`
- `database.connections.<name>.sqlserver.password`
- `database.connections.<name>.sqlserver.port`
- `database.connections.<name>.sqlserver.options`
- `database.connections.<name>.duckdb.path`

Legacy single-database config is still accepted and is treated as a `default` connection.

Settings UI:

- `/settings`: manage database connections and trigger schema scans
- `/settings/scan`: scans a selected database and rebuilds that source's views config file from live schema metadata

Views config files:

- Each data source can have its own views config JSON file
- If `viewsConfigPath` is omitted, the app uses `config/views.<source>.config.json`
- Legacy single-source setups still use `config/views.config.json`
- The top toolbar lets users switch between sources and their corresponding view sets

Environment overrides:

- `DB_TYPE`, `DB_SERVER`, `DB_DATABASE`, `DB_USER`, `DB_PASSWORD`, `DB_PORT`, `DUCKDB_PATH`
- These apply to the legacy/single default connection path

UI settings in `config/app.config.json`:

- `ui.banner.title`
- `ui.banner.subtitle`
- `ui.fontFamily`: Global font family CSS value (for example `"Segoe UI", Tahoma, sans-serif`)
- `ui.fontSize`: Global base font size in px (number or `"16px"`, allowed range `10-24`)
- `ui.dateFormat`: Global date format string for all date/datetime/time columns (for example `DD/MM/YYYY`)

## Configuration Model

Views config format:

- `views.<name>.schema`: SQL schema (used for SQL Server; optional for DuckDB)
- `views.<name>.table`: SQL table name
- `views.<name>.database`: Optional database connection name from `app.config.json`
- `views.<name>.hideOnHome`: Optional boolean to hide a view from the front-page search list
- `views.<name>.columns`: Columns shown in the table
- `views.<name>.columns[].hideOnGrid`: Optional boolean to hide a column from the main table grid (still available in row details and links)
- `views.<name>.columns[].align`: Optional text alignment (`left`, `center`, `right`) for grid and row-panel values
- `views.<name>.columns[].format`: Optional cell formatter (`date`, `datetime`, `time`, `number`)
- `views.<name>.columns[].link`: Optional cell link definition using the same shape as `views.<name>.links`
- `views.<name>.columns[].dateFormat`: Optional date format, either:
  - string pattern (for example `DD/MM/YYYY`)
  - `Intl.DateTimeFormat` options object
- `views.<name>.columns[].precision`: Optional fixed decimal places for numeric formatting
- `views.<name>.columns[].thousandSeparator` / `views.<name>.columns[].thousandsSeparator`: Optional grouping separator override for numeric formatting (for example `","`)
- `views.<name>.columns[].decimalSeparator`: Optional decimal separator override for numeric formatting
- `views.<name>.columns[].numberFormat`: Optional object form for numeric formatting:
  - `precision`: fixed decimal places
  - `useGrouping`: boolean
  - `thousandSeparator` / `thousandsSeparator`
  - `decimalSeparator`
- `views.<name>.columns[].locale`: Optional locale (for date/time formatting)
- `views.<name>.columns[].timeZone`: Optional time zone (for date/time formatting)
- `views.<name>.defaultSort`: Default ordering. Supports either:
  - object form: `{ "column": "MyColumn", "direction": "ASC" }`
  - array form (multi-column): `[{ "column": "ColA", "direction": "ASC" }, { "column": "ColB", "direction": "DESC" }]`
- `views.<name>.searchFields`: Fields rendered on the front-page search screen
- `views.<name>.links`: Related view links

Column links:

- `views.<name>.columns[].link.targetView`: Link the cell to another configured view
- `views.<name>.columns[].link.urlTemplate`: Or render the cell as an external/internal URL template
- `views.<name>.columns[].link.keys`: Optional key mappings, same shape as `views.<name>.links[].keys`
- `views.<name>.columns[].link.label`: Optional label template; defaults to the formatted cell value
- `views.<name>.columns[].link.icon`: Optional icon-only link rendering (`link`, `external`, `open`, `arrow-right`, `search`, `magnifying-glass`, `file`, `document`, `info`)
- `views.<name>.columns[].link.openInNewTab`: Optional boolean for link target behavior
- `views.<name>.links[].icon`: Optional icon-only rendering for related links using the same icon names

UI config route:

- `/config/:viewName`: Per-view config screen for choosing which configured columns appear in the main table grid and in what order
- `/settings`: Settings screen for database connections and live schema scanning
- Source switching: use the top toolbar to switch between data sources and their separate views config files

Sort query parameters on `/table/:viewName`:

- `sortBy`: single column or multiple columns
- `sortDir`: single direction or multiple directions
- Multi-column query examples:
  - repeated keys: `?sortBy=ColA&sortDir=ASC&sortBy=ColB&sortDir=DESC`
  - comma-separated: `?sortBy=ColA,ColB&sortDir=ASC,DESC`

Pagination query parameter on `/table/:viewName`:

- `page`: 1-based page number for result paging

Table paging UI includes `First`, `Previous`, `Next`, `Last`, and a direct page-number jump box.

Column filter query parameters on `/table/:viewName`:

- `cf_<ColumnName>`: contains-match filter for a grid column (for example `?cf_Name=bike`)

Debug endpoint for column/key mapping issues:

- `/debug/<viewName>/keys`
- Optional `sample` query param (default `25`, max `200`)
- Accepts the same filter/sort query params as `/table/<viewName>`

Example search field object:

```json
{
  "column": "CompanyName",
  "label": "Company",
  "type": "text",
  "operator": "contains",
  "placeholder": "Name contains..."
}
```

Supported search field types:

- `text` (default): free text input, uses `operator`
- `select`: dropdown, uses exact match
- `multiSelect`: dropdown-style checkbox list, uses `IN (...)`
- `date`: date picker, uses exact match
- `dateRange`: from/to date pickers, uses `>=` and `<=`

Example `select` field:

```json
{
  "column": "Status",
  "label": "Status",
  "type": "select",
  "options": [
    { "value": "1", "label": "In Process" },
    { "value": "2", "label": "Approved" },
    { "value": "3", "label": "Backordered" }
  ]
}
```

Example date range field:

```json
{
  "column": "OrderDate",
  "label": "Order Date",
  "type": "dateRange"
}
```

Example multi-select checkbox field:

```json
{
  "column": "Status",
  "label": "Status",
  "type": "multiSelect",
  "options": [
    { "value": "1", "label": "In Process" },
    { "value": "2", "label": "Approved" },
    { "value": "3", "label": "Backordered" }
  ]
}
```

Supported operators:

- `exact`
- `contains`
- `startsWith`
- `endsWith`
- `gt`
- `gte`
- `lt`
- `lte`

Example date column formats:

```json
{ "name": "OrderDate", "label": "Order Date", "format": "date", "dateFormat": "DD/MM/YYYY" }
```

Example number column formats:

```json
{ "name": "TotalDue", "label": "Total Due", "format": "number", "precision": 2, "thousandSeparator": "," }
```

```json
{
  "name": "UnitPrice",
  "label": "Unit Price",
  "numberFormat": {
    "precision": 4,
    "useGrouping": true,
    "thousandSeparator": ",",
    "decimalSeparator": "."
  }
}
```

```json
{
  "name": "CreatedAt",
  "label": "Created",
  "format": "datetime",
  "locale": "en-US",
  "timeZone": "UTC",
  "dateFormat": {
    "year": "numeric",
    "month": "short",
    "day": "2-digit",
    "hour": "2-digit",
    "minute": "2-digit"
  }
}
```

Supported date pattern tokens:

- `YYYY`, `YY`
- `MM`, `M`
- `DD`, `D`
- `HH`, `H`
- `mm`, `m`
- `ss`, `s`

Date format precedence:

1. `views.<name>.columns[].dateFormat` (string or object)
2. `views.<name>.columns[].formatString`
3. global `ui.dateFormat` from `config/app.config.json`

Example link object:

```json
{
  "label": "Orders",
  "targetView": "orders",
  "localColumn": "CustomerID",
  "targetColumn": "CustomerID"
}
```

External-site link using URL template:

```json
{
  "label": "Track Package",
  "urlTemplate": "https://carrier.example/track/{CarrierTrackingNumber}",
  "openInNewTab": true
}
```

Link labels can include replacement tags using row fields:

```json
{
  "label": "Orders for {{CustomerID}}",
  "targetView": "orders",
  "localColumn": "CustomerID",
  "targetColumn": "CustomerID"
}
```

Supported tag forms: `{{FieldName}}` and `{FieldName}`.

For `urlTemplate`, tag values are URL-encoded and the final URL must start with `http://`, `https://`, or `/`.

Composite-key link (recommended form):

```json
{
  "label": "Order Lines",
  "targetView": "order_lines",
  "keys": [
    { "localColumn": "OrderID", "targetColumn": "OrderID" },
    { "localColumn": "LineNo", "targetColumn": "LineNo" }
  ]
}
```

Alternative composite form:

```json
{
  "label": "Order Lines",
  "targetView": "order_lines",
  "localColumns": ["OrderID", "LineNo"],
  "targetColumns": ["OrderID", "LineNo"]
}
```

Links use exact-filter query params in the target URL:

- `/table/orders?f_CustomerID=<value>` (single key)
- `/table/order_lines?f_OrderID=<value>&f_LineNo=<value>` (composite key)

Link behavior summary:

- Internal link: use `targetView` + key mapping (`keys`, or `localColumn`/`targetColumn`)
- External link: use `urlTemplate`
- Optional `openInNewTab` controls new-tab behavior (defaults to `true` for `http(s)` URLs)
