/**
 * Unit tests for the pure annotation core.
 *
 * These run under plain `node --test` against `src/core.mjs` — the same text the
 * build concatenates into the client bundle and embeds in the overlay. That is
 * the point of keeping the core DOM-free: the logic that decides what a prompt
 * says is testable without a browser.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ANNOTATION_KINDS,
  KIND_LABELS,
  MAX_ANNOTATIONS,
  collapseWhitespace,
  compileMessage,
  countByKind,
  elementLocator,
  isAnnotationKind,
  normalizeAnnotation,
  normalizeAnnotations,
  truncate
} from "../src/core.mjs";

test("collapseWhitespace folds runs to one space and trims", () => {
  assert.equal(collapseWhitespace("  a \n\t b\u00a0c  "), "a b c");
  assert.equal(collapseWhitespace(undefined), "");
  assert.equal(collapseWhitespace(null), "");
});

test("truncate keeps short text and appends an ellipsis past the limit", () => {
  assert.equal(truncate("abcd", 4), "abcd");
  assert.equal(truncate("abcde", 4), "abcd…");
});

test("truncate never splits a surrogate pair", () => {
  // "😀" is one astral character (two UTF-16 units); limit 1 falls on the high
  // surrogate, so the cut must back off rather than emit a lone half.
  assert.equal(truncate("😀x", 1), "…");
  assert.equal(truncate("😀x", 2), "😀…");
});

test("elementLocator names the element and its identifying ancestry", () => {
  const locator = elementLocator({
    tag: "BUTTON",
    id: "submit",
    classes: ["btn", "btn-primary"],
    ancestry: [
      { tag: "DIV", id: "", classes: [] },
      { tag: "FORM", id: "order-form", classes: ["form"] }
    ]
  });
  // Bare containers are dropped; only landmarks and the element itself remain.
  assert.equal(locator, "form#order-form.form > button#submit.btn.btn-primary");
});

test("elementLocator degrades to a tag when nothing identifies the element", () => {
  assert.equal(elementLocator({ tag: "SPAN" }), "span");
  assert.equal(elementLocator(undefined), "element");
});

test("elementLocator caps classes at three per node", () => {
  const locator = elementLocator({ tag: "DIV", classes: ["a", "b", "c", "d"] });
  assert.equal(locator, "div.a.b.c");
});

test("isAnnotationKind accepts only the declared kinds", () => {
  for (const kind of ANNOTATION_KINDS) assert.equal(isAnnotationKind(kind), true);
  assert.equal(isAnnotationKind("nope"), false);
  assert.equal(isAnnotationKind(undefined), false);
});

test("normalizeAnnotation rejects a missing or blank comment", () => {
  assert.equal(normalizeAnnotation({ comment: "   " }), undefined);
  assert.equal(normalizeAnnotation({}), undefined);
  assert.equal(normalizeAnnotation(null), undefined);
  assert.equal(normalizeAnnotation("text"), undefined);
});

test("normalizeAnnotation defaults an unknown kind to change", () => {
  const annotation = normalizeAnnotation({ comment: "改一下", kind: "bogus" });
  assert.equal(annotation.kind, "change");
});

test("normalizeAnnotation keeps an optional label and quoted text", () => {
  const annotation = normalizeAnnotation({
    comment: "调整成加粗字体",
    kind: "change",
    label: " th ",
    text: "  是否二级订单  ",
    element: { tag: "TH", classes: ["cell"] }
  });
  assert.deepEqual(annotation, {
    kind: "change",
    comment: "调整成加粗字体",
    label: "th",
    text: "是否二级订单",
    locator: "th.cell"
  });
});

test("a locator computed by the overlay is kept, not recomputed into a placeholder", () => {
  // The channel carries the finished locator string and no element facts, so
  // normalizeAnnotation must not fall back to elementLocator({}) — that yields
  // the literal "element" and ships the model a target it cannot find.
  const annotation = normalizeAnnotation({
    kind: "change",
    comment: "标题层级调小一号",
    label: "h1",
    text: "乐味小程序开票流程总览",
    locator: "section#flow-screen > main > header > h1"
  });
  assert.equal(annotation.locator, "section#flow-screen > main > header > h1");

  const compiled = compileMessage({ path: "x/page.html", annotations: [annotation] });
  assert.ok(compiled.includes("`section#flow-screen > main > header > h1`"), "the prompt carries the real locator");
  assert.ok(!compiled.includes("`element`"), "no placeholder locator reaches the prompt");
});

test("normalization preserves bounded annotation identity for badges and reload", () => {
  const note = normalizeAnnotation({ id: "a12", selector: "#orders th", comment: "调整" });
  assert.equal(note.id, "a12");
  assert.equal(note.selector, "#orders th");
  assert.equal(normalizeAnnotation({ id: "bad", selector: "x".repeat(2001), comment: "调整" }).id, undefined);
  assert.equal(normalizeAnnotation({ selector: "x".repeat(2001), comment: "调整" }).selector, undefined);
});

test("normalizeAnnotations drops unusable entries and preserves order", () => {
  const kept = normalizeAnnotations([
    { comment: "first" },
    { comment: "" },
    null,
    { comment: "second" }
  ]);
  assert.deepEqual(kept.map((entry) => entry.comment), ["first", "second"]);
});

test("normalizeAnnotations caps the list", () => {
  const many = Array.from({ length: MAX_ANNOTATIONS + 25 }, (_, index) => ({ comment: `c${index}` }));
  assert.equal(normalizeAnnotations(many).length, MAX_ANNOTATIONS);
});

test("normalizeAnnotations answers an empty list for a non-array", () => {
  assert.deepEqual(normalizeAnnotations(undefined), []);
  assert.deepEqual(normalizeAnnotations("nope"), []);
});

test("compileMessage says nothing when there is nothing to say", () => {
  assert.equal(compileMessage({ annotations: [] }), "");
  assert.equal(compileMessage({ annotations: [{ comment: "  " }] }), "");
  assert.equal(compileMessage(undefined), "");
});

test("compileMessage leads with the page, then one block per annotation", () => {
  const text = compileMessage({
    path: "业务需求/20260923-提交工单AI预处理改造设计.html",
    title: "提交工单AI预处理改造设计",
    annotations: [
      {
        kind: "change",
        comment: "这里调整成加粗字体",
        text: "是否二级订单",
        element: { tag: "TH", classes: ["cell"] }
      },
      { kind: "remove", comment: "这一列不需要", element: { tag: "TD" } }
    ]
  });
  const lines = text.split("\n");
  assert.equal(lines[0], "请按下面的批注调整「提交工单AI预处理改造设计」。");
  assert.equal(lines[2], "文件：`业务需求/20260923-提交工单AI预处理改造设计.html`");
  assert.ok(text.includes("1. [调整] `th.cell`"));
  assert.ok(text.includes("   > 是否二级订单"));
  assert.ok(text.includes("   这里调整成加粗字体"));
  assert.ok(text.includes("2. [删除] `td`"));
  assert.ok(text.includes("批注里没有提到的部分保持原样，只改这里列出的内容。"));
});

test("compileMessage falls back to the path, then to a generic subject", () => {
  const withoutTitle = compileMessage({ path: "a/b.html", annotations: [{ comment: "x" }] });
  assert.ok(withoutTitle.startsWith("请按下面的批注调整「a/b.html」。"));
  // The path is already the subject, so it is not repeated on a `文件：` line.
  assert.equal(withoutTitle.includes("文件："), false);

  const withTitle = compileMessage({ path: "a/b.html", title: "工单页", annotations: [{ comment: "x" }] });
  assert.ok(withTitle.startsWith("请按下面的批注调整「工单页」。"));
  assert.ok(withTitle.includes("文件：`a/b.html`"));

  assert.ok(compileMessage({ annotations: [{ comment: "x" }] }).startsWith("请按下面的批注调整「页面」。"));
});

test("compileMessage re-validates and drops malformed annotations", () => {
  const text = compileMessage({ path: "a.html", annotations: [{ comment: "" }, { comment: "ok" }] });
  assert.ok(text.includes("1. [调整]"));
  assert.equal(text.includes("2. [调整]"), false);
});

test("compileMessage keeps a multi-line comment as indented lines", () => {
  const text = compileMessage({ path: "a.html", annotations: [{ comment: "第一行\n第二行" }] });
  assert.ok(text.includes("   第一行\n   第二行"));
});

test("compiled notes keep unique selector and modal evidence across normalization", () => {
  const note = {
    id: "a1", comment: "增加图片预览", locator: "div.modal > div.file-strip",
    selector: "#myTicketModal > div:nth-of-type(1) > div.file-strip",
    targetContext: { scopeSelector: "#myTicketModal", scopeTitle: "本人工单", selectorMatches: 1,
      tag: "div", html: '<div class="file-strip">付款流水截图.png</div>' }
  };
  const normalized = normalizeAnnotations(normalizeAnnotations([note]));
  assert.equal(normalized[0].targetContext.scopeSelector, "#myTicketModal");
  const text = compileMessage({ annotations: normalized });
  for (const evidence of [note.selector, "#myTicketModal", "本人工单", "选中时匹配数：1（唯一）", "付款流水截图.png", "不能仅凭相同文案", "不要猜测位置"])
    assert.ok(text.includes(evidence), evidence);
});

test("annotation markers are explicitly excluded from implementation, not business sequence columns", () => {
  const text = compileMessage({ annotations: [{ comment: "调整字号" }] });
  assert.ok(text.includes("只用于定位；不得把它们新增、复制或固化到源 HTML"));
  assert.ok(text.includes("不要删除页面原有的业务序号列"));
});

test("target evidence is bounded and ambiguous matches are flagged", () => {
  const note = normalizeAnnotation({ comment: "x", targetContext: { html: "x".repeat(5000), scopeTitle: "y".repeat(500), selectorMatches: 2 } });
  assert.ok(note.targetContext.html.length <= 1601);
  assert.ok(note.targetContext.scopeTitle.length <= 161);
  assert.match(compileMessage({ annotations: [note] }), /非唯一或已失效/);
  assert.equal(normalizeAnnotation({ comment: "x", targetContext: { selectorMatches: -1 } }).targetContext.selectorMatches, undefined);
});

test("countByKind tallies normalized annotations", () => {
  assert.deepEqual(countByKind([{ comment: "a" }, { comment: "b", kind: "remove" }, { comment: " " }]), {
    change: 1,
    remove: 1
  });
});

test("every declared kind has a label", () => {
  for (const kind of ANNOTATION_KINDS) assert.equal(typeof KIND_LABELS[kind], "string");
});
