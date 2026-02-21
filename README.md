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

## Project Structure

- `src/server.js`: Express app and DB query logic
- `config/app.config.json`: Database connection config
- `config/views.config.json`: Table view + link definitions

## Setup

1. Install dependencies:

```bash
npm install
```

2. Set database type and connection in `config/app.config.json`.

3. Update view definitions in `config/views.config.json` to match your schema/tables.

## Run

```bash
npm start
```

Open `http://localhost:3000`

## Generate Config From SQL Server DDL

You can generate a starter `views.config.json` structure from a SQL Server DDL file:

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

Select engine with:

- `database.type`: `"sqlserver"` or `"duckdb"`

DuckDB settings:

- `database.duckdb.path`: path to `.duckdb` file (or `":memory:"`)

SQL Server settings:

- `database.sqlserver.server`
- `database.sqlserver.database`
- `database.sqlserver.user`
- `database.sqlserver.password`
- `database.sqlserver.port`
- `database.sqlserver.options`

Environment overrides:

- `DB_TYPE`, `DB_SERVER`, `DB_DATABASE`, `DB_USER`, `DB_PASSWORD`, `DB_PORT`, `DUCKDB_PATH`

## Configuration Model

`views.config.json` format:

- `views.<name>.schema`: SQL schema (used for SQL Server; optional for DuckDB)
- `views.<name>.table`: SQL table name
- `views.<name>.columns`: Columns shown in the table
- `views.<name>.columns[].format`: Optional cell formatter (`date`, `datetime`, `time`)
- `views.<name>.columns[].dateFormat`: Optional date format, either:
  - string pattern (for example `DD/MM/YYYY`)
  - `Intl.DateTimeFormat` options object
- `views.<name>.columns[].locale`: Optional locale (for date/time formatting)
- `views.<name>.columns[].timeZone`: Optional time zone (for date/time formatting)
- `views.<name>.defaultSort`: Default ordering
- `views.<name>.searchFields`: Fields rendered on the front-page search screen
- `views.<name>.links`: Related view links

Example search field object:

```json
{
  "column": "CompanyName",
  "label": "Company",
  "operator": "contains",
  "placeholder": "Name contains..."
}
```

Supported operators:

- `exact`
- `contains`
- `startsWith`
- `endsWith`

Example date column formats:

```json
{ "name": "OrderDate", "label": "Order Date", "format": "date", "dateFormat": "DD/MM/YYYY" }
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

Example link object:

```json
{
  "label": "Orders",
  "targetView": "orders",
  "localColumn": "CustomerID",
  "targetColumn": "CustomerID"
}
```

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
