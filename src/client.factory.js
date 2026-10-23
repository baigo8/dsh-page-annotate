/**
 * Browser half of dsh-page-annotate.
 *
 * This file is a factory body, not a module: `tools/build.mjs` wraps it in the
 * `window.__ModuleLoader__.load({ id, factory })` envelope, and `src/core.mjs`
 * is concatenated above it inside the same factory (so the CORE helpers are in
 * lexical scope here, and the same text is later injected into the previewed
 * page). Only globals the loader provides may be used: `require`, `react`,
 * `react_jsx_runtime`, plus the concatenated CORE bindings.
 *
 * The page under annotation is untrusted as far as the shell is concerned: it
 * runs in a sandboxed frame, and every field it posts is re-validated by
 * `normalizeAnnotations` before it reaches a prompt.
 */

const e = react.createElement;

/** Locale namespace owned by this plugin. */
const NS = "dsh-page-annotate";

/** The postMessage channel shared with the injected overlay. */
const CHANNEL = "dsh-page-annotate";

/** This implementation's identity in the tab system: the key body and title register under. */
const ANNOTATE_ID = "dsh-page-annotate/tab";

/** The tab kind this package owns. */
const ANNOTATE_KIND = "pageAnnotate";

/** Authority segment of this plugin's resource addresses. */
const ADDRESS_HOST = "page-annotate";

/** Dictionary, registered under {@link NS}. */
const zh = {
  "action.open": "批注",
  "action.open.title": "在批注模式下打开这个页面",
  "tool.pick": "选择元素",
  "tool.pick.on": "退出选择",
  "tool.reload": "重新读取文件",
  "tool.clear": "清空批注",
  "hint.pick": "点击页面元素添加批注，按 Esc 退出",
  "hint.browse": "点击“选择元素”开始批注",
  "empty.count": "暂无批注",
  "count.one": "1 条批注",
  "count.many": "{count} 条批注",
  "send": "发送到会话",
  "send.title": "把批注作为一条消息发给会话，让模型按批注修改这个页面",
  "insert": "填入输入框",
  "insert.title": "把批注写进输入框，你可以补充说明后再发送",
  "status.loading": "正在读取文件…",
  "status.sent": "已发送到会话",
  "status.inserted": "已填入输入框",
  "status.insertFailed": "输入框暂不可用，请手动粘贴",
  "status.noBinding": "找不到该会话，无法发送",
  "status.sendFailed": "发送失败：{message}",
  "status.nothing": "还没有批注",
  "status.failed": "无法读取这个文件：{message}",
  "capture.include": "附带截图",
  "capture.title": "保存每条批注时留存可视区域，发送时附带对应截图；缺失时补拍并注明。最多12条截图、20MiB base64。填入输入框仅填文字。",
  "capture.working": "正在生成页面截图…",
  "capture.failed": "截图失败：{message}。批注未发送，可重试或取消“附带截图”后发送。",
  "capture.context": "附图来自各条批注保存时的可视区域；如为补拍，以对应表说明为准。按图片附件顺序和对应表匹配批注，不要把不同截图中的同名区域混用。未显示区域以文字定位为准。蓝色编号等批注标记仅供定位，不属于页面设计，禁止写入最终页面。",
  "status.sending": "正在发送…",
};

const en = {
  "action.open": "Annotate",
  "action.open.title": "Open this page in annotation mode",
  "tool.pick": "Pick element",
  "tool.pick.on": "Exit picking",
  "tool.reload": "Re-read file",
  "tool.clear": "Clear annotations",
  "hint.pick": "Click an element to annotate it; press Esc to stop",
  "hint.browse": "Choose “Pick element” to start annotating",
  "empty.count": "No annotations",
  "count.one": "1 annotation",
  "count.many": "{count} annotations",
  "send": "Send to session",
  "send.title": "Send the annotations as one message so the model revises this page",
  "insert": "Put in composer",
  "insert.title": "Write the annotations into the composer so you can add context first",
  "status.loading": "Reading the file…",
  "status.sent": "Sent to the session",
  "status.inserted": "Written into the composer",
  "status.insertFailed": "The composer is unavailable; paste manually",
  "status.noBinding": "This session is no longer available",
  "status.sendFailed": "Send failed: {message}",
  "status.nothing": "Nothing annotated yet",
  "status.failed": "This file could not be read: {message}",
  "capture.include": "Include screenshot",
  "capture.title": "Attach the current viewport and annotation markers when sending; offscreen elements are not shown. Composer insertion is text only.",
  "capture.working": "Capturing the preview…",
  "capture.failed": "Screenshot failed: {message}. Nothing sent; retry or disable Include screenshot.",
  "capture.context": "The image shows the current viewport and annotation numbers; use text locators for offscreen elements. Blue annotation badges are temporary references, not design content: never implement them in the final page.",
  "status.sending": "Sending…",
};

