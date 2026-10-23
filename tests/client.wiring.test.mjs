/**
 * Client-half wiring test.
 *
 * `lib/client.js` is a loader bundle, not a module, so this loads it the way the
 * shell does: install a `window.__ModuleLoader__` capture shim, run the factory
 * with a `require` that answers the shared module table, and then drive the
 * registrations `apply` makes. That catches the failures a browser test cannot
 * see — a wrong seat name, a missing `key`, an inject face that loses the
 * session id — and renders the tab body with real React to prove it mounts.
 *
 * Effects do not run here (server rendering); the overlay's own behaviour is
 * covered by `tests/overlay.browser.test.mjs`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as react from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

const BUNDLE_ID = "dsh-page-annotate";

/**
 * Load the bundle and return its exports.
 * @param {object} options - loader environment.
 * @param {object} [options.document] - the DOM document the bundle stamps CSS into.
 * @returns the bundle exports.
 */
async function loadBundle({ document, reactOverride, windowOverride } = {}) {
  const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  let registration;
  const window = {
    ...windowOverride,
    __ModuleLoader__: {
      load(value) {
        registration = value;
      }
    }
  };
  const table = new Map([
    ["react", reactOverride ?? react],
    ["react/jsx-runtime", jsxRuntime]
  ]);
  const require = (name) => {
    if (!table.has(name)) throw new Error(`unexpected require("${name}") in the client bundle`);
    return table.get(name);
  };
  // eslint-disable-next-line no-new-func
  const run = new Function("window", "document", source);
  run(window, document);
  assert.ok(registration !== undefined, "the bundle registers itself with __ModuleLoader__");
  assert.equal(registration.id, BUNDLE_ID);
  return registration.factory(require);
}

/**
 * A document stub good enough for the CSS injection and element creation.
 * @returns {{document: object, styles: object[]}} the stub and what it collected.
 */
function documentStub() {
  const styles = [];
  const head = {
    appendChild(node) {
      styles.push(node);
      return node;
    }
  };
  return {
    styles,
    document: {
      head,
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" })
    }
  };
}

/**
 * A recording stand-in for the client root context.
 *
 * `readBytes` answers the Remote's real `{ ok, value }` envelope — not the bare
 * payload. Stubbing the payload directly once hid a blank-page bug, so the
 * shape here is deliberate.
 * @param {object} [options] - overrides.
 * @param {Uint8Array} [options.bytes] - the bytes the Remote reports.
 * @returns {object} the stub context and what it recorded.
 */
function contextStub({ bytes = new Uint8Array() } = {}) {
  const recorded = { effects: [], slots: [], tabTypes: [], dictionaries: [], reads: [] };
  const ctx = {
    effect(fn, label) {
      recorded.effects.push(label);
      fn();
    },
    locale: {
      register(ns, dicts) {
        recorded.dictionaries.push({ ns, dicts });
      }
    },
    documentPreviews: { register: () => {} },
    uiConversation: { userText: { register: () => () => {} } },
    sidebarRightTabs: {
      register(definition) {
        recorded.tabTypes.push(definition);
      }
    },
    slots: {
      inject(seat, fn) {
        fn();
      },
      register(header, component) {
        recorded.slots.push({ ...header, component });
      }
    },
    get: () => undefined,
    sidebarRight: { openResourceIn: () => {} },
    sessions: { binding: () => undefined },
    remote: {
      workspaceFiles: {
        async readBytes(sessionId, path, options, signal) {
          recorded.reads.push({ sessionId, path, options, signal });
          return { ok: true, value: { data: bytes, offset: 0, eof: true, absolutePath: path, version: "v1" } };
        }
      }
    }
  };
  return { ctx, recorded };
}

test("the bundle exports the host-facing apply and a service inject list", async () => {
  const exports = await loadBundle({ document: documentStub().document });
  assert.equal(typeof exports.apply, "function");
  assert.ok(Array.isArray(exports.inject), "inject is a service-name array");
  for (const service of ["slots", "locale", "sessions", "sidebarRight", "sidebarRightTabs"]) {
    assert.ok(exports.inject.includes(service), `inject declares ${service}`);
  }
});

