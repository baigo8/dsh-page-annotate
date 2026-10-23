/**
 * Annotation overlay — injected into the previewed page, never into the file.
 *
 * Runs as a plain script at the end of `<body>`, inside a frame the client
 * bundle owns. The core helpers (`collapseWhitespace`, `truncate`,
 * `elementLocator`, `KIND_LABELS`) are already in scope: the build concatenates
 * this file after `src/core.mjs` inside one function.
 *
 * Protocol with the shell (`window.parent`), all frames carrying `channel`:
 *   in  { type: "mode", mode: "browse" | "pick" }
 *   in  { type: "restore", annotations: Annotation[] }
 *   in  { type: "remove", id: string }
 *   out { type: "ready" }
 *   out { type: "change", annotations: Annotation[] }
 *   out { type: "exit-pick" }
 *
 * The overlay owns the annotation list while the page is loaded; the shell
 * owns it across reloads and hands it back on `restore`.
 */

var CHANNEL = "dsh-page-annotate";
var ROOT_ATTR = "data-dsh-page-annotate";

var state = {
  mode: "browse",
  annotations: [],
  editing: null,
  seq: 0
};

/** Elements still resolvable for the current page, keyed by annotation id. */
var elements = new Map();

var layer = null;
var hoverBox = null;
var editor = null;
var activeColorPicker = null;
var badgeNodes = new Map();

/**
 * Post one frame to the shell, ignoring a detached frame.
 * @param {object} message - frame body.
 */
function post(message) {
  try {
    parent.postMessage(Object.assign({ channel: CHANNEL }, message), "*");
  } catch (error) {
    /* The shell navigated away; nothing left to tell. */
  }
}

/**
 * Create an element with optional props and children.
 * @param {string} tag - tag name.
 * @param {object} [props] - attributes and `style`/`text` shortcuts.
 * @param {Array<Node|string>} [children] - appended children.
 * @returns the element.
 */