/** Services this bundle reads. */
const inject = [
  "slots",
  "remote",
  "remote.workspaceFiles",
  "locale",
  "sessions",
  "conversation",
  "sidebarRight",
  "sidebarRightTabs",
  "documentPreviews",
  "uiConversation"
];

/** Stylesheet shipped with the plugin. */
const css = [
  ".dpa_root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}",
  ".dpa_bar{display:flex;align-items:center;gap:8px;flex:none;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}",
  ".dpa_path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-secondary)}",
  ".dpa_btn{flex:none;padding:3px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}",
  ".dpa_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
  ".dpa_btn[aria-pressed=true]{background:#0b62b4;border-color:#0b62b4;color:#fff}",
  ".dpa_btn[disabled]{opacity:.5;cursor:default}",
  ".dpa_count{flex:none;color:var(--dsw-alias-label-tertiary)}",
  ".dpa_stage{position:relative;flex:1;min-height:0;background:var(--dsw-alias-bg-document-preview)}",
  ".dpa_frame{display:block;width:100%;height:100%;border:0;background:#fff}",
  ".dpa_overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}",
  ".dpa_foot{display:flex;align-items:center;gap:8px;flex:none;padding:6px 10px;border-top:1px solid var(--dsw-alias-border-l1)}",
  ".dpa_status{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary)}",
  ".dpa_status[data-tone=error]{color:var(--dsw-alias-state-warn-label,#c0362c)}",
  ".dpa_primary{background:#0b62b4;border-color:#0b62b4;color:#fff}",
  ".dpa_list{flex:none;max-height:34%;overflow:auto;border-top:1px solid var(--dsw-alias-border-l1)}",
  ".dpa_row{display:flex;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;align-items:flex-start}",
  ".dpa_row:last-child{border-bottom:0}",
  ".dpa_kind{flex:none;padding:0 5px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px}",
  ".dpa_body{flex:1;min-width:0;word-break:break-word}",
  ".dpa_loc{display:block;font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all}",
  ".dpa_drop{flex:none;border:0;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px;line-height:1;padding:0 2px}",
  ".dpa_drop:hover{color:#c0362c}"
].join("\n");

/**
 * Escape one path segment for an address.
 * @param {string} segment - raw segment.
 * @returns the encoded segment.
 */
function encodeSegment(segment) {
  return encodeURIComponent(segment).replace(/%3A/gi, ":");
}

/**
 * Normalize and encode a file path for an address.
 * @param {string} path - absolute or workspace-relative path.
 * @returns the encoded path.
 */
function encodePath(path) {
  return String(path)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .split("/")
    .map(encodeSegment)
    .join("/");
}

/**
 * The address one annotated page is recorded under.
 *
 * The address carries both the Session and the file path, and the layout store
 * persists it as the tab's contentId — which is why an annotation tab still
 * knows what it shows after a reload, with no separate bridge to keep alive.
 * @param {string} sessionId - owning Session.
 * @param {string} path - the file being annotated.
 * @returns the resource address.
 */
function annotateAddress(sessionId, path) {
  return `dsh-resource://${ADDRESS_HOST}/session/${encodeSegment(sessionId)}/${encodePath(path)}`;
}

/**
 * Read a Session and path back out of an address.
 * @param {unknown} address - candidate address.
 * @returns the parsed target, or undefined when another type owns it.
 */
function parseAnnotateAddress(address) {
  if (typeof address !== "string" || !address.startsWith("dsh-resource://")) return undefined;
  let url;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if (url.hostname !== ADDRESS_HOST) return undefined;
  const parts = url.pathname.replace(/^\/+/, "").split("/");
  if (parts[0] !== "session") return undefined;
  const sessionId = decodeURIComponent(parts[1] ?? "");
  const path = parts.slice(2).map((part) => decodeURIComponent(part)).join("/");
  if (sessionId === "" || path === "") return undefined;
  return { sessionId, path };
}

