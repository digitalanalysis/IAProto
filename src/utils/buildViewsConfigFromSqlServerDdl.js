function stripSqlComments(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "");
}

function unquoteSqlIdentifier(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  if (text.startsWith("[") && text.endsWith("]")) {
    return text.slice(1, -1).replaceAll("]]", "]");
  }

  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replaceAll('""', '"');
  }

  return text;
}

function splitQualifiedIdentifier(value) {
  const input = String(value || "").trim();
  const parts = [];
  let i = 0;

  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) {
      i += 1;
    }
    if (i >= input.length) {
      break;
    }

    if (input[i] === "[") {
      const end = input.indexOf("]", i + 1);
      if (end === -1) {
        break;
      }
      parts.push(unquoteSqlIdentifier(input.slice(i, end + 1)));
      i = end + 1;
    } else if (input[i] === '"') {
      const end = input.indexOf('"', i + 1);
      if (end === -1) {
        break;
      }
      parts.push(unquoteSqlIdentifier(input.slice(i, end + 1)));
      i = end + 1;
    } else {
      let end = i;
      while (end < input.length && input[end] !== ".") {
        end += 1;
      }
      parts.push(unquoteSqlIdentifier(input.slice(i, end)));
      i = end;
    }

    if (input[i] === ".") {
      i += 1;
    }
  }

  return parts.filter(Boolean);
}

function parseSchemaAndTable(rawName) {
  const parts = splitQualifiedIdentifier(rawName);
  if (!parts.length) {
    return { schema: "dbo", table: "" };
  }
  if (parts.length === 1) {
    return { schema: "dbo", table: parts[0] };
  }
  return { schema: parts[parts.length - 2], table: parts[parts.length - 1] };
}

function extractCreateTableBlocks(ddl) {
  const source = stripSqlComments(ddl);
  const blocks = [];
  const createRegex = /\bCREATE\s+TABLE\b/gi;
  let match;

  while ((match = createRegex.exec(source)) !== null) {
    let i = match.index + match[0].length;
    while (i < source.length && /\s/.test(source[i])) {
      i += 1;
    }

    const nameStart = i;
    while (i < source.length && source[i] !== "(") {
      i += 1;
    }
    if (i >= source.length) {
      break;
    }

    const rawTableName = source.slice(nameStart, i).trim();
    const openParen = i;
    let depth = 0;
    let closeParen = -1;

    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          closeParen = i;
          break;
        }
      }
    }

    if (closeParen === -1) {
      continue;
    }

    blocks.push({
      rawTableName,
      body: source.slice(openParen + 1, closeParen)
    });
  }

  return blocks;
}

function splitTopLevelComma(text) {
  const items = [];
  let start = 0;
  let depth = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
    } else if (ch === "," && depth === 0) {
      items.push(text.slice(start, i));
      start = i + 1;
    }
  }

  items.push(text.slice(start));
  return items;
}