function make(tag, props, children) {
  var node = document.createElement(tag);
  for (var name in props || {}) {
    var value = props[name];
    if (value === undefined || value === null) continue;
    if (name === "text") node.textContent = String(value);
    else if (name === "style") node.setAttribute("style", value);
    else node.setAttribute(name, String(value));
  }
  for (var index = 0; index < (children || []).length; index += 1) {
    var child = children[index];
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * A CSS path good enough to re-find the same element after a reload.
 * @param {Element} element - the target.
 * @returns a `querySelector` path.
 */
function cssPath(element) {
  if (!(element instanceof Element)) return "";
  var parts = [];
  var cursor = element;
  while (cursor !== null && cursor.nodeType === 1 && cursor !== document.documentElement) {
    if (cursor.id !== "" && document.querySelectorAll("#" + cssEscape(cursor.id)).length === 1) {
      parts.unshift("#" + cssEscape(cursor.id));
      break;
    }
    var part = cursor.tagName.toLowerCase();
    var parent = cursor.parentElement;
    if (parent !== null) {
      var index = 1;
      var sibling = cursor;
      while ((sibling = sibling.previousElementSibling) !== null) {
        if (sibling.tagName === cursor.tagName) index += 1;
      }
      part += ":nth-of-type(" + String(index) + ")";
    }
    parts.unshift(part);
    cursor = parent;
  }
  return parts.join(" > ");
}

/**
 * Escape one ident for use in a selector.
 * @param {string} value - the ident.
 * @returns the escaped ident.
 */
function cssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

/** Install the overlay's stylesheet once. */
function installStyles() {
  if (document.querySelector("style[" + ROOT_ATTR + "]") !== null) return;
  var css = [
    "." + ROOT_ATTR + "{position:fixed;inset:0;pointer-events:none;z-index:2147483000;font:400 13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
    "." + ROOT_ATTR + "-hover{position:fixed;pointer-events:none;border:2px solid #0b62b4;border-radius:3px;background:rgba(11,98,180,.08);transition:all .06s linear}",
    "." + ROOT_ATTR + "-tag{position:absolute;top:-22px;left:-2px;background:#0b62b4;color:#fff;padding:1px 6px;border-radius:3px;white-space:nowrap;font:500 11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}",
    "." + ROOT_ATTR + "-badge{position:fixed;pointer-events:auto;cursor:pointer;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#0b62b4;color:#fff;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.28);font:600 11px/16px -apple-system,sans-serif;text-align:center;transform:translate(-50%,-50%)}",
    "." + ROOT_ATTR + "-badge[data-kind=remove]{background:#c0362c}",
    "." + ROOT_ATTR + "-badge[data-kind=add]{background:#1a7f4b}",
    "." + ROOT_ATTR + "-badge[data-kind=question]{background:#a86a00}",
    "." + ROOT_ATTR + "-editor{position:fixed;pointer-events:auto;box-sizing:border-box;width:380px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);overflow-y:auto;overscroll-behavior:contain;background:#fff;color:#1c1f23;border:1px solid rgba(0,0,0,.12);border-radius:16px;box-shadow:0 8px 28px rgba(0,0,0,.16);padding:10px;z-index:1}",
    "." + ROOT_ATTR + "-composer{display:flex;align-items:flex-start;gap:8px;min-width:0}",
    "." + ROOT_ATTR + "-number{flex:none;min-width:22px;height:22px;box-sizing:border-box;padding:0 5px;margin-top:4px;border-radius:7px;background:#e7f1ff;color:#0b62b4;font:600 12px/22px -apple-system,sans-serif;text-align:center}",
    "." + ROOT_ATTR + "-details{border-top:1px solid #edf0f3;margin-top:10px;padding-top:10px}",
    "." + ROOT_ATTR + "-details[hidden]{display:none}",
    "." + ROOT_ATTR + "-color-row{display:flex;align-items:center;gap:6px}",
    "." + ROOT_ATTR + "-swatch{flex:none;width:26px;height:26px;padding:3px;border:1px solid #dfe3e8;border-radius:6px;background:repeating-conic-gradient(#ddd 0% 25%,#fff 0% 50%) 0/8px 8px;cursor:pointer}",
    "." + ROOT_ATTR + "-swatch span{display:block;width:100%;height:100%;border-radius:3px}",
    "." + ROOT_ATTR + "-picker{grid-column:1/-1;min-width:0;border:1px solid #dfe3e8;border-radius:10px;padding:10px;background:#f9fafb;display:flex;flex-direction:column;gap:8px}",
    "." + ROOT_ATTR + "-sv{position:relative;touch-action:none;height:130px;min-height:80px;border-radius:5px;background:linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,transparent),var(--hue);outline-offset:2px}",
    "." + ROOT_ATTR + "-sv-cursor{position:absolute;width:10px;height:10px;border:2px solid #fff;border-radius:50%;box-shadow:0 0 2px #000;transform:translate(-50%,-50%);pointer-events:none}",
    "." + ROOT_ATTR + "-picker input[type=range]{width:100%;min-width:0;box-sizing:border-box;accent-color:#0b62b4}",
    "." + ROOT_ATTR + "-hue{background:linear-gradient(to right,red,#ff0,#0f0,#0ff,#00f,#f0f,red);border-radius:6px}",
    "." + ROOT_ATTR + "-picker input[type=range]{appearance:none;height:12px;border:1px solid #dfe3e8;border-radius:6px;cursor:pointer!important}",
    "." + ROOT_ATTR + "-picker input[type=range]::-webkit-slider-thumb{appearance:none;width:15px;height:15px;background:#fff;border:1px solid #788493;border-radius:50%;box-shadow:0 1px 3px #0003}",
    "." + ROOT_ATTR + "-picker input[type=range]::-moz-range-thumb{width:15px;height:15px;background:#fff;border:1px solid #788493;border-radius:50%}",
    "." + ROOT_ATTR + "-input{display:block;flex:1;min-width:0;width:0;box-sizing:border-box;height:30px;min-height:30px;max-height:180px;resize:none;overflow-y:hidden;padding:5px 0;border:0;outline:none;font:400 13px/20px -apple-system,sans-serif;color:#1c1f23;background:transparent}",
    "." + ROOT_ATTR + "-input:focus-visible{box-shadow:0 2px 0 #cce1fb}",
    "." + ROOT_ATTR + "-styles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}",
    "." + ROOT_ATTR + "-style-field{display:flex;flex-direction:column;gap:3px;min-width:0;font:400 11px/1.5 -apple-system,sans-serif;color:#606975}",
    "." + ROOT_ATTR + "-style-input{box-sizing:border-box;width:100%;min-width:0;border:1px solid #dfe3e8;border-radius:6px;padding:5px 7px;background:#fff;color:#333;font:400 12px/1.5 -apple-system,sans-serif}",
    "." + ROOT_ATTR + "-style-input[aria-invalid=true]{border-color:#c0362c}",
    "." + ROOT_ATTR + "-style-note{margin:10px 0 6px;color:#7d8590;font:400 11px/1.5 -apple-system,sans-serif}",
    "." + ROOT_ATTR + "-rows{display:flex;gap:6px;justify-content:flex-end;margin-top:8px}",
    "." + ROOT_ATTR + "-btn{padding:4px 10px;border:1px solid rgba(0,0,0,.14);border-radius:6px;background:#fff;font:500 12px/1.5 -apple-system,sans-serif;cursor:pointer;color:#333}",
    "." + ROOT_ATTR + "-icon{display:flex;align-items:center;justify-content:center;flex:none;box-sizing:border-box;width:30px;height:30px;padding:0;border:0;border-radius:8px;background:transparent;color:#7d8590;cursor:pointer}",
    "." + ROOT_ATTR + "-icon svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round}",
    "." + ROOT_ATTR + "-icon:hover,." + ROOT_ATTR + "-icon[aria-expanded=true]{background:#f1f4f7;color:#343b45}",
    "." + ROOT_ATTR + "-icon[data-primary]{border-radius:50%;background:#0b62b4;color:#fff;font:500 18px/1 -apple-system,sans-serif}",
    "." + ROOT_ATTR + "-icon[data-primary]:disabled{background:#eef0f3;color:#aab0b9;cursor:default}",
    "." + ROOT_ATTR + "-btn[data-danger]{color:#c0362c}",
    "body[" + ROOT_ATTR + "-picking],body[" + ROOT_ATTR + "-picking] *{cursor:crosshair!important}",
    "body ." + ROOT_ATTR + "-editor,body ." + ROOT_ATTR + "-editor *{cursor:default!important}",
    "body ." + ROOT_ATTR + "-editor textarea,body ." + ROOT_ATTR + "-editor input{cursor:text!important}",
    "body ." + ROOT_ATTR + "-editor button,body ." + ROOT_ATTR + "-editor button *{cursor:pointer!important}",
    "body ." + ROOT_ATTR + "-editor button:disabled{cursor:default!important}"
  ].join("\n");
  document.head.appendChild(make("style", { [ROOT_ATTR]: "", text: css }));
}

/** Build the fixed layer that carries hover, badges, and the editor. */
function installLayer() {
  layer = make("div", { class: ROOT_ATTR, [ROOT_ATTR + "-layer"]: "" });
  hoverBox = make("div", { class: ROOT_ATTR + "-hover", style: "display:none" });
  layer.appendChild(hoverBox);
  document.body.appendChild(layer);
}

/**
 * Read the element facts the core locator needs.
 * @param {Element} element - the picked element.
 * @returns the scraped facts.
 */
function factsOf(element) {
  var ancestry = [];
  var cursor = element.parentElement;
  while (cursor !== null && cursor !== document.documentElement && ancestry.length < 24) {
    ancestry.push({
      tag: cursor.tagName,
      id: cursor.id,
      classes: Array.prototype.slice.call(cursor.classList)
    });
    if (uniqueIdSelector(cursor) !== "") break;
    cursor = cursor.parentElement;
  }
  return {
    tag: element.tagName,
    id: element.id,
    classes: Array.prototype.slice.call(element.classList),
    ancestry: ancestry
  };
}

/** Return an ID selector only when it identifies exactly one live element. */
function uniqueIdSelector(element) {
  if (element.id === "") return "";
  var selector = "#" + cssEscape(element.id);
  return document.querySelectorAll(selector).length === 1 ? selector : "";
}

/**
 * Collect bounded DOM evidence, not a claim about a source-file location.
 * Keep the nearest dialog's title but prefer its enclosing mask's unique ID
 * over a shared class such as `.modal.wide` when identifying the scope.
 */
function targetContextOf(element, selector) {
  var modal = element.closest('dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"],.modal,.dialog,.modal-container,.dialog-container,.modal-mask,.modal-overlay');
  var scope = modal || element;
  var scopeSelector = "";
  var cursor = scope;
  while (cursor !== null && cursor !== document.documentElement) {
    scopeSelector = uniqueIdSelector(cursor);
    if (scopeSelector !== "") break;
    cursor = cursor.parentElement;
  }
  if (scopeSelector === "") scopeSelector = cssPath(scope);
  var title = modal === null ? null : modal.querySelector('h1,h2,h3,[role="heading"],.modal-title,.dialog-title,.modal-header-title,.dialog-header-title');
  if (modal !== null && modal.hasAttribute("aria-labelledby")) {
    var labelled = modal.getAttribute("aria-labelledby").split(/\s+/).map(function (id) {
      return document.getElementById(id);
    }).find(function (node) { return node !== null; });
    if (labelled) title = labelled;
  }
  return {
    scopeSelector: scopeSelector,
    scopeTitle: title === null ? "" : truncate(collapseWhitespace(title.textContent), 159),
    html: targetHtml(element),
    selectorMatches: selector === "" ? 0 : document.querySelectorAll(selector).length,
    tag: element.tagName.toLowerCase()
  };
}

/** Serialize only the target, without executable markup or form values. */
function targetHtml(element) {
  if (element.matches("script,style")) return "";
  var clone = element.cloneNode(true);
  Array.prototype.forEach.call(clone.querySelectorAll("script,style,[" + ROOT_ATTR + "-layer],." + ROOT_ATTR + "-badge,." + ROOT_ATTR + "-hover,." + ROOT_ATTR + "-editor"), function (node) { node.remove(); });
  [clone].concat(Array.prototype.slice.call(clone.querySelectorAll("*"))).forEach(function (node) {
    Array.prototype.slice.call(node.attributes).forEach(function (attribute) {
      if (/^on/i.test(attribute.name) || /^(value|checked|selected|srcdoc)$/i.test(attribute.name)) {
        node.removeAttribute(attribute.name);
      }
    });
    if (node.matches("textarea")) node.textContent = "";
  });
  // `truncate` adds an ellipsis outside its limit, so reserve one character.
  var html = clone.outerHTML;
  return html.length <= 1600 ? html : truncate(html, 1599);
}

/**
 * Position one box on an element's border box.
 * @param {HTMLElement} box - the positioned node.
 * @param {Element} element - the target.
 */
function placeOn(box, element) {
  var rect = element.getBoundingClientRect();
  box.style.left = String(rect.left) + "px";
  box.style.top = String(rect.top) + "px";
  box.style.width = String(rect.width) + "px";
  box.style.height = String(rect.height) + "px";
}

/** Reposition hover box and every badge against the live layout. */
function reposition() {
  // A draft owns the highlight until it is saved or cancelled. Scroll and
  // resize still track its live bounds, independently of the mouse position.
  if (state.editing !== null) state.hovered = elements.get(state.editing.id) || null;
  if (hoverBox !== null && state.mode === "pick" && state.hovered instanceof Element) {
    placeOn(hoverBox, state.hovered);
    hoverBox.style.display = "block";
  } else if (hoverBox !== null) {
    hoverBox.style.display = "none";
  }
  state.annotations.forEach(function (annotation, index) {
    var node = badgeNodes.get(annotation.id);
    if (node === undefined) return;
    var element = elements.get(annotation.id);
    if (element === undefined || !element.isConnected) {
      node.style.display = "none";
      return;
    }
    var rect = element.getBoundingClientRect();
    node.style.display = "block";
    node.style.left = String(rect.left) + "px";
    node.style.top = String(rect.top) + "px";
    node.textContent = String(index + 1);
  });
  if (editor !== null && state.editing !== null) placeEditor(state.editing);
}

/** Draw one badge per annotation and drop the stale ones. */
function renderBadges() {
  var live = new Set();
  state.annotations.forEach(function (annotation) {
    live.add(annotation.id);
    var node = badgeNodes.get(annotation.id);
    if (node === undefined) {
      node = make("div", { class: ROOT_ATTR + "-badge", "data-kind": annotation.kind, title: annotation.comment });
      node.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        openEditor(annotation.id);
      });
      layer.appendChild(node);
      badgeNodes.set(annotation.id, node);
    }
    node.setAttribute("data-kind", annotation.kind);
    node.setAttribute("title", annotation.comment);
    node.setAttribute("data-dpa-target-selector", annotation.selector || "");
    node.setAttribute("data-dpa-annotation-id", annotation.id);
  });
  badgeNodes.forEach(function (node, id) {
    if (live.has(id)) return;
    node.remove();
    badgeNodes.delete(id);
  });
  reposition();
}

