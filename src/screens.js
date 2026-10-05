// Screen templates: reproduce legacy DOS text-mode screens (e.g. 80x25) for a row of data.
// A template is a JSON file in the screens folder. It holds the screen's fixed text,
// colour regions (optionally boxed), and fields / lists / links placed at row and column positions.
const fs = require("fs");
const path = require("path");

// Classic 16-colour DOS (CGA) palette.
const PALETTE = {
  black: "#000000",
  blue: "#0000aa",
  green: "#00aa00",
  cyan: "#00aaaa",
  red: "#aa0000",
  magenta: "#aa00aa",
  brown: "#aa5500",
  lightgray: "#aaaaaa",
  darkgray: "#555555",
  lightblue: "#5555ff",
  lightgreen: "#55ff55",
  lightcyan: "#55ffff",
  lightred: "#ff5555",
  lightmagenta: "#ff55ff",
  yellow: "#ffff55",
  white: "#ffffff"
};
const COLOR_NAMES = Object.keys(PALETTE);

const BORDERS = {
  single: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" }
};

const FIELD_TYPES = ["text", "checkbox", "memo"];
const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CHECKED_VALUES = new Set(["1", "true", "t", "y", "yes", "o", "oui", "x", "-1"]);

// ---------- normalising ----------

function toInt(value, fallback, min = 0, max = 999) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function toColor(value, fallback = "") {
  const name = String(value || "").trim().toLowerCase();
  return PALETTE[name] ? name : fallback;
}