test("apply registers the dictionaries, the tab type, the body, and the document action", async () => {
  const { document, styles } = documentStub();
  const exports = await loadBundle({ document });
  const { ctx, recorded } = contextStub();
  exports.apply(ctx);

  assert.equal(styles.length, 1, "one stylesheet is stamped");
  assert.equal(styles[0].dataset.plugin, BUNDLE_ID);

  assert.deepEqual(
    recorded.dictionaries.map((entry) => entry.ns),
    ["dsh-page-annotate"]
  );
  const { dicts } = recorded.dictionaries[0];
  assert.deepEqual(Object.keys(dicts).sort(), ["en", "zh"]);
  assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort(), "both dictionaries carry the same keys");
  assert.ok(Object.keys(dicts.zh).length > 10);

  assert.equal(recorded.tabTypes.length, 1);
  const type = recorded.tabTypes[0];
  assert.equal(type.kind, "pageAnnotate");
  assert.equal(type.priority, "builtin");
  assert.equal(type.canOpen("dsh-resource://page-annotate/session/s1/a/b.html"), true);
  assert.equal(type.canOpen("dsh-resource://file/session/s1/a/b.html"), false, "the document preview keeps its own addresses");
  assert.equal(type.canOpen("sidebar://pageAnnotate"), false);
  assert.equal(type.title("dsh-resource://page-annotate/session/s1/dir/%E9%A1%B5.html"), "页.html");

  const seats = recorded.slots.map((slot) => slot.name);
  assert.deepEqual(seats.sort(), ["conversation.user.text.node", "sidebar.right.pane.tab", "sidebar.right.tab.document", "sidebar.right.tab.document.actions"]);
  for (const slot of recorded.slots) {
    assert.equal(typeof slot.component, "function", `${slot.name} has a component`);
    assert.equal(typeof slot.inject, "function");
    assert.equal(slot.locale, "dsh-page-annotate");
  }
});

test("the tab body registers under its own key and its inject carries the session-scoped capabilities", async () => {
  const exports = await loadBundle({ document: documentStub().document });
  const { ctx, recorded } = contextStub();
  exports.apply(ctx);

  const body = recorded.slots.find((slot) => slot.name === "sidebar.right.pane.tab");
  assert.equal(body.key, "dsh-page-annotate/tab", "a keyed seat needs the key the tab type opened");

  const injected = body.inject("session-42");
  assert.equal(typeof injected.readDocument, "function");
  assert.equal(typeof injected.insertDraft, "function");
  assert.equal(injected.sessions, ctx.sessions);
  // The session id is captured per registration, so a file read targets the
  // Session that owns the tab rather than whatever is mounted now.
  assert.equal(injected.insertDraft("session-42", "text"), false, "no composer in this stub");
});

test("an absolute path survives the address, including Chinese and a leading slash", async () => {
  // The document action's `absolutePath` is what an actual preview supplies, so
  // the address has to carry `/Users/...` verbatim: dropping the leading slash
  // would make the Host resolve it against the workspace root instead.
  const exports = await loadBundle({ document: documentStub().document });
  const opened = [];
  const { ctx, recorded } = contextStub();
  ctx.sidebarRight.openResourceIn = (sessionId, address, options) => {
    opened.push({ sessionId, address, options });
  };
  exports.apply(ctx);
  const action = recorded.slots.find((slot) => slot.name === "sidebar.right.tab.document.actions");

  const absolute = "/Users/baigo/Documents/workspace/baigo_vault/LEHE/业务需求/2026/页面 设计.html";
  action.inject("sess-9").openAnnotate("sess-9", absolute, "source-tab-9");

  const { address, sessionId } = opened[0];
  assert.equal(sessionId, "sess-9");
  const type = recorded.tabTypes[0];
  assert.equal(type.canOpen(address), true);
  assert.equal(type.title(address), "页面 设计.html");

  // The body recovers the same path the action was handed.
  const body = recorded.slots.find((slot) => slot.name === "sidebar.right.pane.tab");
  const markup = renderToStaticMarkup(
    react.createElement(body.component, {
      sessionId: "sess-9",
      t: (key) => key,
      useTabInfo: () => ({ tab: { id: "tab-9", contentId: address } }),
      ...body.inject("sess-9")
    })
  );
  assert.match(markup, /页面 设计\.html/, "the tab shows the file it annotates");
});

test("the document action opens an address its own tab type can claim", async () => {
  const exports = await loadBundle({ document: documentStub().document });
  const opened = [];
  const { ctx, recorded } = contextStub();
  ctx.sidebarRight.openResourceIn = (sessionId, address, options) => {
    opened.push({ sessionId, address, options });
  };
  exports.apply(ctx);

  const action = recorded.slots.find((slot) => slot.name === "sidebar.right.tab.document.actions");
  assert.equal(action.id, "page-annotate");
  const injected = action.inject("session-42");
  // Missing occurrence must never fall back to creating another tab.
  injected.openAnnotate("session-42", "/work/业务需求/页面 设计.html");
  assert.equal(opened.length, 0);
  const button = action.component({ absolutePath: "/work/业务需求/页面 设计.html", t: (key) => key, ...injected });
  button.props.onClick({ currentTarget: { closest: (selector) => {
    assert.equal(selector, "[data-sidebar-right-tab]");
    return { getAttribute: () => "source-tab-42" };
  } } });

  assert.equal(opened.length, 1);
  assert.equal(opened[0].sessionId, "session-42");
  assert.deepEqual(opened[0].options, { replaceTab: "source-tab-42", revealIfOpened: false });
  const type = recorded.tabTypes[0];
  assert.equal(type.canOpen(opened[0].address), true, "the opened address round-trips through canOpen");
  assert.equal(type.title(opened[0].address), "页面 设计.html");
});