/** Place the editor popup beside its target, clamped to the viewport. */
function placeEditor(annotation) {
  if (editor === null) return;
  var element = elements.get(annotation.id);
  var anchor = element === undefined ? null : element.getBoundingClientRect();
  var width = editor.getBoundingClientRect().width;
  var height = editor.offsetHeight || 190;
  var left = anchor === null ? 40 : anchor.left + anchor.width / 2 - width / 2;
  var top = anchor === null ? 60 : anchor.bottom + 8;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  if (top + height > window.innerHeight - 8) top = Math.max(8, (anchor === null ? 60 : anchor.top) - height - 8);
  editor.style.left = String(left) + "px";
  editor.style.top = String(top) + "px";
}

/**
 * Open the editor for one element — existing annotation when `id` is known.
 * @param {string} [id] - annotation to edit.
 * @param {Element} [picked] - element to annotate when creating.
 */
function openEditor(id, picked) {
  closeEditor();
  var existing = null;
  for (var index = 0; index < state.annotations.length; index += 1) {
    if (state.annotations[index].id === id) existing = state.annotations[index];
  }
  // Picking an element that already carries a note edits that note rather than
  // stacking a second badge on the same box.
  if (existing === null && picked !== undefined) {
    for (var at = 0; at < state.annotations.length; at += 1) {
      if (elements.get(state.annotations[at].id) === picked) existing = state.annotations[at];
    }
  }
  var element = picked !== undefined ? picked : elements.get(id);
  if (element === undefined || element === null) return;
  var selector = cssPath(element);
  var targetContext = targetContextOf(element, selector);
  var locator = elementLocator(factsOf(element));
  if (targetContext.scopeSelector !== "") locator = targetContext.scopeSelector + " · " + locator;
  var annotation = existing === null
    ? {
      id: "a" + String((state.seq += 1)),
      kind: "change",
      comment: "",
      locator: truncate(locator, 1199),
      selector: selector,
      targetContext: targetContext,
      label: truncate(collapseWhitespace(element.tagName.toLowerCase()), 120),
      text: truncate(collapseWhitespace(element.textContent), 300)
    }
    : Object.assign({}, existing);
  state.editing = { id: annotation.id, draft: annotation, created: existing === null };
  elements.set(annotation.id, element);
  buildEditor(state.editing.draft);
  placeEditor(state.editing.draft);
  state.hovered = element;
  reposition();
}