function toLabel(name) {
  return String(name || "")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function toViewKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseColumnDefinition(definition) {
  const line = String(definition || "").trim();
  if (!line) {
    return null;
  }

  if (
    /^(constraint|primary\s+key|foreign\s+key|unique|check|index)\b/i.test(line)
  ) {
    return null;
  }

  let name;
  let remainder;

  if (line.startsWith("[")) {
    const end = line.indexOf("]");
    if (end === -1) {
      return null;
    }
    name = unquoteSqlIdentifier(line.slice(0, end + 1));
    remainder = line.slice(end + 1).trim();
  } else if (line.startsWith('"')) {
    const end = line.indexOf('"', 1);
    if (end === -1) {
      return null;
    }
    name = unquoteSqlIdentifier(line.slice(0, end + 1));
    remainder = line.slice(end + 1).trim();
  } else {
    const match = line.match(/^([^\s]+)\s+([\s\S]+)$/);
    if (!match) {
      return null;
    }
    name = unquoteSqlIdentifier(match[1]);
    remainder = match[2].trim();
  }

  if (!name || !remainder || /^as\b/i.test(remainder)) {
    return null;
  }

  const typeMatch = remainder.match(/^([a-zA-Z0-9_]+)/);
  const sqlType = typeMatch ? typeMatch[1].toLowerCase() : "nvarchar";

  return {
    name,
    label: toLabel(name),
    sqlType,
    isPrimaryKey: /\bprimary\s+key\b/i.test(remainder)
  };
}

function parsePrimaryKeyFromTableBody(body) {
  const inlinePk = body.match(/\bPRIMARY\s+KEY\b[^\(]*\(([\s\S]*?)\)/i);
  if (!inlinePk) {
    return null;
  }
  const firstCol = splitTopLevelComma(inlinePk[1])[0];
  if (!firstCol) {
    return null;
  }
  return unquoteSqlIdentifier(firstCol.trim().replace(/\bASC\b|\bDESC\b/gi, "").trim());
}

function inferSearchOperator(sqlType, columnName) {
  if (/id$/i.test(columnName)) {
    return "exact";
  }

  if (
    /^(char|nchar|varchar|nvarchar|text|ntext)$/i.test(sqlType)
  ) {
    return "contains";
  }

  return "exact";
}

function inferColumnFormat(sqlType) {
  if (/^(date)$/i.test(sqlType)) {
    return "date";
  }
  if (/^(datetime|datetime2|smalldatetime|datetimeoffset)$/i.test(sqlType)) {
    return "datetime";
  }
  if (/^(time)$/i.test(sqlType)) {
    return "time";
  }
  return null;
}

function buildViewFromTableBlock(block, options) {
  const tableInfo = parseSchemaAndTable(block.rawTableName);
  if (!tableInfo.table) {
    return null;
  }

  const parts = splitTopLevelComma(block.body)
    .map((item) => parseColumnDefinition(item))
    .filter(Boolean);

  if (!parts.length) {
    return null;
  }

  const keyFromConstraint = parsePrimaryKeyFromTableBody(block.body);
  const keyFromColumn = parts.find((col) => col.isPrimaryKey)?.name;
  const keyFromName = parts.find((col) => /id$/i.test(col.name))?.name;
  const keyColumn = keyFromConstraint || keyFromColumn || keyFromName || parts[0].name;

  const searchable = parts
    .slice(0, options.maxSearchFields)
    .map((col) => ({
      column: col.name,
      label: col.label,
      operator: inferSearchOperator(col.sqlType, col.name),
      placeholder: `Search ${col.label}...`
    }));

  return {
    key: toViewKey(tableInfo.table),
    view: {
      title: toLabel(tableInfo.table),
      schema: tableInfo.schema,
      table: tableInfo.table,
      keyColumn,
      limit: options.limit,
      defaultSort: {
        column: keyColumn,
        direction: "ASC"
      },
      columns: parts.map((col) => {
        const format = inferColumnFormat(col.sqlType);
        if (!format) {
          return { name: col.name, label: col.label };
        }
        return { name: col.name, label: col.label, format };
      }),
      searchFields: searchable,
      links: []
    }
  };
}

function buildViewsConfigFromSqlServerDdl(ddl, options = {}) {
  const normalizedOptions = {
    limit: Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 200,
    maxSearchFields:
      Number.isInteger(options.maxSearchFields) && options.maxSearchFields > 0
        ? options.maxSearchFields
        : 3
  };

  const tables = extractCreateTableBlocks(ddl);
  const views = {};

  for (const table of tables) {
    const parsed = buildViewFromTableBlock(table, normalizedOptions);
    if (!parsed) {
      continue;
    }

    let key = parsed.key || "view";
    let suffix = 1;
    while (views[key]) {
      suffix += 1;
      key = `${parsed.key}_${suffix}`;
    }

    views[key] = parsed.view;
  }

  return { views };
}

module.exports = {
  buildViewsConfigFromSqlServerDdl
};