/**
 * The file name an address shows.
 * @param {string} path - the file path.
 * @returns the basename.
 */
function basenameOf(path) {
  const parts = String(path).replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || String(path);
}

/**
 * Whether a document action should offer annotation: HTML only.
 * @param {unknown} absolutePath - the previewed file's absolute path.
 * @returns true for `.html`/`.htm`.
 */
function isHtmlPath(absolutePath) {
  return typeof absolutePath === "string" && /\.html?$/i.test(absolutePath);
}

/**
 * Splice the overlay into a document so the shell can talk to the page.
 * @param {string} html - the file's own markup.
 * @param {string} source - the overlay program text.
 * @returns the document to render.
 */
function withOverlay(html, source) {
  const tag = `<script data-${CHANNEL}-overlay>${source.replace(/<\/script/gi, "<\\/script")}</script>`;
  const body = /<\/body\s*>/i.exec(html);
  if (body !== null) return `${html.slice(0, body.index)}${tag}${html.slice(body.index)}`;
  const head = /<\/html\s*>/i.exec(html);
  if (head !== null) return `${html.slice(0, head.index)}${tag}${html.slice(head.index)}`;
  return `${html}${tag}`;
}

/** One annotation list per annotated page, surviving tab switches and remounts. */
const pageAnnotations = new Map();
// Mounted ordinary HTML previews expose a mode switch, not a navigation.
const livePreviewControllers = new Map();
const HTML_PREVIEW_ID = "dsh-page-annotate/html";

function EmbeddedPreview(props) {
  const readDocument = react.useCallback(async () => props.content.data, [props.content.data]);
  return e(AnnotateTab, { ...props, embedded: true, readDocument });
}

/**
 * Annotation tabs, keyed by the address they were opened at.
 * @param {string} address - the page address.
 * @returns the live list for that address.
 */
function annotationsFor(address) {
  let list = pageAnnotations.get(address);
  if (list === undefined) {
    list = [];
    pageAnnotations.set(address, list);
  }
  return list;
}

/**
 * Optionally inject the overlay program; the build replaces this with the
 * concatenated core + overlay text, so a development run without a build
 * degrades to a plainly rendered page rather than failing to load.
 * @type {string}
 */
const OVERLAY_SOURCE = typeof __DPA_OVERLAY__ === "string" ? __DPA_OVERLAY__ : "";
const CAPTURE_SOURCE = typeof __DPA_CAPTURE__ === "string" ? __DPA_CAPTURE__ : "";

/**
 * The tab body: one sandboxed frame plus the annotation chrome around it.
 * @param {object} props - injected capabilities and locale binding.
 * @returns the rendered tab.
 */