/** Tear down the editor without saving. */
function closeEditor() {
  if (activeColorPicker !== null) activeColorPicker();
  if (editor !== null) {
    editor.remove();
    editor = null;
  }
  state.editing = null;
  state.hovered = null;
  if (hoverBox !== null) hoverBox.style.display = "none";
}

/** Parse CSS colors on a disposable overlay node, never on the target. */
function readColor(value) {
  if (/^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value)) {
    var hex = value.slice(1);
    if (hex.length < 5) hex = hex.split("").map(function (c) { return c + c; }).join("");
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1 };
  }
  if (!CSS.supports("color", value)) return null;
  var probe = make("span", { style: "color:" + value });
  layer.appendChild(probe);
  var normalized = getComputedStyle(probe).color;
  probe.remove();
  var parts = normalized.match(/^rgba?\(([^)]+)\)$/);
  if (parts === null) return null;
  var channels = parts[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return { r: channels[0], g: channels[1], b: channels[2], a: channels.length > 3 ? channels[3] : 1 };
}

function colorHex(color) {
  return "#" + [color.r, color.g, color.b].map(function (n) { return Math.round(n).toString(16).padStart(2, "0"); }).join("");
}

function colorValue(color) {
  return color.a === 1 ? colorHex(color) : "rgba(" + [color.r, color.g, color.b, Number(color.a.toFixed(3))].join(", ") + ")";
}