test("the action renders for HTML only and names the file it annotates", async () => {
  const exports = await loadBundle({ document: documentStub().document });
  const { ctx, recorded } = contextStub();
  exports.apply(ctx);
  const action = recorded.slots.find((slot) => slot.name === "sidebar.right.tab.document.actions");
  const injected = action.inject("s1");
  const t = (key) => key;

  const html = renderToStaticMarkup(
    react.createElement(action.component, { absolutePath: "/w/page.html", sessionId: "s1", t, ...injected })
  );
  assert.match(html, /data-dpa-open/);

  for (const other of ["/w/page.md", "/w/book.xlsx", undefined]) {
    const markup = renderToStaticMarkup(
      react.createElement(action.component, { absolutePath: other, sessionId: "s1", t, ...injected })
    );
    assert.equal(markup, "", `${String(other)} is not annotatable`);
  }
});

test("readDocument unwraps the Remote envelope and reads through the tab's own session", async () => {
  // The regression this covers: reading `result.data` instead of
  // `result.value.data` returns undefined, decodes to "", and renders a blank
  // page with no error at all.
  const bytes = new TextEncoder().encode("<!doctype html><p>hello</p>");
  const exports = await loadBundle({ document: documentStub().document });
  const { ctx, recorded } = contextStub({ bytes });
  exports.apply(ctx);
  const body = recorded.slots.find((slot) => slot.name === "sidebar.right.pane.tab");
  const injected = body.inject("session-42");

  const signal = AbortSignal.abort();
  const data = await injected.readDocument("/w/page.html", signal);

  assert.ok(data instanceof Uint8Array, "readDocument hands back the bytes, not the envelope");
  assert.equal(new TextDecoder().decode(data), "<!doctype html><p>hello</p>");
  assert.equal(recorded.reads.length, 1);
  assert.equal(recorded.reads[0].sessionId, "session-42", "the read targets the tab's Session");
  assert.equal(recorded.reads[0].path, "/w/page.html");
  assert.deepEqual(recorded.reads[0].options, {}, "an empty options bag asks for the whole file");
  assert.equal(recorded.reads[0].signal, signal);
});

test("readDocument surfaces a failed read instead of rendering an empty page", async () => {
  const exports = await loadBundle({ document: documentStub().document });
  const { ctx, recorded } = contextStub();
  ctx.remote.workspaceFiles.readBytes = async () => ({
    ok: false,
    error: { code: "workspace-file/not-found", message: "\"/w/gone.html\" does not exist" }
  });
  exports.apply(ctx);
  const body = recorded.slots.find((slot) => slot.name === "sidebar.right.pane.tab");

  await assert.rejects(() => body.inject("s1").readDocument("/w/gone.html", AbortSignal.abort()), /does not exist/);
});

test("the tab body renders its chrome, hint, and disabled actions", async () => {
  const exports = await loadBundle({ document: documentStub().document });
  const { ctx, recorded } = contextStub();
  exports.apply(ctx);
  const body = recorded.slots.find((slot) => slot.name === "sidebar.right.pane.tab");
  const t = (key, params) =>
    key === "count.many" || key === "count.one" ? `${params?.count ?? 1}` : key;

  const markup = renderToStaticMarkup(
    react.createElement(body.component, {
      sessionId: "s1",
      t,
      useTabInfo: () => ({ tab: { id: "tab-1", contentId: "dsh-resource://page-annotate/session/s1/a/b.html" } }),
      ...body.inject("s1")
    })
  );

  assert.match(markup, /data-dpa-root/);
  // No effect has run, so the tab is still in its loading phase.
  assert.match(markup, /data-dpa-phase="loading"/);
  assert.match(markup, /status\.loading/);
  assert.match(markup, /empty\.count/);
  assert.match(markup, /hint\.pick/);
  assert.match(markup, /aria-pressed="true"/);
  // Nothing to send yet.
  assert.match(markup, /disabled/);
});