function AnnotateTab(props) {
  const { sessionId, t, useTabInfo, readDocument } = props;
  const { tab } = useTabInfo();
  const address = tab.contentId;
  const parsed = parseAnnotateAddress(address.replace(/^dsh-resource:\/\/file\//, "dsh-resource://page-annotate/"));
  const owner = parsed === undefined ? sessionId : parsed.sessionId;
  const path = parsed === undefined ? "" : parsed.path;
  const signal = tab.signal;

  const frameRef = react.useRef(null);
  const [phase, setPhase] = react.useState("loading");
  const [failure, setFailure] = react.useState("");
  const [html, setHtml] = react.useState("");
  const [revision, setRevision] = react.useState(0);
  const [annotating, setAnnotating] = react.useState(!props.embedded);
  const [picking, setPicking] = react.useState(!props.embedded);
  // ready may arrive again after reload: use the latest user intent, not a
  // stale effect closure, so Esc is not undone by a late iframe handshake.
  const pickingRef = react.useRef(picking);
  pickingRef.current = picking;
  const [annotations, setAnnotations] = react.useState(() => annotationsFor(address).slice());
  const [includeScreenshot, setIncludeScreenshot] = react.useState(true);
  const includeScreenshotRef = react.useRef(includeScreenshot);
  includeScreenshotRef.current = includeScreenshot;
  const [sending, setSending] = react.useState(false);
  const sendingRef = react.useRef(false);
  const [status, setStatus] = react.useState("");
  const [tone, setTone] = react.useState("info");
  const captureRef = react.useRef(props.capturePreview);
  captureRef.current = props.capturePreview;
  const snapshotRef = react.useRef(null);
  if (snapshotRef.current === null) snapshotRef.current = createAnnotationSnapshots({ capture: (frame, options) => captureRef.current(frame, options) });
  react.useEffect(() => () => snapshotRef.current.clear(), [address]);

  react.useEffect(() => {
    annotationsFor(address).forEach(() => {});
    setAnnotations(annotationsFor(address).slice());
  }, [address]);

  react.useEffect(() => {
    if (!props.embedded) return;
    const key = `${owner}:${tab.id}`;
    const enter = () => {
      pickingRef.current = true;
      setAnnotating(true);
      setPicking(true);
      frameRef.current?.contentWindow?.postMessage({ channel: CHANNEL, type: "mode", mode: "pick" }, "*");
    };
    livePreviewControllers.set(key, enter);
    return () => { if (livePreviewControllers.get(key) === enter) livePreviewControllers.delete(key); };
  }, [props.embedded, owner, tab.id]);

  // Read the file. The tab's own signal retires the request with the tab.
  react.useEffect(() => {
    let live = true;
    setPhase("loading");
    setFailure("");
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    signal?.addEventListener?.("abort", abort);
    readDocument(path, controller.signal).then(
      (bytes) => {
        if (!live) return;
        const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        setHtml(withOverlay(text, OVERLAY_SOURCE));
        setPhase("ready");
      },
      (error) => {
        if (!live) return;
        setFailure(String((error && error.message) || error));
        setPhase("failed");
      }
    );
    return () => {
      live = false;
      controller.abort();
      signal?.removeEventListener?.("abort", abort);
    };
  }, [path, revision, readDocument, signal]);

  const publish = react.useCallback(
    (next) => {
      const store = annotationsFor(address);
      store.length = 0;
      for (const annotation of next) store.push(annotation);
      setAnnotations(next.slice());
    },
    [address]
  );

  // Frame -> shell. Only this tab's own frame is trusted.
  react.useEffect(() => {
    const onMessage = (event) => {
      const frame = frameRef.current;
      if (frame === null || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (data === null || typeof data !== "object" || data.channel !== CHANNEL) return;
      if (data.type === "ready") {
        const frame2 = frameRef.current;
        frame2?.contentWindow?.postMessage(
          { channel: CHANNEL, type: "restore", annotations: annotationsFor(address) },
          "*"
        );
        frame2?.contentWindow?.postMessage({ channel: CHANNEL, type: "mode", mode: pickingRef.current ? "pick" : "browse" }, "*");
      } else if (data.type === "change") {
        const next = normalizeAnnotations(data.annotations);
        publish(next);
        // Capture at save time, before the user changes dialog or scroll state.
        // Per-note images remain local until this batch is actually sent.
        if (includeScreenshotRef.current) {
          snapshotRef.current.update(next, frame).then(({ errors }) => {
            if (errors.length) {
              setTone("error");
              setStatus(t("capture.failed", { message: String(errors[0].error?.message ?? errors[0].error) }));
            }
          });
        }
      } else if (data.type === "exit-pick") {
        setPicking(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [address, publish]);

  // Shell -> frame.
  react.useEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    frame.contentWindow?.postMessage({ channel: CHANNEL, type: "mode", mode: picking ? "pick" : "browse" }, "*");
  }, [picking, html, phase]);

  const ready = phase === "ready";

  const send = react.useCallback(async () => {
    const text = compileMessage({ path, title: basenameOf(path), annotations });
    if (text === "") {
      setTone("info");
      setStatus(t("status.nothing"));
      return;
    }
    const binding = props.sessions.binding(owner);
    if (binding === undefined) {
      setTone("error");
      setStatus(t("status.noBinding"));
      return;
    }
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setTone("info");
    try {
      const content = [{ type: "text", text }];
      if (includeScreenshot) {
        setStatus(t("capture.working"));
        try {
          const batch = await snapshotRef.current.collect(annotations, frameRef.current);
          const mapping = batch.images.map((entry, imageIndex) => {
            const numbers = annotations.map((annotation, index) => entry.annotationIds.includes(annotation.id) ? index + 1 : null).filter((number) => number !== null);
            const imageId = `S${imageIndex + 1}`;
            content.push({ ...entry.image, name: `截图${String(imageIndex + 1).padStart(2, "0")}-批注${numbers.join("、")}.png` });
            const badges = entry.annotationIds.map((id) => {
              const current = annotations.findIndex((annotation) => annotation.id === id) + 1;
              const captured = entry.capturedNumbers?.find((item) => item.annotationId === id)?.number;
              return `批注${current}→捕获任务创建时编号${captured ?? "未知"}`;
            }).join("；");
            return `- 附图 ${imageIndex + 1}（${imageId}）对应批注 ${numbers.join("、")}。编号参考：${badges}。${entry.scope === "saved" ? "保存该批注时的视口。" : "补拍/排队后捕获的视口，不保证是保存批注瞬间。"}${entry.note || ""}`;
          });
          content[0].text += `\n\n${t("capture.context")}\n\n截图与批注对应表（按消息中图片附件顺序）：\n${mapping.join("\n")}`;
        } catch (error) {
          setTone("error");
          setStatus(t("capture.failed", { message: String(error?.message ?? error) }));
          return;
        }
      }
      content[0].text = wrapAnnotationMessage(content[0].text, { count: annotations.length, imageCount: content.length - 1 });
      setStatus(t("status.sending"));
      const result = await binding.session.prompt(content, "queue");
      if (result.ok === true) {
        snapshotRef.current.clear();
        publish([]);
        setPicking(false);
        setStatus(t("status.sent"));
        // Only an accepted prompt exits annotation. Replacing this occurrence
        // restores the built-in renderer and removes the entire overlay frame.
        if (props.embedded) {
          pickingRef.current = false;
          frameRef.current?.contentWindow?.postMessage({ channel: CHANNEL, type: "mode", mode: "browse" }, "*");
          frameRef.current?.contentWindow?.postMessage({ channel: CHANNEL, type: "restore", annotations: [] }, "*");
          setAnnotating(false);
        } else props.returnToPreview(owner, path, tab.id);
        return;
      }
      setTone("error");
      setStatus(t("status.sendFailed", { message: String(result.error?.message ?? result.error?.code ?? "") }));
    } catch (error) {
      setTone("error");
      setStatus(t("status.sendFailed", { message: String((error && error.message) || error) }));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [annotations, includeScreenshot, owner, path, tab.id, props.sessions, props.returnToPreview, publish, t]);

  const insert = react.useCallback(() => {
    const text = compileMessage({ path, title: basenameOf(path), annotations });
    if (text === "") {
      setTone("info");
      setStatus(t("status.nothing"));
      return;
    }
    const outcome = props.insertDraft(owner, text);
    if (outcome === true) {
      setTone("info");
      setStatus(t("status.inserted"));
      return;
    }
    setTone("error");
    setStatus(t("status.insertFailed"));
  }, [annotations, owner, path, props.insertDraft, t]);

  const rows = annotations.map((annotation, index) => {
    const drop = () => {
      const next = annotations.filter((entry) => entry.id !== annotation.id);
      publish(next);
      frameRef.current?.contentWindow?.postMessage({ channel: CHANNEL, type: "remove", id: annotation.id }, "*");
      void index;
    };
    return e(
      "div",
      { className: "dpa_row", key: annotation.id, "data-dpa-row": annotation.kind },
      e("span", { className: "dpa_kind" }, KIND_LABELS[annotation.kind]),
      e(
        "span",
        { className: "dpa_body" },
        annotation.locator === "" ? null : e("code", { className: "dpa_loc" }, annotation.locator),
        annotation.comment
      ),
      e("button", { type: "button", className: "dpa_drop", title: t("tool.clear"), onClick: drop }, "×")
    );
  });

  const countText =
    annotations.length === 0
      ? t("empty.count")
      : annotations.length === 1
        ? t("count.one")
        : t("count.many", { count: annotations.length });

  const stage = !ready
    ? e(
      "div",
      { className: "dpa_overlay", "data-dpa-phase": phase },
      phase === "loading" ? t("status.loading") : t("status.failed", { message: failure })
    )
    : e("iframe", {
      ref: frameRef,
      className: "dpa_frame",
      title: basenameOf(path),
      sandbox: "allow-scripts allow-same-origin",
      srcDoc: html,
      "data-dpa-frame": ""
    });

  return e(
    "div",
    {
      className: "dpa_root",
      "data-dpa-root": "",
      onKeyDown: (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        pickingRef.current = false;
        setPicking(false);
        frameRef.current?.contentWindow?.postMessage({ channel: CHANNEL, type: "mode", mode: "browse" }, "*");
      }
    },
    e(
      "div",
      { className: "dpa_bar", style: annotating ? undefined : { display: "none" } },
      e("span", { className: "dpa_path", title: `${path}\nbuild ${typeof BUILD_STAMP === "string" ? BUILD_STAMP : "dev"}` }, basenameOf(path)),
      e("span", { className: "dpa_count" }, countText),
      e(
        "button",
        {
          type: "button",
          className: "dpa_btn",
          "aria-pressed": picking ? "true" : "false",
          disabled: !ready,
          title: picking ? t("tool.pick.on") : t("hint.pick"),
          onClick: () => {
            setPicking((value) => !value);
          }
        },
        picking ? t("tool.pick.on") : t("tool.pick")
      ),
      e(
        "button",
        {
          type: "button",
          className: "dpa_btn",
          title: t("tool.reload"),
          onClick: () => {
            setRevision((value) => value + 1);
          }
        },
        "↻"
      ),
      e(
        "button",
        {
          type: "button",
          className: "dpa_btn",
          title: t("tool.clear"),
          disabled: annotations.length === 0,
          onClick: () => {
            snapshotRef.current.clear();
            publish([]);
            frameRef.current?.contentWindow?.postMessage(
              { channel: CHANNEL, type: "restore", annotations: [] },
              "*"
            );
          }
        },
        t("tool.clear")
      )
    ),
    e("div", { className: "dpa_stage" }, stage),
    e("div", { className: "dpa_list", style: annotating ? undefined : { display: "none" } }, rows.length === 0 ? e("div", { className: "dpa_row" }, countText) : rows),
    e(
      "div",
      { className: "dpa_foot", style: annotating ? undefined : { display: "none" } },
      e("span", { className: "dpa_status", "data-tone": tone, "data-dpa-status": "" }, status !== "" ? status : picking ? t("hint.pick") : t("hint.browse")),
      e("label", { className: "dpa_capture", title: t("capture.title"), style: { display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", whiteSpace: "nowrap" } },
        e("input", { type: "checkbox", checked: includeScreenshot, disabled: sending, onChange: (event) => setIncludeScreenshot(event.target.checked), "data-dpa-capture": "" }),
        t("capture.include")
      ),
      e(
        "button",
        { type: "button", className: "dpa_btn", disabled: annotations.length === 0, title: t("insert.title"), onClick: insert },
        t("insert")
      ),
      e(
        "button",
        {
          type: "button",
          className: "dpa_btn dpa_primary",
          disabled: annotations.length === 0 || sending || !ready,
          title: t("send.title"),
          onClick: () => {
            void send();
          }
        },
        t("send")
      )
    )
  );
}

/**
 * The document-header control that opens a page in annotation mode.
 * @param {object} props - the previewed file's owner and the opening capability.
 * @returns the button, or nothing for a non-HTML file.
 */
function AnnotateAction(props) {
  const { absolutePath, t, openAnnotate, sessionId } = props;
  if (!isHtmlPath(absolutePath)) return null;
  return e(
    "button",
    {
      type: "button",
      className: "dpa_btn",
      title: t("action.open.title"),
      "data-dpa-open": "",
      onClick: (event) => {
        // The document-actions seat does not receive useTabInfo. Capture its
        // enclosing occurrence rather than guessing the session's active tab
        // (which could belong to another docked or floating pane).
        const tabId = event.currentTarget.closest("[data-sidebar-right-tab]")?.getAttribute("data-sidebar-right-tab");
        if (!tabId) return;
        openAnnotate(sessionId, absolutePath, tabId);
      }
    },
    t("action.open")
  );
}

/**
 * Register the plugin's tab type, tab body, and document-header control.
 * @param {object} ctx - client root context.
 */
function apply(ctx) {
  if (typeof document !== "undefined") {
    const tagId = `${NS}/client.css`;
    if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = NS;
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "page-annotate: dictionaries");
  ctx.effect(() => ctx.uiConversation.userText.register(createAnnotationMessageRule()), "page-annotate: folded messages");
  ctx.slots.inject("conversation.user.text.node", () => ctx.slots.register({
    name: "conversation.user.text.node", key: ANNOTATION_MESSAGE_ID, locale: NS, inject: () => ({})
  }, createAnnotationMessageComponent(react)));

  /**
   * The tab type. `canOpen` re-parses the address, so this type claims only
   * addresses it authored and leaves `dsh-resource://file/...` to the
   * document preview.
   */
  const definition = {
    id: ANNOTATE_ID,
    kind: ANNOTATE_KIND,
    priority: "builtin",
    patterns: [`dsh-resource://${ADDRESS_HOST}/[\\s\\S]+`],
    canOpen: (address) => parseAnnotateAddress(address) !== undefined,
    title: (address) => basenameOf(parseAnnotateAddress(address)?.path ?? "")
  };
  ctx.effect(() => ctx.sidebarRightTabs.register(definition), "page-annotate: page tab type");

  const injectPreview = (sessionId) => ({
          sessions: ctx.sessions,
          capturePreview: (frame, options) => capturePreview(frame, CAPTURE_SOURCE, options),
          returnToPreview: (owner, path, tabId) => {
            if (!tabId) return;
            const encode = (part) => encodeURIComponent(part).replace(/%3A/gi, ":");
            const normalized = path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
            const address = `dsh-resource://file/session/${encode(owner)}/${normalized.split("/").map(encode).join("/")}`;
            ctx.sidebarRight.openResourceIn(owner, address, { replaceTab: tabId, revealIfOpened: false });
          },
          readDocument: async (path, signal) => {
            // The Remote answers a `{ ok, value }` envelope, not the payload:
            // reading `result.data` yields `undefined`, decodes to an empty
            // string, and the tab shows a blank page with no error.
            const result = await ctx.remote.workspaceFiles.readBytes(sessionId, path, {}, signal);
            if (result.ok !== true) throw new Error(result.error?.message ?? "read failed");
            return result.value.data;
          },
          insertDraft: (owner, text) => {
            // `input.shell(id)` throws when the Session has no mounted composer
            // (an unmounted tab, or before the Session's binding exists), so a
            // failure here is a status message, never an unhandled rejection.
            let shell;
            try {
              shell = ctx.get("conversation")?.input?.shell?.(owner);
            } catch {
              shell = undefined;
            }
            if (shell === undefined || shell === null) return false;
            const span = shell.actions.captureInsertion();
            if (shell.actions.insertText(text, span) === true) {
              shell.focus();
              return true;
            }
            // The draft moved between capture and insert; the text is on the
            // clipboard path instead of silently vanishing.
            shell.notify("warning", "page-annotate: composer draft changed; paste the annotations manually");
            return false;
          }
        });
  ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab", key: ANNOTATE_ID, locale: NS, inject: injectPreview
  }, AnnotateTab));

  // Use the public external-renderer extension instead of navigating away from
  // the built-in opaque iframe after the user has already opened a dialog.
  ctx.effect(() => ctx.documentPreviews.register({
    id: HTML_PREVIEW_ID, extensions: ["html", "htm"],
    title: () => "HTML · 页面批注", loading: "bytes-complete", wrap: false
  }), "page-annotate: persistent HTML preview");
  ctx.slots.inject("sidebar.right.tab.document", () => ctx.slots.register({
    name: "sidebar.right.tab.document", key: HTML_PREVIEW_ID, locale: NS, inject: injectPreview
  }, EmbeddedPreview));

  ctx.slots.inject("sidebar.right.tab.document.actions", () =>
    ctx.slots.register(
      {
        name: "sidebar.right.tab.document.actions",
        id: "page-annotate",
        locale: NS,
        inject: (sessionId) => ({
          sessionId,
          openAnnotate: (owner, path, tabId) => {
            // Replace the source occurrence in its own pane, without creating
            // another visible tab or revealing an annotation in another pane.
            if (!tabId) return;
            const enter = livePreviewControllers.get(`${owner}:${tabId}`);
            if (enter) { enter(); return; }
            ctx.sidebarRight.openResourceIn(owner, annotateAddress(owner, path), {
              replaceTab: tabId,
              revealIfOpened: false
            });
          }
        })
      },
      AnnotateAction
    )
  );
}