function colorHSV(color) {
  var r = color.r / 255, g = color.g / 255, b = color.b / 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  var hue = delta === 0 ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { h: (hue * 60 + 360) % 360, s: max === 0 ? 0 : delta / max, v: max };
}

/** Swatch + value with an inline, keyboard-accessible HSV popover. */
function colorField(key, label, initial, draft, update, fields) {
  var color = readColor(initial) || { r: 0, g: 0, b: 0, a: 0 };
  var original = colorValue(color);
  var hsv = colorHSV(color);
  var field = make("input", { type: "text", value: colorValue(color), "aria-label": label,
    "data-style-key": key, class: ROOT_ATTR + "-style-input" });
  var paint = make("span", { style: "background:" + colorValue(color) });
  var swatch = make("button", { type: "button", class: ROOT_ATTR + "-swatch", "aria-label": label + "取色器",
    "aria-haspopup": "dialog", "aria-expanded": "false" }, [paint]);
  var popover = null, hex, alpha, hue, sv, cursor;
  function sync() {
    field.value = colorValue(color);
    field.setAttribute("aria-invalid", "false");
    paint.style.background = colorValue(color);
    delete draft.styleChanges[key];
    if (colorValue(color) !== original) draft.styleChanges[key] = colorValue(color);
    if (popover !== null) {
      hex.value = colorHex(color);
      hex.setAttribute("aria-invalid", "false");
      alpha.value = String(color.a * 100);
      alpha.style.background = "linear-gradient(to right,transparent," + colorHex(color) + "),repeating-conic-gradient(#ddd 0% 25%,#fff 0% 50%) 0/8px 8px";
      alpha.setAttribute("aria-valuetext", String(Math.round(color.a * 100)) + "%");
      hue.value = String(hsv.h);
      sv.setAttribute("aria-valuenow", String(Math.round(hsv.s * 100)));
      sv.style.setProperty("--hue", "hsl(" + hsv.h + " 100% 50%)");
      cursor.style.left = String(hsv.s * 100) + "%";
      cursor.style.top = String((1 - hsv.v) * 100) + "%";
      sv.setAttribute("aria-valuetext", "饱和度 " + Math.round(hsv.s * 100) + "%，明度 " + Math.round(hsv.v * 100) + "%");
    }
    update();
  }
  function fromHSV() {
    var chroma = hsv.v * hsv.s, x = chroma * (1 - Math.abs((hsv.h / 60) % 2 - 1)), m = hsv.v - chroma;
    var rgb = [[chroma,x,0],[x,chroma,0],[0,chroma,x],[0,x,chroma],[x,0,chroma],[chroma,0,x]][Math.min(5, Math.floor(hsv.h / 60))];
    color.r = Math.round((rgb[0] + m) * 255); color.g = Math.round((rgb[1] + m) * 255); color.b = Math.round((rgb[2] + m) * 255);
    sync();
  }
  field.addEventListener("input", function () {
    var parsed = readColor(field.value.trim());
    field.setAttribute("aria-invalid", String(parsed === null));
    if (parsed === null) { delete draft.styleChanges[key]; update(); return; }
    var typed = field.value;
    color = parsed; hsv = colorHSV(color); sync(); field.value = typed;
  });
  swatch.addEventListener("click", function () {
    if (popover !== null) { activeColorPicker(); return; }
    if (activeColorPicker !== null) activeColorPicker();
    cursor = make("span", { class: ROOT_ATTR + "-sv-cursor" });
    sv = make("div", { class: ROOT_ATTR + "-sv", role: "slider", tabindex: "0", "aria-label": label + "饱和度与明度", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(hsv.s * 100) }, [cursor]);
    hue = make("input", { type: "range", min: "0", max: "359", step: "1", class: ROOT_ATTR + "-hue", "aria-label": label + "色相" });
    alpha = make("input", { type: "range", min: "0", max: "100", step: "1", "aria-label": label + "透明度" });
    hex = make("input", { type: "text", class: ROOT_ATTR + "-style-input", "aria-label": label + " Hex", spellcheck: "false" });
    popover = make("div", { class: ROOT_ATTR + "-picker", role: "dialog", "aria-label": label + "取色面板" }, [sv,
      make("label", { text: "色相" }, [hue]), make("label", { text: "透明度" }, [alpha]), make("label", { text: "Hex" }, [hex])]);
    fields.appendChild(popover);
    swatch.setAttribute("aria-expanded", "true");
    activeColorPicker = function () {
      popover.remove(); popover = null; activeColorPicker = null;
      swatch.setAttribute("aria-expanded", "false"); swatch.focus(); update();
    };
    function point(event) {
      var rect = sv.getBoundingClientRect();
      hsv.s = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      hsv.v = 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      sv.setAttribute("aria-valuenow", String(Math.round(hsv.s * 100)));
      fromHSV();
    }
    sv.addEventListener("pointerdown", function (event) { if (event.button !== 0) return; event.preventDefault(); sv.focus(); sv.setPointerCapture(event.pointerId); point(event); });
    sv.addEventListener("pointermove", function (event) { if (sv.hasPointerCapture(event.pointerId)) point(event); });
    sv.addEventListener("pointerup", function (event) { if (sv.hasPointerCapture(event.pointerId)) sv.releasePointerCapture(event.pointerId); });
    sv.addEventListener("keydown", function (event) {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      hsv.s = Math.max(0, Math.min(1, hsv.s + (event.key === "ArrowRight" ? .01 : event.key === "ArrowLeft" ? -.01 : 0)));
      hsv.v = Math.max(0, Math.min(1, hsv.v + (event.key === "ArrowUp" ? .01 : event.key === "ArrowDown" ? -.01 : 0)));
      fromHSV();
    });
    hue.addEventListener("input", function () { hsv.h = Number(hue.value); fromHSV(); });
    alpha.addEventListener("input", function () { color.a = Number(alpha.value) / 100; sync(); });
    hex.addEventListener("input", function () {
      var value = hex.value.trim();
      var valid = /^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value);
      hex.setAttribute("aria-invalid", String(!valid));
      if (!valid) return;
      var parsed = readColor(value);
      if (parsed === null) return;
      if (value.length === 4 || value.length === 7) parsed.a = color.a;
      color = parsed; hsv = colorHSV(color); sync(); hex.value = value;
    });
    sync();
    sv.focus();
  });
  return make("div", { class: ROOT_ATTR + "-style-field" }, [make("span", { text: label }),
    make("div", { class: ROOT_ATTR + "-color-row" }, [swatch, field])]);
}