function toText(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalizeKeys(keys) {
  return (Array.isArray(keys) ? keys : [])
    .map((key) => ({ localColumn: toText(key?.localColumn), targetColumn: toText(key?.targetColumn) }))
    .filter((key) => key.localColumn && key.targetColumn);
}

function normalizeTarget(item) {
  const target = {};
  if (toText(item?.targetTemplate)) {
    target.targetTemplate = toText(item.targetTemplate);
  } else if (toText(item?.targetView)) {
    target.targetView = toText(item.targetView);
  }
  const keys = normalizeKeys(item?.keys);
  if (keys.length) {
    target.keys = keys;
  }
  return target;
}

// Keeps any extra properties (e.g. dateFormat, precision) so formatting options pass through.
function normalizePlacement(item, width, height) {
  return {
    ...item,
    row: toInt(item?.row, 0, 0, height - 1),
    col: toInt(item?.col, 0, 0, width - 1),
    width: toInt(item?.width, 1, 1, width),
    fg: toColor(item?.fg),
    bg: toColor(item?.bg)
  };
}

function normalizeTemplate(raw, id = "") {
  const source = raw && typeof raw === "object" ? raw : {};
  const width = toInt(source.width, 80, 20, 200);
  const height = toInt(source.height, 25, 5, 100);
  const textLines = Array.isArray(source.text) ? source.text.map((line) => String(line ?? "")) : String(source.text || "").split(/\r?\n/);

  const fields = (Array.isArray(source.fields) ? source.fields : []).map((field) => {
    const placed = normalizePlacement(field, width, height);
    const type = FIELD_TYPES.includes(field?.type) ? field.type : "text";
    return {
      ...placed,
      column: toText(field?.column),
      type,
      height: type === "memo" ? toInt(field?.height, 3, 1, height) : 1,
      width: type === "checkbox" ? 1 : placed.width
    };
  });

  const lists = (Array.isArray(source.lists) ? source.lists : []).map((list) => ({
    ...normalizePlacement(list, width, height),
    height: toInt(list?.height, 3, 1, height),
    view: toText(list?.view),
    keys: normalizeKeys(list?.keys),
    columns: (Array.isArray(list?.columns) ? list.columns : [])
      .map((column) => ({ ...column, column: toText(column?.column), width: toInt(column?.width, 8, 1, width) }))
      .filter((column) => column.column),
    separator: typeof list?.separator === "string" ? list.separator.slice(0, 3) : " ",
    sort: list?.sort && toText(list.sort.column) ? { column: toText(list.sort.column), direction: list.sort.direction === "DESC" ? "DESC" : "ASC" } : null,
    limit: toInt(list?.limit, 200, 1, 2000),
    rowLink: list?.rowLink ? normalizeTarget(list.rowLink) : null
  }));

  const links = (Array.isArray(source.links) ? source.links : [])
    .map((link) => ({ ...normalizePlacement(link, width, height), label: toText(link?.label), ...normalizeTarget(link) }))
    .filter((link) => link.targetTemplate || link.targetView);

  const regions = (Array.isArray(source.regions) ? source.regions : []).map((region) => ({
    ...normalizePlacement(region, width, height),
    height: toInt(region?.height, 1, 1, height),
    border: BORDERS[region?.border] ? region.border : ""
  }));

  return {
    id: id || toText(source.id),
    title: toText(source.title) || id || "Untitled screen",
    description: toText(source.description),
    source: toText(source.source),
    view: toText(source.view),
    keys: (Array.isArray(source.keys) ? source.keys : []).map(toText).filter(Boolean),
    // Columns with the same name in every table (e.g. a line of business tagged at import).
    // They identify the record together with `keys` and are carried through every link and list.
    sharedKeys: (Array.isArray(source.sharedKeys) ? source.sharedKeys : []).map(toText).filter(Boolean),
    width,
    height,
    colors: {
      fg: toColor(source.colors?.fg, "yellow"),
      bg: toColor(source.colors?.bg, "blue"),
      fieldFg: toColor(source.colors?.fieldFg, "white"),
      fieldBg: toColor(source.colors?.fieldBg, "cyan")
    },
    text: Array.from({ length: height }, (_, index) => textLines[index] || ""),
    regions,
    fields,
    lists,
    links
  };
}

// ---------- storage ----------

function isValidTemplateId(id) {
  return TEMPLATE_ID_PATTERN.test(String(id || ""));
}

function templatePath(dir, id) {
  if (!isValidTemplateId(id)) {
    throw new Error(`Invalid template id: ${id}`);
  }
  return path.join(dir, `${id}.json`);
}

function listTemplates(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .map((name) => {
      const id = name.slice(0, -5);
      if (!isValidTemplateId(id)) {
        return null;
      }
      try {
        return normalizeTemplate(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")), id);
      } catch (error) {
        return { id, title: id, error: error.message, invalid: true };
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.title).localeCompare(String(b.title)));
}

function loadTemplate(dir, id) {
  if (!isValidTemplateId(id)) {
    return null;
  }
  const filePath = templatePath(dir, id);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return normalizeTemplate(JSON.parse(fs.readFileSync(filePath, "utf8")), id);
}

function saveTemplate(dir, template) {
  fs.mkdirSync(dir, { recursive: true });
  const { id, ...content } = normalizeTemplate(template, template.id);
  fs.writeFileSync(templatePath(dir, id), `${JSON.stringify(content, null, 2)}\n`, "utf8");
}

function deleteTemplate(dir, id) {
  const filePath = templatePath(dir, id);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// ---------- rendering ----------

function isChecked(value, field) {
  if (Array.isArray(field.checkedValues) && field.checkedValues.length) {
    return field.checkedValues.map(String).includes(String(value ?? "").trim());
  }
  if (typeof value === "boolean") {
    return value;
  }
  return CHECKED_VALUES.has(String(value ?? "").trim().toLowerCase());
}

function fitText(text, width, align = "left") {
  const value = String(text ?? "").replace(/[\r\n\t]+/g, " ");
  if (value.length >= width) {
    return align === "right" ? value.slice(value.length - width) : value.slice(0, width);
  }
  const gap = width - value.length;
  if (align === "right") {
    return " ".repeat(gap) + value;
  }
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return " ".repeat(left) + value + " ".repeat(gap - left);
  }
  return value + " ".repeat(gap);
}

// ctx: {
//   escapeHtml, preview (bool),
//   fieldText(field) -> string,           // formatted value for a text / memo field
//   fieldRaw(field) -> any,               // raw value (checkboxes)
//   isKnownColumn(column) -> bool,         // preview: flag columns missing from the view
//   linkUrl(link) -> url | null,
//   listRows(listIndex) -> { rows: [cellTexts[]], urls: [url|null], error }
// }
function renderScreen(template, ctx) {
  const { width, height, colors } = template;
  const escapeHtml = ctx.escapeHtml;
  const grid = Array.from({ length: height }, (_, row) => {
    const line = template.text[row] || "";
    return Array.from({ length: width }, (_, col) => ({ ch: line[col] || " ", fg: colors.fg, bg: colors.bg, href: "", cls: "" }));
  });
  const put = (row, col, text, attrs = {}) => {
    if (row < 0 || row >= height) {
      return;
    }
    for (let index = 0; index < text.length; index += 1) {
      const cell = grid[row][col + index];
      if (!cell) {
        break;
      }
      cell.ch = text[index];
      Object.assign(cell, attrs);
    }
  };
  const paint = (row, col, w, h, attrs) => {
    for (let r = row; r < Math.min(height, row + h); r += 1) {
      for (let c = col; c < Math.min(width, col + w); c += 1) {
        Object.assign(grid[r][c], attrs);
      }
    }
  };
  const colorAttrs = (item, fallbackFg, fallbackBg) => ({ fg: item.fg || fallbackFg, bg: item.bg || fallbackBg });

  for (const region of template.regions) {
    const attrs = {};
    if (region.fg) {
      attrs.fg = region.fg;
    }
    if (region.bg) {
      attrs.bg = region.bg;
    }
    paint(region.row, region.col, region.width, region.height, attrs);
    const border = BORDERS[region.border];
    if (border && region.width >= 2 && region.height >= 2) {
      const right = region.col + region.width - 1;
      const bottom = region.row + region.height - 1;
      put(region.row, region.col, border.tl + border.h.repeat(region.width - 2) + border.tr);
      put(bottom, region.col, border.bl + border.h.repeat(region.width - 2) + border.br);
      for (let r = region.row + 1; r < bottom; r += 1) {
        put(r, region.col, border.v);
        put(r, right, border.v);
      }
      if (region.label) {
        put(region.row, region.col + Math.max(1, Math.floor((region.width - region.label.length - 2) / 2)), ` ${region.label} `);
      }
    }
  }

  const overlays = [];
  const overlayStyle = (item, h) =>
    `left:${item.col}ch;top:calc(${item.row} * var(--dos-line));width:${item.width}ch;height:calc(${h} * var(--dos-line))`;

  template.fields.forEach((field) => {
    const attrs = colorAttrs(field, colors.fieldFg, colors.fieldBg);
    const unmapped = ctx.preview && field.column && ctx.isKnownColumn && !ctx.isKnownColumn(field.column);
    const cls = unmapped ? "dos-unmapped" : "";
    if (field.type === "checkbox") {
      const mark = ctx.preview ? "?" : isChecked(ctx.fieldRaw(field), field) ? "X" : " ";
      put(field.row, field.col, mark, { ...attrs, cls });
      return;
    }
    if (field.type === "memo") {
      paint(field.row, field.col, field.width, field.height, { ...attrs, ch: " " });
      const text = ctx.preview ? `[${field.column || "memo"}]` : ctx.fieldText(field);
      overlays.push(
        `<div class="dos-overlay dos-memo dos-fg-${attrs.fg} dos-bg-${attrs.bg}${cls ? ` ${cls}` : ""}" style="${overlayStyle(field, field.height)}">${escapeHtml(text)}</div>`
      );
      return;
    }
    const text = ctx.preview ? (field.column || "?").padEnd(field.width, "·") : ctx.fieldText(field);
    put(field.row, field.col, fitText(text, field.width, ctx.preview ? "left" : field.align), { ...attrs, cls });
  });

  template.lists.forEach((list, listIndex) => {
    const attrs = colorAttrs(list, "black", "lightgray");
    paint(list.row, list.col, list.width, list.height, { ...attrs, ch: " " });
    const result = ctx.listRows(listIndex) || { rows: [], urls: [] };
    const lines = result.error
      ? [`<div class="dos-line dos-fg-lightred">${escapeHtml(fitText(result.error, list.width))}</div>`]
      : result.rows.map((cells, rowIndex) => {
          const text = list.columns
            .map((column, columnIndex) => fitText(cells[columnIndex], column.width, ctx.preview ? "left" : column.align))
            .join(list.separator);
          const url = result.urls?.[rowIndex];
          return url
            ? `<a class="dos-line dos-line-link" href="${escapeHtml(url)}">${escapeHtml(text)}</a>`
            : `<div class="dos-line">${escapeHtml(text)}</div>`;
        });
    overlays.push(
      `<div class="dos-overlay dos-list dos-fg-${attrs.fg} dos-bg-${attrs.bg}" style="${overlayStyle(list, list.height)}">${lines.join("")}</div>`
    );
  });

  for (const link of template.links) {
    const href = ctx.preview ? "#" : ctx.linkUrl(link);
    if (!href) {
      continue;
    }
    for (let c = link.col; c < Math.min(width, link.col + link.width); c += 1) {
      grid[link.row][c].href = href;
    }
  }

  const rowsHtml = grid
    .map((cells) => {
      let html = "";
      let run = null;
      const flush = () => {
        if (!run) {
          return;
        }
        const classes = `dos-fg-${run.fg} dos-bg-${run.bg}${run.cls ? ` ${run.cls}` : ""}`;
        const text = escapeHtml(run.text);
        html += run.href
          ? `<a class="dos-link ${classes}" href="${escapeHtml(run.href)}">${text}</a>`
          : `<span class="${classes}">${text}</span>`;
        run = null;
      };
      for (const cell of cells) {
        if (run && run.fg === cell.fg && run.bg === cell.bg && run.href === cell.href && run.cls === cell.cls) {
          run.text += cell.ch;
        } else {
          flush();
          run = { fg: cell.fg, bg: cell.bg, href: cell.href, cls: cell.cls, text: cell.ch };
        }
      }
      flush();
      return `<div class="dos-row">${html}</div>`;
    })
    .join("");

  return `<div class="dos-screen dos-bg-${colors.bg}" style="--dos-cols:${width};--dos-rows:${height}" data-cols="${width}" data-rows="${height}">${rowsHtml}${overlays.join("")}</div>`;
}

function renderScreenCss() {
  const colorRules = COLOR_NAMES.map(
    (name) => `.dos-fg-${name}{color:${PALETTE[name]}}.dos-bg-${name}{background-color:${PALETTE[name]}}`
  ).join("\n");
  return `
.dos-screen {
  --dos-line: 1.25em;
  position: relative;
  display: inline-block;
  font-family: "Cascadia Mono", Consolas, "Lucida Console", "Courier New", monospace;
  font-size: 16px;
  line-height: var(--dos-line);
  white-space: pre;
  padding: 0;
  border: 6px solid #222;
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  user-select: text;
}
.dos-row { height: var(--dos-line); }
.dos-row > span, .dos-row > a { display: inline; }
.dos-link { text-decoration: none; cursor: pointer; }
.dos-link:hover, .dos-link:focus { outline: 1px solid #ffff55; text-decoration: none; }
.dos-overlay { position: absolute; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin; }
.dos-memo { white-space: pre-wrap; word-break: break-word; }
.dos-line { display: block; height: var(--dos-line); white-space: pre; color: inherit; text-decoration: none; }
.dos-line-link:hover, .dos-line-link:focus { background: #000080; color: #ffffff; }
.dos-unmapped { text-decoration: underline wavy #ff5555; }
${colorRules}`;
}

module.exports = {
  PALETTE,
  COLOR_NAMES,
  FIELD_TYPES,
  normalizeTemplate,
  isValidTemplateId,
  listTemplates,
  loadTemplate,
  saveTemplate,
  deleteTemplate,
  renderScreen,
  renderScreenCss,
  fitText
};
