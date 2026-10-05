// Screen template editor (/settings/screens/:id).
// Edits the template as an object, shows a live preview, and lets the user click or drag on the
// preview to pick positions. On save the whole template is posted as JSON.
(() => {
  const dataElement = document.getElementById("screen-editor-data");
  const form = document.getElementById("screen-form");
  if (!dataElement || !form) {
    return;
  }
  const data = JSON.parse(dataElement.textContent);
  const root = document.getElementById("screen-editor-root");
  const previewElement = document.getElementById("screen-preview");
  const cursorElement = document.getElementById("screen-cursor");
  const addActions = document.getElementById("screen-add-actions");
  const template = data.template;
  delete template.id;

  let selection = null; // { row, col, width, height }
  let highlighted = null; // { kind, index }
  const openSections = new Set(["general", "fields"]);

  // ---------- helpers ----------

  function h(tag, attrs = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) {
        continue;
      }
      if (key === "class") {
        element.className = value;
      } else if (key.startsWith("on") && typeof value === "function") {
        element.addEventListener(key.slice(2), value);
      } else {
        element.setAttribute(key, value === true ? "" : value);
      }
    }
    for (const child of children.flat()) {
      if (child !== undefined && child !== null && child !== false) {
        element.append(child instanceof Node ? child : String(child));
      }
    }
    return element;
  }

  function sourceName() {
    return template.source || data.activeSourceName || "";
  }

  function viewInfo(viewName) {
    return (data.catalog[sourceName()] || {})[viewName] || null;
  }

  const datalists = new Map();
  function datalistFor(key, options) {
    const id = `se-list-${datalists.size}-${key.replace(/[^a-z0-9]/gi, "")}`;
    if (datalists.has(key)) {
      return datalists.get(key);
    }
    const list = h("datalist", { id }, options.map((option) => h("option", { value: option.value }, option.label)));
    document.body.append(list);
    datalists.set(key, id);
    return id;
  }

  function columnListId(viewName) {
    const info = viewInfo(viewName);
    const columns = info ? info.columns : [];
    return datalistFor(`columns:${sourceName()}:${viewName}`, columns.map((column) => ({ value: column.name, label: column.label })));
  }

  function viewListId() {
    const views = data.catalog[sourceName()] || {};
    return datalistFor(`views:${sourceName()}`, Object.entries(views).map(([name, view]) => ({ value: name, label: view.title })));
  }

  function setValue(target, key, value) {
    if (value === "" || value === undefined || value === null) {
      delete target[key];
    } else {
      target[key] = value;
    }
  }

  // ---------- generic property inputs ----------
  // spec: [key, label, type, options]
  function propInput(target, [key, label, type, options], onChange) {
    let input;
    if (type === "number") {
      input = h("input", { type: "number", min: "0", step: "1" });
      input.value = target[key] ?? "";
      input.addEventListener("input", () => {
        setValue(target, key, input.value === "" ? "" : Number(input.value));
        onChange(false);
      });
    } else if (type === "checkbox") {
      input = h("input", { type: "checkbox" });
      input.checked = Boolean(target[key]);
      input.addEventListener("change", () => {
        setValue(target, key, input.checked ? true : "");
        onChange(false);
      });
    } else if (type === "select" || type === "color") {
      const values = type === "color" ? ["", ...data.colors] : options;
      input = h("select", {}, values.map((value) => h("option", { value }, value || (type === "color" ? "(default)" : "(none)"))));
      input.value = target[key] ?? "";
      input.addEventListener("change", () => {
        setValue(target, key, input.value);
        onChange(true);
      });
    } else {
      const listId = type === "column" ? columnListId(options || template.view) : type === "view" ? viewListId() : null;
      input = h("input", { type: "text", list: listId, class: type === "column" || type === "view" || type === "wide" ? "se-wide" : "" });
      input.value = target[key] ?? "";
      input.addEventListener("input", () => {
        setValue(target, key, input.value.trim() === "" ? "" : type === "text-raw" ? input.value : input.value.trim());
        onChange(false);
      });
      input.addEventListener("change", () => onChange(true));
    }
    return h("label", {}, label, input);
  }

  function propsRow(target, specs, onChange) {
    return h("div", { class: "se-props" }, specs.map((spec) => propInput(target, spec, onChange)));
  }

  // Key mappings: [{ localColumn, targetColumn }]
  function keysEditor(owner, localView, targetViewName, onChange) {
    owner.keys = Array.isArray(owner.keys) ? owner.keys : [];
    const box = h("div", { class: "se-sub" }, h("span", { class: "se-sub-title" }, "Matching fields (this screen's column = target column)"));
    owner.keys.forEach((key, index) => {
      box.append(
        h(
          "div",
          { class: "se-props" },
          propInput(key, ["localColumn", "This record's column", "column", localView], onChange),
          propInput(key, ["targetColumn", "Target column", "column", targetViewName], onChange),
          h("button", { type: "button", class: "config-order-button", onclick: () => { owner.keys.splice(index, 1); rerender(); } }, "Remove")
        )
      );
    });
    box.append(h("div", {}, h("button", { type: "button", class: "config-order-button", onclick: () => { owner.keys.push({ localColumn: "", targetColumn: "" }); rerender(); } }, "Add matching field")));
    return box;
  }

  // Link target: another template or a table view.
  function targetEditor(owner, localView, onChange) {
    const kind = owner.targetTemplate !== undefined ? "template" : "view";
    const box = h("div", { class: "se-sub" });
    const kindSelect = h("select", {}, h("option", { value: "template" }, "Screen template"), h("option", { value: "view" }, "Table view"));
    kindSelect.value = kind;
    kindSelect.addEventListener("change", () => {
      if (kindSelect.value === "template") {
        delete owner.targetView;
        owner.targetTemplate = owner.targetTemplate || "";
      } else {
        delete owner.targetTemplate;
        owner.targetView = owner.targetView || "";
      }
      rerender();
    });
    let targetInput;
    let targetViewName = "";
    if (kind === "template") {
      targetInput = h("select", {}, h("option", { value: "" }, "Choose a template..."), data.templates.map((item) => h("option", { value: item.id }, `${item.title} (${item.id})`)));
      targetInput.value = owner.targetTemplate || "";
      targetInput.addEventListener("change", () => {
        owner.targetTemplate = targetInput.value;
        rerender();
      });
    } else {
      targetInput = h("input", { type: "text", list: viewListId(), class: "se-wide" });
      targetInput.value = owner.targetView || "";
      targetInput.addEventListener("change", () => {
        owner.targetView = targetInput.value.trim();
        rerender();
      });
      targetViewName = owner.targetView || "";
    }
    box.append(h("div", { class: "se-props" }, h("label", {}, "Opens", kindSelect), h("label", {}, "Target", targetInput)));
    box.append(keysEditor(owner, localView, targetViewName, onChange));
    return box;
  }

  function columnWarning(viewName, column) {
    const info = viewInfo(viewName);
    if (!info || !column) {
      return null;
    }
    const found = info.columns.some((item) => item.name.toLowerCase() === String(column).toLowerCase());
    return found ? null : h("span", { class: "se-warning" }, `Column "${column}" was not found in view ${viewName}.`);
  }

  // ---------- item definitions ----------

  const PLACE = [["row", "Row", "number"], ["col", "Col", "number"], ["width", "Width", "number"]];
  const COLORS = [["fg", "Text colour", "color"], ["bg", "Background", "color"]];
  const KINDS = {
    regions: {
      title: "Colour areas and boxes",
      singular: "Area",
      describe: (item) => `${item.border ? `${item.border} box` : "colour area"}${item.label ? ` "${item.label}"` : ""}`,
      body: (item, onChange) => [
        propsRow(item, [...PLACE, ["height", "Height", "number"], ...COLORS, ["border", "Border", "select", ["", "single", "double"]], ["label", "Box title", "text"]], onChange)
      ]
    },
    fields: {
      title: "Fields",
      singular: "Field",
      describe: (item) => `${item.column || "(no column)"}${item.type && item.type !== "text" ? ` [${item.type}]` : ""}`,
      body: (item, onChange) => [
        propsRow(item, [["column", "Column", "column"], ["type", "Type", "select", data.fieldTypes], ...PLACE, ["height", "Lines (memo)", "number"]], onChange),
        propsRow(
          item,
          [
            ["align", "Align", "select", ["", "left", "center", "right"]],
            ["format", "Format", "select", ["", "date", "datetime", "time", "number"]],
            ["dateFormat", "Date pattern", "text"],
            ["precision", "Decimals", "number"],
            ["thousandSeparator", "Thousands sep.", "text-raw"],
            ["upper", "Upper case", "checkbox"],
            ...COLORS,
            ["label", "Note", "wide"]
          ],
          onChange
        ),
        columnWarning(template.view, item.column)
      ]
    },
    lists: {
      title: "Embedded lists",
      singular: "List",
      describe: (item) => `${item.view || "(no view)"} (${(item.columns || []).length} columns)`,
      body: (item, onChange) => {
        item.columns = Array.isArray(item.columns) ? item.columns : [];
        const columnsBox = h("div", { class: "se-sub" }, h("span", { class: "se-sub-title" }, "Columns (left to right)"));
        item.columns.forEach((column, index) => {
          columnsBox.append(
            h(
              "div",
              { class: "se-props" },
              propInput(column, ["column", "Column", "column", item.view], onChange),
              propInput(column, ["width", "Width", "number"], onChange),
              propInput(column, ["align", "Align", "select", ["", "left", "center", "right"]], onChange),
              propInput(column, ["format", "Format", "select", ["", "date", "datetime", "time", "number"]], onChange),
              propInput(column, ["dateFormat", "Date pattern", "text"], onChange),
              h("button", { type: "button", class: "config-order-button", onclick: () => { item.columns.splice(index, 1); rerender(); } }, "Remove"),
              columnWarning(item.view, column.column)
            )
          );
        });
        columnsBox.append(h("div", {}, h("button", { type: "button", class: "config-order-button", onclick: () => { item.columns.push({ column: "", width: 10 }); rerender(); } }, "Add column")));
        const rowLinkBox = h("div", { class: "se-sub" }, h("span", { class: "se-sub-title" }, "Clicking a row opens"));
        const rowLinkToggle = h("input", { type: "checkbox" });
        rowLinkToggle.checked = Boolean(item.rowLink);
        rowLinkToggle.addEventListener("change", () => {
          item.rowLink = rowLinkToggle.checked ? { targetView: "" } : null;
          rerender();
        });
        rowLinkBox.append(h("label", {}, rowLinkToggle, " Make rows clickable"));
        if (item.rowLink) {
          rowLinkBox.append(targetEditor(item.rowLink, item.view, onChange));
        }
        return [
          propsRow(item, [["view", "View", "view"], ...PLACE, ["height", "Height", "number"], ["limit", "Max rows", "number"], ["separator", "Separator", "text-raw"]], onChange),
          propsRow(item, [...COLORS], onChange),
          sortEditor(item, onChange),
          keysEditor(item, template.view, item.view, onChange),
          columnsBox,
          rowLinkBox
        ];
      }
    },
    links: {
      title: "Links",
      singular: "Link",
      describe: (item) => `${item.label || "link"} → ${item.targetTemplate || item.targetView || "(no target)"}`,
      body: (item, onChange) => [propsRow(item, [...PLACE, ["label", "Note", "wide"]], onChange), targetEditor(item, template.view, onChange)]
    }
  };

  function sortEditor(list, onChange) {
    list.sort = list.sort || null;
    const holder = { column: list.sort?.column || "", direction: list.sort?.direction || "ASC" };
    const update = (structural) => {
      list.sort = holder.column ? { column: holder.column, direction: holder.direction || "ASC" } : null;
      onChange(structural);
    };
    return propsRow(holder, [["column", "Sort by", "column", list.view], ["direction", "Direction", "select", ["ASC", "DESC"]]], update);
  }

  // ---------- rendering the editor ----------

  function section(key, title, ...content) {
    const details = h("details", { class: "se-section", "data-section": key }, h("summary", {}, title), ...content);
    details.open = openSections.has(key);
    details.addEventListener("toggle", () => {
      if (details.open) {
        openSections.add(key);
      } else {
        openSections.delete(key);
      }
    });
    return details;
  }

  function onItemChange(structural) {
    if (structural) {
      rerender();
    } else {
      schedulePreview();
    }
  }

  function itemsSection(kind) {
    const config = KINDS[kind];
    template[kind] = Array.isArray(template[kind]) ? template[kind] : [];
    const items = template[kind].map((item, index) => {
      const isHighlighted = highlighted && highlighted.kind === kind && highlighted.index === index;
      return h(
        "div",
        { class: `se-item${isHighlighted ? " se-selected" : ""}`, "data-kind": kind, "data-index": index },
        h(
          "div",
          { class: "se-props" },
          h("strong", {}, `${config.singular} ${index + 1}: ${config.describe(item)}`),
          h("button", { type: "button", class: "config-order-button", onclick: () => { applySelection(item, kind); rerender(); } }, "Move to selection"),
          h("button", { type: "button", class: "config-order-button", onclick: () => { template[kind].splice(index, 1); highlighted = null; rerender(); } }, "Remove")
        ),
        config.body(item, onItemChange)
      );
    });
    return section(kind, `${config.title} (${template[kind].length})`, h("div", { class: "se-items" }, items.length ? items : h("p", { class: "muted" }, "None yet.")));
  }

  function generalSection() {
    template.colors = template.colors || {};
    const keysHolder = { keys: (template.keys || []).join(", ") };
    const sharedKeysHolder = { sharedKeys: (template.sharedKeys || []).join(", ") };
    const sourceSelect = h("select", {}, h("option", { value: "" }, "Any (use the current data source)"), Object.keys(data.catalog).map((name) => h("option", { value: name }, name)));
    sourceSelect.value = template.source || "";
    sourceSelect.addEventListener("change", () => {
      setValue(template, "source", sourceSelect.value);
      rerender();
    });
    const viewWarning = template.view && !viewInfo(template.view)
      ? h("span", { class: "se-warning" }, `View "${template.view}" is not configured for ${sourceName() || "this data source"} on this installation, so column names cannot be checked here.`)
      : null;
    return section(
      "general",
      "General",
      propsRow(template, [["title", "Title", "wide"], ["view", "View (record shown)", "view"]], onItemChange),
      h("div", { class: "se-props" }, h("label", {}, "Data source", sourceSelect)),
      viewWarning,
      propsRow(keysHolder, [["keys", "Record key columns (comma separated; default is the view's key column)", "wide"]], () => {
        template.keys = String(keysHolder.keys || "").split(",").map((key) => key.trim()).filter(Boolean);
        schedulePreview();
      }),
      propsRow(sharedKeysHolder, [["sharedKeys", "Shared key columns (same name in every table; added to the record key, every link and every list)", "wide"]], () => {
        template.sharedKeys = String(sharedKeysHolder.sharedKeys || "").split(",").map((key) => key.trim()).filter(Boolean);
        schedulePreview();
      }),
      propsRow(template, [["width", "Columns", "number"], ["height", "Rows", "number"]], onItemChange),
      propsRow(template.colors, [["fg", "Text colour", "color"], ["bg", "Background", "color"], ["fieldFg", "Field text", "color"], ["fieldBg", "Field background", "color"]], onItemChange)
    );
  }

  function textSection() {
    const textarea = h("textarea", { class: "se-text", rows: String(template.height || 25), cols: String(template.width || 80), wrap: "off", spellcheck: "false" });
    textarea.value = (template.text || []).join("\n");
    textarea.addEventListener("input", () => {
      template.text = textarea.value.split("\n");
      schedulePreview();
    });
    return section(
      "text",
      "Screen text (labels, lines and fixed text)",
      h("p", { class: "muted" }, "Type or paste the screen's fixed text, one line per screen row. Fields, lists and boxes are drawn on top of it."),
      textarea
    );
  }

  function jsonSection() {
    const textarea = h("textarea", { class: "se-text", rows: "16", spellcheck: "false" });
    textarea.value = JSON.stringify(template, null, 2);
    const status = h("span", { class: "muted" });
    const apply = h("button", { type: "button", onclick: () => {
      try {
        const parsed = JSON.parse(textarea.value);
        for (const key of Object.keys(template)) {
          delete template[key];
        }
        Object.assign(template, parsed);
        delete template.id;
        rerender();
      } catch (error) {
        status.textContent = `Invalid JSON: ${error.message}`;
      }
    } }, "Apply JSON");
    return section("json", "Advanced: template JSON", textarea, h("div", { class: "settings-actions" }, apply, status));
  }

  function rerender() {
    root.replaceChildren(generalSection(), textSection(), itemsSection("fields"), itemsSection("lists"), itemsSection("links"), itemsSection("regions"), jsonSection());
    schedulePreview();
  }

  // ---------- adding items ----------

  function applySelection(item, kind) {
    if (!selection) {
      return;
    }
    item.row = selection.row;
    item.col = selection.col;
    item.width = selection.width;
    if (kind === "lists" || kind === "regions" || item.type === "memo") {
      item.height = selection.height;
    }
  }

  function addItem(kind, extra = {}) {
    const item = { row: 1, col: 1, width: 10, ...extra };
    applySelection(item, kind);
    if (kind === "fields" && item.type !== "memo") {
      delete item.height;
    }
    template[kind].push(item);
    highlighted = { kind, index: template[kind].length - 1 };
    openSections.add(kind);
    rerender();
    document.querySelector(`.se-item[data-kind="${kind}"][data-index="${highlighted.index}"]`)?.scrollIntoView({ block: "nearest" });
  }

  addActions.append(
    h("button", { type: "button", onclick: () => addItem("fields", { column: "" }) }, "Add field"),
    h("button", { type: "button", onclick: () => addItem("fields", { column: "", type: "checkbox", width: 1 }) }, "Add checkbox"),
    h("button", { type: "button", onclick: () => addItem("fields", { column: "", type: "memo", height: 4 }) }, "Add memo"),
    h("button", { type: "button", onclick: () => addItem("lists", { view: "", height: 5, keys: [], columns: [] }) }, "Add list"),
    h("button", { type: "button", onclick: () => addItem("links", { targetView: "", keys: [] }) }, "Add link"),
    h("button", { type: "button", onclick: () => addItem("regions", { bg: "cyan" }) }, "Add colour area"),
    h("button", { type: "button", onclick: () => addItem("regions", { border: "single", height: 3 }) }, "Add box")
  );

  // ---------- preview and selection ----------

  let previewTimer = null;
  let previewRequest = 0;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 250);
  }

  async function refreshPreview() {
    const requestId = ++previewRequest;
    try {
      const response = await fetch(`${data.previewUrl}?source=${encodeURIComponent(data.activeSourceName || "")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template })
      });
      const result = await response.json();
      if (requestId === previewRequest) {
        previewElement.innerHTML = result.html;
        drawSelection();
      }
    } catch (error) {
      cursorElement.textContent = `Preview failed: ${error.message}`;
    }
  }

  function screenElement() {
    return previewElement.querySelector(".dos-screen");
  }

  function cellAt(event) {
    const screen = screenElement();
    if (!screen) {
      return null;
    }
    const rect = screen.getBoundingClientRect();
    const cols = Number(screen.dataset.cols);
    const rows = Number(screen.dataset.rows);
    const cellWidth = screen.clientWidth / cols;
    const cellHeight = screen.clientHeight / rows;
    const col = Math.floor((event.clientX - rect.left - screen.clientLeft) / cellWidth);
    const row = Math.floor((event.clientY - rect.top - screen.clientTop) / cellHeight);
    return { row: Math.max(0, Math.min(rows - 1, row)), col: Math.max(0, Math.min(cols - 1, col)), cellWidth, cellHeight };
  }

  function drawSelection() {
    const screen = screenElement();
    if (!screen || !selection) {
      return;
    }
    const cellWidth = screen.clientWidth / Number(screen.dataset.cols);
    const cellHeight = screen.clientHeight / Number(screen.dataset.rows);
    screen.querySelector(".screen-selection")?.remove();
    screen.append(
      h("div", {
        class: "screen-selection",
        style: `left:${selection.col * cellWidth}px;top:${selection.row * cellHeight}px;width:${selection.width * cellWidth}px;height:${selection.height * cellHeight}px`
      })
    );
  }

  function itemAt(row, col) {
    for (const kind of ["fields", "lists", "links", "regions"]) {
      const index = template[kind].findIndex((item) => {
        const height = item.height || 1;
        return row >= item.row && row < item.row + height && col >= item.col && col < item.col + (item.width || 1);
      });
      if (index >= 0) {
        return { kind, index };
      }
    }
    return null;
  }

  let dragStart = null;
  previewElement.addEventListener("click", (event) => {
    if (event.target.closest("a")) {
      event.preventDefault();
    }
  });
  previewElement.addEventListener("mousedown", (event) => {
    const cell = cellAt(event);
    if (!cell) {
      return;
    }
    event.preventDefault();
    dragStart = cell;
    selection = { row: cell.row, col: cell.col, width: 1, height: 1 };
    drawSelection();
  });
  document.addEventListener("mousemove", (event) => {
    if (!dragStart) {
      return;
    }
    const cell = cellAt(event);
    if (!cell) {
      return;
    }
    selection = {
      row: Math.min(dragStart.row, cell.row),
      col: Math.min(dragStart.col, cell.col),
      width: Math.abs(cell.col - dragStart.col) + 1,
      height: Math.abs(cell.row - dragStart.row) + 1
    };
    drawSelection();
  });
  document.addEventListener("mouseup", () => {
    if (!dragStart) {
      return;
    }
    dragStart = null;
    cursorElement.textContent = `Selected row ${selection.row}, column ${selection.col}, ${selection.width} wide × ${selection.height} high. Use an Add button, or "Move to selection" on an item.`;
    const hit = selection.width === 1 && selection.height === 1 ? itemAt(selection.row, selection.col) : null;
    if (hit) {
      highlighted = hit;
      openSections.add(hit.kind);
      rerender();
      document.querySelector(`.se-item[data-kind="${hit.kind}"][data-index="${hit.index}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });

  form.addEventListener("submit", () => {
    form.querySelector('input[name="templateJson"]').value = JSON.stringify(template);
  });

  rerender();
})();