test("send combines a real image block with notes and retains notes on capture failure", async () => {
  for (const outcome of ["success", "capture-failure", "send-failure"]) {
    const fail = outcome === "capture-failure";
    const returns = [];
    const sends = [];
    const statuses = [];
    const hooks = {
      ...react,
      useState: (initial) => [typeof initial === "function" ? initial() : initial, (value) => statuses.push(value)],
      useRef: (current) => ({ current }),
      useEffect: () => {}, useCallback: (fn) => fn
    };
    const exports = await loadBundle({ document: documentStub().document, reactOverride: hooks });
    const { ctx, recorded } = contextStub();
    ctx.sessions.binding = () => ({ session: { prompt: async (...args) => { sends.push(args); return outcome === "send-failure" ? { ok: false, error: { message: "rejected" } } : { ok: true }; } } });
    ctx.sidebarRight.openResourceIn = (...args) => returns.push(args);
    exports.apply(ctx);
    const body = recorded.slots.find((slot) => slot.name === "sidebar.right.pane.tab");
    // Seed the annotation-state hook; actual PNG bytes are covered by the
    // Chromium capture tests. This test covers only image-block transport.
    hooks.useState = (initial) => {
      const value = typeof initial === "function" ? initial() : initial;
      return [Array.isArray(value) ? [{ id: "a1", kind: "change", comment: "加粗", locator: "th" }] : value, (next) => statuses.push(next)];
    };
    const image = { type: "image", mediaType: "image/png", data: "aGVsbG8=", name: "页面批注.png" };
    const root = body.component({
      sessionId: "s1", t: (key) => key,
      useTabInfo: () => ({ tab: { id: "annotate-7", contentId: "dsh-resource://page-annotate/session/s1//Users/me/%E9%A1%B5%20%E9%9D%A2.html" } }),
      ...body.inject("s1"),
      capturePreview: async () => { if (fail) throw new Error("capture blocked"); return image; }
    });
    const foot = root.props.children.at(-1);
    foot.props.children.at(-1).props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
    if (outcome !== "success") {
      assert.equal(returns.length, 0, "failure keeps annotation preview open");
      assert.ok(!statuses.some((value) => Array.isArray(value) && value.length === 0), "failure retains notes");
    } else {
      assert.deepEqual(returns, [["s1", "dsh-resource://file/session/s1//Users/me/%E9%A1%B5%20%E9%9D%A2.html", { replaceTab: "annotate-7", revealIfOpened: false }]]);
    }
    if (fail) {
      assert.equal(sends.length, 0, "capture failure must not silently send text alone");
      assert.ok(statuses.includes("capture.failed"));
      assert.ok(!statuses.some((value) => Array.isArray(value) && value.length === 0), "notes are retained");
    } else {
      assert.equal(sends.length, 1);
      assert.equal(sends[0][1], "queue");
      assert.deepEqual(sends[0][0][1], { ...image, name: "截图01-批注1.png" });
      assert.match(sends[0][0][0].text, /^\[DSH_PAGE_ANNOTATIONS_V1 count=1 images=1\]/);
      assert.match(sends[0][0][0].text, /附图 1（S1）对应批注 1/);
      assert.match(sends[0][0][0].text, /加粗/);
    }
  }
});

test("iframe ready enters pick immediately and a later ready respects Esc", async () => {
  const effects = [];
  const refs = [];
  const messages = [];
  const listeners = new Map();
  const hooks = {
    ...react,
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useRef: (current) => { const ref = { current }; refs.push(ref); return ref; },
    useEffect: (effect) => effects.push(effect),
    useCallback: (fn) => fn
  };
  const exports = await loadBundle({
    document: documentStub().document,
    reactOverride: hooks,
    windowOverride: {
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: (name) => listeners.delete(name)
    }
  });
  const { ctx, recorded } = contextStub();
  exports.apply(ctx);
  const body = recorded.slots.find((slot) => slot.name === "sidebar.right.pane.tab");
  const root = body.component({
    sessionId: "s1", t: (key) => key,
    useTabInfo: () => ({ tab: { contentId: "dsh-resource://page-annotate/session/s1/a.html" } }),
    ...body.inject("s1")
  });
  const contentWindow = { postMessage: (message) => messages.push(message) };
  refs[0].current = { contentWindow };
  const cleanup = effects.map((effect) => effect());
  const ready = () => listeners.get("message")({ source: contentWindow, data: { channel: BUNDLE_ID, type: "ready" } });
  ready();
  assert.equal(messages.at(-1).mode, "pick");
  root.props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  assert.equal(messages.at(-1).mode, "browse");
  ready();
  assert.equal(messages.at(-1).mode, "browse", "a late iframe ready cannot undo Esc");
  for (const dispose of cleanup) if (typeof dispose === "function") dispose();
});
