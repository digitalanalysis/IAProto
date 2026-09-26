// Structured editors for the view config screen (/config/:viewName).
// The form still posts the same JSON fields (searchFieldsJson, linksJson, columnJson);
// these editors keep those hidden textareas in sync so the server-side handling is unchanged.
// Properties the editors do not expose are preserved as-is.
(() => {
  const dataElement = document.getElementById("config-editor-data");
  const form = document.getElementById("view-config-form");
  if (!dataElement || !form) {
    return;
  }
  const data = JSON.parse(dataElement.textContent);
  const localColumns = data.localColumns || [];
  const views = data.views || [];
  const viewsByName = new Map(views.map((view) => [view.name, view]));
  const iconNames = data.icons || [];

  const SEARCH_TYPES = [
    { value: "text", label: "Text" },
    { value: "select", label: "Dropdown (single value)" },
    { value: "multiSelect", label: "Checkbox list (multiple values)" },
    { value: "date", label: "Date" },
    { value: "dateRange", label: "Date range" },
    { value: "number", label: "Number" },
    { value: "numberRange", label: "Number range" }
  ];
  const TEXT_OPERATORS = [
    { value: "contains", label: "Contains" },
    { value: "startsWith", label: "Starts with" },
    { value: "endsWith", label: "Ends with" },
    { value: "exact", label: "Exact match" }
  ];
  const RANGE_OPERATORS = [
    { value: "exact", label: "Exact" },
    { value: "before", label: "Before / at most" },
    { value: "after", label: "After / at least" },
    { value: "between", label: "Between" }
  ];

  // ---------- DOM helpers ----------

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
      if (child === undefined || child === null || child === false) {
        continue;
      }
      element.append(child instanceof Node ? child : String(child));
    }
    return element;
  }

  function selectInput(options, value, onChange, attrs = {}) {
    const element = h(
      "select",
      attrs,
      options.map((option) => h("option", { value: option.value }, option.label))
    );
    const wanted = value === undefined || value === null ? "" : String(value);
    element.value = wanted;
    if (element.value !== wanted) {
      // Keep values that are configured but not found in the known schema.
      element.append(h("option", { value: wanted }, `${wanted} (not found)`));
      element.value = wanted;
    }
    element.addEventListener("change", () => onChange(element.value));
    return element;
  }

  function textInput(value, onInput, attrs = {}) {
    const element = h("input", { type: "text", ...attrs });
    element.value = value === undefined || value === null ? "" : String(value);
    element.addEventListener("input", () => onInput(element.value));
    return element;
  }

  function field(label, control, hint = "") {
    return h("label", { class: "ce-field" }, h("span", { class: "ce-field-label" }, label), control, hint ? h("span", { class: "muted" }, hint) : null);
  }

  function setOrDelete(target, key, value) {
    if (value === undefined || value === null || value === "") {
      delete target[key];
    } else {
      target[key] = value;
    }
  }

  function columnLabel(column) {
    return column.label && column.label !== column.name ? `${column.label} (${column.name})` : column.name;
  }

  function columnOptions(columns, placeholder) {
    return [{ value: "", label: placeholder }, ...columns.map((column) => ({ value: column.name, label: columnLabel(column) }))];
  }

  // A dropdown that inserts {FieldName} into a text input at the cursor.
  function insertFieldControl(input, onInsert) {
    const insertSelect = selectInput(columnOptions(localColumns, "Insert field..."), "", (value) => {
      if (!value) {
        return;
      }
      const tag = `{${value}}`;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, start) + tag + input.value.slice(end);
      onInsert(input.value);
      insertSelect.value = "";
      input.focus();
    }, { class: "ce-insert", "aria-label": "Insert field" });
    return insertSelect;
  }

  function iconButton(text, onClick, attrs = {}) {
    return h("button", { type: "button", class: "config-order-button", onclick: onClick, ...attrs }, text);
  }

  function parseTextareaJson(textarea, fallback) {
    try {
      const value = JSON.parse(textarea.value || "null");
      return value === null ? fallback : value;
    } catch {
      return undefined;
    }
  }

  // Generic ordered list of cards with Up / Down / Remove.
  function listEditor({ mount, items, renderItem, createItem, addLabel, emptyText, titleFor }) {
    function render() {
      mount.replaceChildren();
      if (!items.length) {
        mount.append(h("p", { class: "muted" }, emptyText));
      }
      items.forEach((item, index) => {
        const card = h(
          "div",
          { class: "ce-card" },
          h(
            "div",
            { class: "ce-card-head" },
            h("strong", { class: "ce-card-title" }, titleFor(item, index)),
            h(
              "span",
              { class: "config-order-controls" },
              iconButton("Up", () => move(index, -1), { disabled: index === 0 }),
              iconButton("Down", () => move(index, 1), { disabled: index === items.length - 1 }),
              iconButton("Remove", () => {
                items.splice(index, 1);
                render();
              })
            )
          ),
          renderItem(item, () => {
            card.querySelector(".ce-card-title").textContent = titleFor(item, index);
          })
        );
        mount.append(card);
      });
      mount.append(
        h("div", { class: "config-actions" }, h("button", { type: "button", onclick: () => {
          items.push(createItem());
          render();
          const cards = mount.querySelectorAll(".ce-card");
          cards[cards.length - 1]?.querySelector("select, input")?.focus();
        } }, addLabel))
      );
    }
    function move(index, delta) {
      const target = index + delta;
      if (target < 0 || target >= items.length) {
        return;
      }
      [items[index], items[target]] = [items[target], items[index]];
      render();
    }
    render();
  }

  // ---------- Links ----------

  function normalizeLinkKeys(link) {
    if (!Array.isArray(link.keys)) {
      let keys = [];
      if (Array.isArray(link.localColumns) && Array.isArray(link.targetColumns)) {
        keys = link.localColumns.map((localColumn, index) => ({ localColumn, targetColumn: link.targetColumns[index] || "" }));
      } else if (link.localColumn || link.targetColumn) {
        keys = [{ localColumn: link.localColumn || "", targetColumn: link.targetColumn || "" }];
      }
      if (keys.length) {
        link.keys = keys;
      }
    }
    delete link.localColumns;
    delete link.targetColumns;
    delete link.localColumn;
    delete link.targetColumn;
  }

  function suggestKeys(targetView) {
    const localNames = new Set(localColumns.map((column) => column.name.toLowerCase()));
    const candidates = [targetView.keyColumn, ...targetView.columns.filter((column) => column.pk).map((column) => column.name)]
      .filter(Boolean)
      .filter((name) => localNames.has(String(name).toLowerCase()));
    const unique = [...new Set(candidates)];
    if (!unique.length) {
      return [{ localColumn: "", targetColumn: "" }];
    }
    return unique.map((name) => ({
      localColumn: localColumns.find((column) => column.name.toLowerCase() === String(name).toLowerCase()).name,
      targetColumn: name
    }));
  }

  function linkTitle(link, index, fallback = "Link") {
    const destination = link.targetView
      ? viewsByName.get(link.targetView)?.title || link.targetView
      : link.urlTemplate || "";
    const label = link.label || "";
    return `${index + 1}. ${label || fallback}${destination ? ` → ${destination}` : ""}`;
  }

  function renderLinkEditor(link, onChange, { isCellLink = false } = {}) {
    normalizeLinkKeys(link);
    let mode = link.urlTemplate && !link.targetView ? "url" : "view";
    const body = h("div", { class: "ce-body" });

    function render() {
      body.replaceChildren();

      const labelInput = textInput(link.label, (value) => {
        setOrDelete(link, "label", value);
        onChange();
      }, { placeholder: isCellLink ? "Defaults to the cell value" : "e.g. Orders for {CustomerID}" });
      body.append(
        h(
          "div",
          { class: "form-grid" },
          field(isCellLink ? "Link text (optional)" : "Label", h("div", { class: "ce-inline" }, labelInput, insertFieldControl(labelInput, (value) => {
            setOrDelete(link, "label", value);
            onChange();
          })), "Use {FieldName} to include values from the row."),
          field("Link to", selectInput([
            { value: "view", label: "Another view in this app" },
            { value: "url", label: "A URL (web page or file)" }
          ], mode, (value) => {
            mode = value;
            if (mode === "url") {
              delete link.targetView;
              delete link.keys;
              link.urlTemplate = link.urlTemplate || "";
            } else {
              delete link.urlTemplate;
            }
            render();
            onChange();
          }))
        )
      );

      if (mode === "view") {
        const viewOptions = [
          { value: "", label: "Choose a view..." },
          ...views.map((view) => ({ value: view.name, label: view.title && view.title !== view.name ? `${view.title} (${view.name})` : view.name }))
        ];
        body.append(
          h("div", { class: "form-grid" }, field("Target view", selectInput(viewOptions, link.targetView, (value) => {
            setOrDelete(link, "targetView", value);
            const targetView = viewsByName.get(value);
            const hasKeys = (link.keys || []).some((key) => key.localColumn || key.targetColumn);
            if (targetView && !hasKeys) {
              link.keys = suggestKeys(targetView);
            }
            render();
            onChange();
          }, { required: true })))
        );

        const targetView = viewsByName.get(link.targetView);
        if (targetView) {
          if (!Array.isArray(link.keys) || !link.keys.length) {
            link.keys = [{ localColumn: "", targetColumn: "" }];
          }
          const keyRows = link.keys.map((key, index) =>
            h(
              "div",
              { class: "ce-key-row" },
              selectInput(columnOptions(localColumns, "Field in this view..."), key.localColumn, (value) => {
                key.localColumn = value;
                onChange();
              }, { required: true, "aria-label": "Field in this view" }),
              h("span", { class: "ce-arrow" }, "matches"),
              selectInput(columnOptions(targetView.columns, `Field in ${targetView.title || targetView.name}...`), key.targetColumn, (value) => {
                key.targetColumn = value;
                onChange();
              }, { required: true, "aria-label": "Field in target view" }),
              iconButton("Remove", () => {
                link.keys.splice(index, 1);
                render();
                onChange();
              }, { disabled: link.keys.length === 1 })
            )
          );
          body.append(
            h(
              "div",
              { class: "ce-keys" },
              h("span", { class: "ce-field-label" }, "Matching fields"),
              h("span", { class: "muted" }, "The target view is filtered to rows where these fields match the current row."),
              keyRows,
              h("div", {}, iconButton("Add matching field", () => {
                link.keys.push({ localColumn: "", targetColumn: "" });
                render();
                onChange();
              }))
            )
          );
        }
      } else {
        const urlInput = textInput(link.urlTemplate, (value) => {
          link.urlTemplate = value;
          onChange();
        }, { placeholder: "https://example.com/item/{ItemID}", required: true });
        body.append(
          h("div", { class: "form-grid" }, field("URL", h("div", { class: "ce-inline" }, urlInput, insertFieldControl(urlInput, (value) => {
            link.urlTemplate = value;
            onChange();
          })), "Must start with http://, https:// or /. Field values are URL-encoded."))
        );
      }

      const openValue = link.openInNewTab === true ? "yes" : link.openInNewTab === false ? "no" : "";
      body.append(
        h(
          "div",
          { class: "form-grid" },
          field("Display as", selectInput(
            [{ value: "", label: "Text" }, ...iconNames.map((name) => ({ value: name, label: `Icon: ${name}` }))],
            link.icon,
            (value) => {
              setOrDelete(link, "icon", value);
              onChange();
            }
          )),
          field("Open in new tab", selectInput(
            [
              { value: "", label: "Default (new tab for web addresses)" },
              { value: "yes", label: "Yes" },
              { value: "no", label: "No" }
            ],
            openValue,
            (value) => {
              setOrDelete(link, "openInNewTab", value === "yes" ? true : value === "no" ? false : "");
              onChange();
            }
          ))
        )
      );
    }

    render();
    return body;
  }

  function cleanLink(link) {
    if (Array.isArray(link.keys)) {
      link.keys = link.keys.filter((key) => key.localColumn && key.targetColumn);
      if (!link.keys.length) {
        delete link.keys;
      }
    }
    return link;
  }

  // ---------- Search fields ----------

  function normalizeSearchType(value) {
    switch (String(value || "text").toLowerCase()) {
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
      case "number":
      case "numeric":
        return "number";
      case "daterange":
      case "date_range":
      case "range":
        return "dateRange";
      case "numberrange":
      case "number_range":
        return "numberRange";
      default:
        return "text";
    }
  }

  function searchFieldType(searchField) {
    return normalizeSearchType(searchField.type !== undefined && searchField.type !== "" ? searchField.type : searchField.operator);
  }

  function suggestSearchType(column) {
    const format = String(column?.format || "").toLowerCase();
    if (format === "date" || format === "datetime") {
      return "dateRange";
    }
    if (format === "number") {
      return "numberRange";
    }
    return "text";
  }

  function renderSearchFieldEditor(searchField, onChange) {
    const body = h("div", { class: "ce-body" });

    function render() {
      body.replaceChildren();
      const type = searchFieldType(searchField);
      const labelInput = textInput(searchField.label, (value) => {
        setOrDelete(searchField, "label", value);
        onChange();
      }, { placeholder: "Defaults to the field name" });

      body.append(
        h(
          "div",
          { class: "form-grid" },
          field("Field", selectInput(columnOptions(localColumns, "Choose a field..."), searchField.column, (value) => {
            const previous = localColumns.find((column) => column.name === searchField.column);
            const next = localColumns.find((column) => column.name === value);
            setOrDelete(searchField, "column", value);
            // Follow the field's label unless the user typed a custom one.
            if (!searchField.label || (previous && searchField.label === previous.label)) {
              setOrDelete(searchField, "label", next?.label || "");
            }
            if (searchField.type === undefined && !searchField.operator && next) {
              const suggested = suggestSearchType(next);
              if (suggested !== "text") {
                searchField.type = suggested;
              }
            }
            render();
            onChange();
          }, { required: true })),
          field("Label", labelInput),
          field("Search type", selectInput(SEARCH_TYPES, type, (value) => {
            searchField.type = value;
            const operators = value === "text" ? TEXT_OPERATORS : value === "select" || value === "multiSelect" ? [] : RANGE_OPERATORS;
            if (!operators.some((operator) => operator.value === searchField.operator)) {
              delete searchField.operator;
            }
            if (value !== "select" && value !== "multiSelect") {
              delete searchField.options;
            }
            render();
            onChange();
          }))
        )
      );

      const extra = h("div", { class: "form-grid" });
      if (type === "text") {
        extra.append(field("Match", selectInput(TEXT_OPERATORS, searchField.operator || "contains", (value) => {
          searchField.operator = value;
          onChange();
        })));
      }
      if (["date", "dateRange", "number", "numberRange"].includes(type)) {
        const fallback = type === "dateRange" || type === "numberRange" ? "between" : "exact";
        extra.append(field("Default comparison", selectInput(RANGE_OPERATORS, searchField.operator || fallback, (value) => {
          searchField.operator = value;
          onChange();
        }), "Users can still change this on the search form."));
      }
      if (type === "text" || type === "number" || type === "numberRange") {
        extra.append(field("Placeholder", textInput(searchField.placeholder, (value) => {
          setOrDelete(searchField, "placeholder", value);
          onChange();
        })));
      }
      if (type === "number" || type === "numberRange") {
        extra.append(field("Step", textInput(searchField.step, (value) => {
          setOrDelete(searchField, "step", value);
          onChange();
        }, { placeholder: "e.g. 0.01" })));
      }
      if (extra.childNodes.length) {
        body.append(extra);
      }

      if (type === "select" || type === "multiSelect") {
        if (!Array.isArray(searchField.options)) {
          searchField.options = [];
        }
        const rows = searchField.options.map((option, index) => {
          const optionObject = option && typeof option === "object" ? option : { value: String(option ?? "") };
          searchField.options[index] = optionObject;
          return h(
            "div",
            { class: "ce-option-row" },
            textInput(optionObject.value, (value) => {
              optionObject.value = value;
              onChange();
            }, { placeholder: "Stored value", required: true, "aria-label": "Stored value" }),
            textInput(optionObject.label, (value) => {
              setOrDelete(optionObject, "label", value);
              onChange();
            }, { placeholder: "Label shown to users", "aria-label": "Label" }),
            iconButton("Remove", () => {
              searchField.options.splice(index, 1);
              render();
              onChange();
            })
          );
        });
        body.append(
          h(
            "div",
            { class: "ce-keys" },
            h("span", { class: "ce-field-label" }, "Choices"),
            rows.length ? rows : h("span", { class: "muted" }, "No choices yet."),
            h("div", {}, iconButton("Add choice", () => {
              searchField.options.push({ value: "", label: "" });
              render();
              onChange();
            }))
          )
        );
      }
    }

    render();
    return body;
  }

  // ---------- Columns ----------

  const DATE_FORMATS = ["date", "datetime", "time"];

  function renderColumnEditor(column, onChange) {
    const body = h("div", { class: "ce-body" });

    function render() {
      body.replaceChildren();
      body.append(
        h(
          "div",
          { class: "form-grid" },
          field("Label", textInput(column.label, (value) => {
            setOrDelete(column, "label", value);
            onChange();
          }, { placeholder: column.name })),
          field("Database column", textInput(column.name, (value) => {
            column.name = value;
            onChange();
          }, { required: true })),
          field("Config ID (optional)", textInput(column.id, (value) => {
            setOrDelete(column, "id", value);
            onChange();
          }, { placeholder: "Same as database column" })),
          field("Alignment", selectInput(
            [
              { value: "", label: "Default" },
              { value: "left", label: "Left" },
              { value: "center", label: "Center" },
              { value: "right", label: "Right" }
            ],
            column.align,
            (value) => {
              setOrDelete(column, "align", value);
              onChange();
            }
          )),
          field("Format", selectInput(
            [
              { value: "", label: "None" },
              { value: "date", label: "Date" },
              { value: "datetime", label: "Date and time" },
              { value: "time", label: "Time" },
              { value: "number", label: "Number" }
            ],
            column.format,
            (value) => {
              setOrDelete(column, "format", value);
              render();
              onChange();
            }
          ))
        )
      );

      if (DATE_FORMATS.includes(column.format)) {
        const hasIntlOptions = column.dateFormat && typeof column.dateFormat === "object";
        body.append(
          h(
            "div",
            { class: "form-grid" },
            field("Date pattern", textInput(hasIntlOptions ? "" : column.dateFormat, (value) => {
              if (value || !hasIntlOptions) {
                setOrDelete(column, "dateFormat", value);
              }
              onChange();
            }, { placeholder: hasIntlOptions ? "Using advanced options" : data.defaultDateFormat || "e.g. DD/MM/YYYY" }),
            hasIntlOptions
              ? "This column uses advanced date options. Typing a pattern replaces them."
              : "Tokens: YYYY YY MM M DD D HH H mm m ss s. Blank uses the app default."),
            field("Locale", textInput(column.locale, (value) => {
              setOrDelete(column, "locale", value);
              onChange();
            }, { placeholder: "e.g. en-GB" })),
            field("Time zone", textInput(column.timeZone, (value) => {
              setOrDelete(column, "timeZone", value);
              onChange();
            }, { placeholder: "e.g. UTC or Europe/London" }))
          )
        );
      }

      if (column.format === "number" || (column.numberFormat && typeof column.numberFormat === "object")) {
        const target = column.numberFormat && typeof column.numberFormat === "object" ? column.numberFormat : column;
        const thousandsKey = Object.prototype.hasOwnProperty.call(target, "thousandsSeparator") ? "thousandsSeparator" : "thousandSeparator";
        body.append(
          h(
            "div",
            { class: "form-grid" },
            field("Decimal places", textInput(target.precision, (value) => {
              const parsed = value.trim() === "" ? "" : Number(value);
              setOrDelete(target, "precision", Number.isFinite(parsed) ? parsed : value);
              onChange();
            }, { inputmode: "numeric", placeholder: "Automatic" })),
            field("Thousands separator", textInput(target[thousandsKey], (value) => {
              setOrDelete(target, thousandsKey, value);
              onChange();
            }, { placeholder: "e.g. ," })),
            field("Decimal separator", textInput(target.decimalSeparator, (value) => {
              setOrDelete(target, "decimalSeparator", value);
              onChange();
            }, { placeholder: "e.g. ." }))
          )
        );
      }

      const linkToggle = h("input", { type: "checkbox" });
      linkToggle.checked = Boolean(column.link && typeof column.link === "object");
      linkToggle.addEventListener("change", () => {
        if (linkToggle.checked) {
          column.link = {};
        } else {
          delete column.link;
        }
        render();
        onChange();
      });
      body.append(h("label", { class: "ce-check" }, linkToggle, " Make this cell a link"));
      if (column.link && typeof column.link === "object") {
        body.append(h("div", { class: "ce-card ce-nested" }, renderLinkEditor(column.link, onChange, { isCellLink: true })));
      }
    }

    render();
    return body;
  }

  // ---------- Wiring ----------

  const serializers = [];

  function mountJsonEditor({ textareaName, mountId, fallbackText, setup }) {
    const textarea = form.querySelector(`textarea[name="${textareaName}"]`);
    const mount = document.getElementById(mountId);
    if (!textarea || !mount) {
      return;
    }
    const items = parseTextareaJson(textarea, []);
    if (!Array.isArray(items)) {
      mount.append(h("p", { class: "notice error-notice" }, fallbackText));
      return;
    }
    textarea.closest(".config-json-field").hidden = true;
    setup(mount, items);
    serializers.push(() => {
      textarea.value = JSON.stringify(items, null, 2);
    });
  }

  mountJsonEditor({
    textareaName: "searchFieldsJson",
    mountId: "search-fields-editor",
    fallbackText: "The saved search fields could not be read, so they are shown as JSON below.",
    setup: (mount, items) =>
      listEditor({
        mount,
        items,
        renderItem: renderSearchFieldEditor,
        createItem: () => ({ column: "" }),
        addLabel: "Add search field",
        emptyText: "No search fields. This view will not appear with search inputs on the home page.",
        titleFor: (item, index) => {
          const column = localColumns.find((candidate) => candidate.name === item.column);
          const typeLabel = SEARCH_TYPES.find((type) => type.value === searchFieldType(item))?.label || "Text";
          return `${index + 1}. ${item.label || column?.label || item.column || "New search field"} (${typeLabel})`;
        }
      })
  });

  mountJsonEditor({
    textareaName: "linksJson",
    mountId: "links-editor",
    fallbackText: "The saved links could not be read, so they are shown as JSON below.",
    setup: (mount, items) => {
      listEditor({
        mount,
        items,
        renderItem: (link, onChange) => renderLinkEditor(link, onChange),
        createItem: () => ({}),
        addLabel: "Add link",
        emptyText: "No related links.",
        titleFor: (link, index) => linkTitle(link, index, "New link")
      });
      serializers.unshift(() => items.forEach(cleanLink));
    }
  });

  for (const row of form.querySelectorAll(".config-column-row")) {
    const textarea = row.querySelector('textarea[name="columnJson"]');
    const column = textarea ? parseTextareaJson(textarea, null) : undefined;
    if (!column || typeof column !== "object" || Array.isArray(column)) {
      continue;
    }
    textarea.closest(".config-json-field").hidden = true;
    const title = row.querySelector(".config-column-title");
    const details = h("details", { class: "ce-column-details" }, h("summary", {}, "Column settings"));
    details.append(renderColumnEditor(column, () => {
      if (title) {
        title.textContent = column.label || column.name;
      }
    }));
    row.append(details);
    serializers.push(() => {
      if (column.link) {
        cleanLink(column.link);
      }
      textarea.value = JSON.stringify(column, null, 2);
    });
  }

  // Let the browser focus required fields that sit inside a collapsed column panel.
  form.addEventListener("invalid", (event) => {
    const details = event.target.closest("details");
    if (details) {
      details.open = true;
    }
  }, true);

  form.addEventListener("submit", () => {
    serializers.forEach((serialize) => serialize());
  });
})();