/**
 * Render the editor popup for one draft.
 * @param {object} draft - the annotation being edited.
 */
function buildEditor(draft) {
  var textarea = make("textarea", {
    class: ROOT_ATTR + "-input",
    placeholder: "写明这里要改什么…",
    "data-dsh-page-annotate-input": ""
  });
  textarea.value = draft.comment;
  draft.styleChanges = {};
  var composing = false;
  textarea.setAttribute("rows", "1");
  textarea.setAttribute("aria-label", "批注内容");
  textarea.addEventListener("compositionstart", function () { composing = true; });
  textarea.addEventListener("compositionend", function () { composing = false; });
  textarea.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" || event.isComposing || composing || event.keyCode === 229) return;
    if (event.shiftKey) return;
    event.preventDefault();
    commitEditor(textarea.value);
  });
  function updateInput() {
    draft.comment = textarea.value;
    save.disabled = normalizeComment(textarea.value) === "" && Object.keys(draft.styleChanges).length === 0;
    textarea.style.height = "30px";
    textarea.style.height = String(Math.min(180, textarea.scrollHeight)) + "px";
    textarea.style.overflowY = textarea.scrollHeight > 180 ? "auto" : "hidden";
    placeEditor(draft);
  }
  textarea.addEventListener("input", updateInput);
  var save = make("button", {
    type: "button",
    class: ROOT_ATTR + "-icon",
    "data-primary": "",
    "aria-label": "保存批注",
    text: "✓",
    title: "保存批注（Enter）"
  });
  save.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    commitEditor(textarea.value);
  });
  var cancel = make("button", { type: "button", class: ROOT_ATTR + "-btn", text: "取消" });
  cancel.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    closeEditor();
  });
  var rows = make("div", { class: ROOT_ATTR + "-rows" }, [cancel]);
  if (!state.editing.created) {
    var remove = make("button", { type: "button", class: ROOT_ATTR + "-btn", "data-danger": "", text: "删除" });
    remove.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      removeAnnotation(draft.id);
    });
    rows.appendChild(remove);
  }
  var computed = window.getComputedStyle(elements.get(draft.id));
  var styleFields = make("div", { class: ROOT_ATTR + "-styles" });
  var styleOptions = [
    ["fontSize", "字号（px）", "number", String(parseFloat(computed.fontSize))],
    ["fontWeight", "字重", "number", computed.fontWeight],
    ["opacity", "不透明度", "number", computed.opacity]
  ];
  [["color", "文字颜色", computed.color], ["backgroundColor", "背景颜色", computed.backgroundColor]].forEach(function (option) {
    styleFields.appendChild(colorField(option[0], option[1], option[2], draft, updateInput, styleFields));
  });
  styleOptions.forEach(function (option) {
    var key = option[0];
    var initial = option[3];
    var field = make("input", {
      type: option[2], value: initial, "aria-label": option[1], "data-style-key": key,
      class: ROOT_ATTR + "-style-input"
    });
    if (key === "fontSize") { field.min = "1"; field.max = "999"; field.step = "0.1"; }
    if (key === "fontWeight") { field.min = "1"; field.max = "1000"; field.step = "1"; }
    if (key === "opacity") { field.min = "0"; field.max = "1"; field.step = "0.01"; }
    field.addEventListener("input", function () {
      var value = field.value.trim();
      var valid = value !== "" && (option[2] === "number"
        ? field.validity.valid && Number.isFinite(Number(value))
        : CSS.supports(key === "backgroundColor" ? "background-color" : "color", value));
      field.setAttribute("aria-invalid", String(!valid));
      delete draft.styleChanges[key];
      if (valid && value !== initial) draft.styleChanges[key] = key === "fontSize" ? value + "px" : value;
      updateInput();
    });
    styleFields.appendChild(make("label", { class: ROOT_ATTR + "-style-field" }, [
      make("span", { text: option[1] }), field
    ]));
  });
  var details = make("div", { class: ROOT_ATTR + "-details", id: ROOT_ATTR + "-details", hidden: "" }, [
    make("p", { class: ROOT_ATTR + "-style-note", text: "样式目标 · 仅记录批注，不直接修改页面" }),
    styleFields,
    rows
  ]);
  var settings = make("button", {
    type: "button", class: ROOT_ATTR + "-icon", "aria-label": "批注配置",
    "aria-expanded": "false", "aria-controls": ROOT_ATTR + "-details", title: "批注配置"
  });
  // A compact sliders glyph toggles annotation and style-target settings.
  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M4 7h7m4 0h5M4 17h3m4 0h9M11 4v6M7 14v6");
  svg.appendChild(path);
  settings.appendChild(svg);
  settings.addEventListener("click", function () {
    if (activeColorPicker !== null) activeColorPicker();
    details.hidden = !details.hidden;
    settings.setAttribute("aria-expanded", String(!details.hidden));
    placeEditor(draft);
  });
  var number = state.annotations.findIndex(function (annotation) { return annotation.id === draft.id; });
  editor = make("div", { class: ROOT_ATTR + "-editor", "aria-label": "批注编辑器" }, [
    make("div", { class: ROOT_ATTR + "-composer" }, [
      make("span", { class: ROOT_ATTR + "-number", text: number < 0 ? state.annotations.length + 1 : number + 1 }),
      settings, textarea, save
    ]),
    details
  ]);
  ["pointerdown", "pointermove", "pointerup", "mousedown", "mousemove", "mouseup", "click", "dblclick", "input", "change", "keydown", "keyup", "touchstart", "touchend", "contextmenu"].forEach(function (type) {
    editor.addEventListener(type, function (event) { event.stopPropagation(); });
  });
  layer.appendChild(editor);
  updateInput();
  textarea.focus();
}

/**
 * Save the editor's draft into the list and tell the shell.
 * @param {string} comment - the textarea value.
 */
function commitEditor(comment) {
  if (state.editing === null) return;
  var draft = state.editing.draft;
  var labels = { color: "文字颜色", backgroundColor: "背景颜色", fontSize: "字号", fontWeight: "字重", opacity: "不透明度" };
  var changes = Object.keys(labels).filter(function (key) {
    return draft.styleChanges && Object.prototype.hasOwnProperty.call(draft.styleChanges, key);
  }).map(function (key) { return labels[key] + "设为 " + draft.styleChanges[key]; });
  var normalized = normalizeComment(comment);
  if (changes.length) normalized += (normalized ? "\n" : "") + "样式调整：" + changes.join("；") + "。";
  if (normalized === "") return;
  // Same normalization the shell applies to whatever arrives: one shared
  // helper, so a multi-line note keeps its lines on both sides of the channel.
  draft.comment = truncate(normalized, 4000);
  var found = -1;
  for (var index = 0; index < state.annotations.length; index += 1) {
    if (state.annotations[index].id === draft.id) found = index;
  }
  if (found >= 0) state.annotations[found] = draft;
  else state.annotations.push(draft);
  closeEditor();
  renderBadges();
  postChange();
}

/**
 * Drop one annotation.
 * @param {string} id - annotation id.
 */
function removeAnnotation(id) {
  state.annotations = state.annotations.filter(function (annotation) {
    return annotation.id !== id;
  });
  elements.delete(id);
  closeEditor();
  renderBadges();
  postChange();
}

/** Publish the list to the shell. */
function postChange() {
  post({ type: "change", annotations: state.annotations });
}

/**
 * Enter or leave pick mode.
 * @param {string} mode - "browse" or "pick".
 */
function setMode(mode) {
  state.mode = mode === "pick" ? "pick" : "browse";
  if (state.mode === "pick") document.body.setAttribute(ROOT_ATTR + "-picking", "");
  else document.body.removeAttribute(ROOT_ATTR + "-picking");
  if (state.mode !== "pick") {
    state.hovered = null;
    closeEditor();
  }
  layer.setAttribute("data-mode", state.mode);
  reposition();
}

/** Capture-phase move handler: highlight what a click would pick. */
function onPointerMove(event) {
  if (state.mode !== "pick" || state.editing !== null) return;
  var target = event.target;
  if (!(target instanceof Element)) return;
  if (layer !== null && layer.contains(target)) return;
  if (state.hovered === target) return;
  state.hovered = target;
  if (hoverBox !== null) {
    placeOn(hoverBox, target);
    hoverBox.style.display = "block";
  }
  var tag = document.querySelector("." + ROOT_ATTR + "-tag");
  if (tag !== null) tag.textContent = describe(target);
}

/**
 * Short label for the hover tag.
 * @param {Element} element - the hovered element.
 * @returns the label.
 */
function describe(element) {
  var tag = element.tagName.toLowerCase();
  if (element.id !== "") tag += "#" + element.id;
  else if (element.classList.length > 0) tag += "." + element.classList[0];
  return tag;
}

/** Capture-phase click handler: pick instead of activating the page. */
function onPointerDown(event) {
  if (state.mode !== "pick") return;
  var target = event.target;
  if (!(target instanceof Element)) return;
  if (layer !== null && layer.contains(target)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  openEditor(undefined, target);
}

/** Block the complete activation sequence, not just its initial down event.
 * Window capture runs before document/target handlers (including delegation).
 * Overlay controls remain interactive; browse mode leaves the page untouched.
 */
function blockPageActivation(event) {
  if (state.mode !== "pick") return;
  var target = event.target;
  if (target instanceof Node && layer !== null && layer.contains(target)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

/** Escape leaves pick mode, matching the shell's toggle. */
function onKeyDown(event) {
  if (event.key !== "Escape") return;
  var wasPicking = state.mode === "pick";
  if (!wasPicking && editor === null) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (activeColorPicker !== null) { activeColorPicker(); return; }
  // Cancel the draft and restore page interaction immediately; do not depend
  // on the shell echoing a mode message back into this frame.
  setMode("browse");
  if (wasPicking) post({ type: "exit-pick" });
}

/** Shell → frame messages. */
function onMessage(event) {
  if (event.source !== parent) return;
  var data = event.data;
  if (data === null || typeof data !== "object" || data.channel !== CHANNEL) return;
  if (data.type === "mode") setMode(data.mode);
  else if (data.type === "restore") restore(data.annotations);
  else if (data.type === "remove") removeAnnotation(data.id);
}

/**
 * Adopt the shell's list, re-binding elements by stored selector.
 * @param {unknown} list - candidate annotations.
 */
function restore(list) {
  if (!Array.isArray(list)) return;
  var kept = [];
  elements.clear();
  list.forEach(function (candidate) {
    if (candidate === null || typeof candidate !== "object") return;
    if (typeof candidate.id !== "string" || candidate.id === "") return;
    if (typeof candidate.comment !== "string" || candidate.comment === "") return;
    kept.push(candidate);
    var numeric = Number(String(candidate.id).replace(/^a/, ""));
    if (Number.isFinite(numeric) && numeric > state.seq) state.seq = numeric;
    if (typeof candidate.selector === "string" && candidate.selector !== "") {
      var element = document.querySelector(candidate.selector);
      if (element !== null) elements.set(candidate.id, element);
    }
  });
  state.annotations = kept;
  renderBadges();
}

/** Start the overlay once the document has a body. */
function start() {
  if (document.querySelector("[" + ROOT_ATTR + "-layer]") !== null) return;
  installStyles();
  installLayer();
  document.addEventListener("mousemove", onPointerMove, true);
  window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: false });
  // Fallback for environments generating only mouse events; pointerdown has
  // already opened the editor in normal browsers, so suppress duplicate opens.
  window.addEventListener("mousedown", function (event) {
    if (state.editing !== null) blockPageActivation(event);
    else onPointerDown(event);
  }, { capture: true, passive: false });
  ["pointerup", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "touchstart", "touchend", "submit"].forEach(function (type) {
    window.addEventListener(type, blockPageActivation, { capture: true, passive: false });
  });
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("message", onMessage);
  window.addEventListener("resize", reposition);
  document.addEventListener("scroll", reposition, true);
  var tag = make("div", { class: ROOT_ATTR + "-tag", style: "display:none" });
  hoverBox.appendChild(tag);
  setMode("browse");
  post({ type: "ready" });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
