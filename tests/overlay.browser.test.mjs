/**
 * End-to-end overlay test in a real browser.
 *
 * The unit tests cover the compiler; this covers the channel. It loads the
 * *built* overlay program into a sandboxed frame the way the plugin does,
 * picks a real element with real pointer events, types a comment, and then
 * asserts on what the shell would receive — so a regression in the CSS
 * selector path, the capture-phase handlers, or the postMessage protocol fails
 * here rather than in the app.
 *
 * Skipped when Playwright or its browser is unavailable.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

import { compileMessage } from "../src/core.mjs";

const PLAYWRIGHT = "/Users/baigo/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs";
const DESIGN_PAGE =
  "/Users/baigo/Documents/workspace/baigo_vault/10_Workbench/LEHE/业务需求/2026/20260923-提交工单AI预处理改造设计.html";

/** @type {{ chromium: any } | undefined} */
let playwright;
try {
  playwright = await import(PLAYWRIGHT);
} catch {
  playwright = undefined;
}

const enabled = playwright !== undefined;

const FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
body{font:14px -apple-system,sans-serif;margin:24px}
table{border-collapse:collapse}th,td{border:1px solid #ddd;padding:6px 10px}
</style></head>
<body>
<h1 id="page-title">提交工单</h1>
<table id="orders"><thead><tr>
<th class="cell">序号</th><th class="cell">是否二级订单</th>
</tr></thead><tbody><tr><td>1</td><td>是</td></tr></tbody></table>
<script>window.__pageScriptRan = true;</script>
</body></html>`;

/** Identical modal interiors, with the distinguishing mask ID >6 levels away. */
const MODAL_FIXTURE = `<!doctype html><html><body>
${["first", "second"].map((name) => `<div id="${name}Modal" class="modal-mask">
  <div class="modal wide"><h2 class="modal-title">${name === "first" ? "第一个" : "第二个"}工单弹窗</h2>
  <p>${"弹窗的长正文不是标题。".repeat(80)}</p>
  ${Array.from({ length: 12 }, (_, index) => `<div class="shared-ancestor-${index}-with-a-long-structural-classname">`).join("")}
  <div class="target" style="padding:24px" onclick="window.fixtureActivation=true">目标 target
    <input value="private-input-value"><textarea>private-textarea-value</textarea>
    <script>window.fixtureSecret='private-script-value';</script><style>.unused{color:red}</style>
    <span>${"较长的目标内容".repeat(300)}</span>
  </div>${"</div>".repeat(12)}</div></div>`).join("\n")}
</body></html>`;

/**
 * Splice the overlay into a document exactly as the plugin does.
 * @param {string} html - the page markup.
 * @param {string} source - the overlay program.
 * @returns the document to render.
 */
function withOverlay(html, source) {
  const tag = `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`;
  const body = /<\/body\s*>/i.exec(html);
  if (body !== null) return `${html.slice(0, body.index)}${tag}${html.slice(body.index)}`;
  return `${html}${tag}`;
}

/**
 * Read the built overlay program embedded in `lib/client.js`.
 * @returns the program text.
 */
async function overlayProgram() {
  const bundle = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  const match = /const OVERLAY_SOURCE = ("(?:[^"\\]|\\.)*");/.exec(bundle);
  assert.ok(match !== null, "lib/client.js carries an OVERLAY_SOURCE literal — run `npm run build`");
  return JSON.parse(match[1]);
}

/**
 * Wait until the shell has received at least `count` change frames.
 * @param {any} page - the harness page.
 * @param {number} count - how many change frames to wait for.
 * @returns the latest change frame.
 */
async function waitChange(page, count = 1) {
  await page.waitForFunction(
    (n) => window.__frames.filter((frame) => frame.type === "change").length >= n,
    count,
    { timeout: 3000 }
  );
  return await page.evaluate(() => window.__frames.filter((frame) => frame.type === "change").at(-1) ?? null);
}

/**
 * Build the harness page: one sandboxed frame plus a frame collector.
 * @param {string} pageHtml - the document to annotate.
 * @param {string} source - the overlay program.
 * @returns the harness HTML.
 */
function harness(pageHtml, source) {
  const doc = withOverlay(pageHtml, source);
  // The document is embedded in a script literal, so a literal `</script>`
  // inside it would close the harness block early.
  const literal = JSON.stringify(doc).replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}iframe{width:900px;height:1400px;border:0}</style></head><body>
<script>
window.__frames = [];
window.__ready = false;
window.__send = (message) => {
  document.getElementById("f").contentWindow.postMessage({ channel: "dsh-page-annotate", ...message }, "*");
};
window.addEventListener("message", (event) => {
  const data = event.data;
  if (data === null || typeof data !== "object" || data.channel !== "dsh-page-annotate") return;
  window.__frames.push(data);
  if (data.type === "ready") window.__ready = true;
});
const frame = document.createElement("iframe");
frame.id = "f";
frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
frame.srcdoc = ${literal};
document.body.appendChild(frame);
</script></body></html>`;
}

/**
 * Open a harness page and wait for the overlay to announce itself.
 * @param {any} browser - the browser.
 * @param {string} pageHtml - the document to annotate.
 * @returns the page and its frame locator.
 */
async function open(browser, pageHtml) {
  const source = await overlayProgram();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.setContent(harness(pageHtml, source));
  await page.waitForFunction("window.__ready === true", undefined, { timeout: 5000 });
  return { page, frame: page.frameLocator("#f"), errors };
}

test("picking buttons suppresses prototype activation and Esc restores it", { skip: !enabled }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const fixture = `<html><body><form><button id="action" type="submit" onclick="window.hits.push('inline')"><span>提交按钮</span></button></form>
      <script>window.hits=[];
      for(const type of ['pointerdown','mousedown','pointerup','mouseup','click','dblclick','touchend']) {
        document.addEventListener(type,()=>window.hits.push('document:'+type),true);
        document.querySelector('button').addEventListener(type,()=>window.hits.push('target:'+type));
      }
      document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.hits.push('submit')});
      </script></body></html>`;
    const { page, frame } = await open(browser, fixture);
    await page.evaluate(() => window.__send({ type: 'mode', mode: 'pick' }));
    await frame.locator('body').evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    await frame.locator('#action span').click();
    assert.deepEqual(await frame.locator('body').evaluate(() => window.hits), []);
    assert.equal(await frame.locator('[data-dsh-page-annotate-input]').count(), 1);
    await frame.locator('[data-dsh-page-annotate-input]').fill('修改按钮文案');
    await frame.getByRole('button', { name: '保存批注', exact: true }).click();
    assert.equal((await waitChange(page)).annotations.length, 1, 'overlay save remains usable');
    // Events on our own controls are deliberately not blocked at window.
    await frame.locator('body').evaluate(() => { window.hits = []; });
    await frame.locator('#action span').dblclick();
    assert.deepEqual(await frame.locator('body').evaluate(() => window.hits), []);
    await frame.locator('[data-dsh-page-annotate-input]').press('Escape');
    await frame.locator('#action span').click();
    const hits = await frame.locator('body').evaluate(() => window.hits);
    assert.ok(hits.includes('inline') && hits.includes('target:click') && hits.includes('document:pointerdown'), JSON.stringify(hits));
    await page.close();
  } finally { await browser.close(); }
});

test("draft highlight locks to selected element while typing and unlocks after save or Escape", { skip: !enabled }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame } = await open(browser, `<html><body><div id="first" style="width:200px;height:40px;margin:20px">选中元素</div><div id="second" style="width:400px;height:90px;margin:100px 40px">另一区域</div></body></html>`);
    await page.evaluate(() => window.__send({ type: "mode", mode: "pick" }));
    const first = frame.locator('#first');
    const second = frame.locator('#second');
    const highlight = frame.locator('.data-dsh-page-annotate-hover');
    const rect = (locator) => locator.evaluate(node => {
      const r = node.getBoundingClientRect();
      if (node.classList.contains('data-dsh-page-annotate-hover')) return [parseFloat(node.style.left), parseFloat(node.style.top), parseFloat(node.style.width), parseFloat(node.style.height)];
      return [r.x, r.y, r.width, r.height];
    });
    await first.click();
    const input = frame.locator('[data-dsh-page-annotate-input]');
    await input.fill('改一下');
    await second.hover();
    assert.deepEqual(await rect(highlight), await rect(first), 'moving away must not retarget draft highlight');
    await frame.getByRole('button', { name: '批注配置', exact: true }).hover();
    assert.deepEqual(await rect(highlight), await rect(first));
    await first.evaluate(node => { node.style.marginLeft = '70px'; window.dispatchEvent(new Event('resize')); });
    assert.deepEqual(await rect(highlight), await rect(first), 'locked target tracks layout changes');
    await frame.getByRole('button', { name: '保存批注', exact: true }).click();
    await second.hover();
    assert.deepEqual(await rect(highlight), await rect(second), 'save resumes hover picking');
    await first.click();
    await second.hover();
    assert.deepEqual(await rect(highlight), await rect(first), 'editing saved note also locks');
    await input.press('Escape');
    assert.equal(await highlight.isVisible(), false);
    await page.evaluate(() => window.__send({ type: 'mode', mode: 'pick' }));
    await second.hover();
    assert.deepEqual(await rect(highlight), await rect(second));
    await page.close();
  } finally { await browser.close(); }
});

test("the overlay announces itself and stays inert until asked to pick", { skip: !enabled }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame, errors } = await open(browser, FIXTURE);
    assert.deepEqual(await page.evaluate(() => window.__frames.map((f) => f.type)), ["ready"]);
    // The page's own script still runs; the overlay only decorates.
    assert.equal(await frame.locator("body").evaluate(() => window.__pageScriptRan), true);

    // A click in browse mode must reach the page, not the picker.
    await frame.locator("h1").click();
    assert.equal(await frame.locator(".data-dsh-page-annotate-editor").count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    await browser.close();
  }
});

test("picking an element, commenting, and saving emits one normalized annotation", { skip: !enabled }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame, errors } = await open(browser, FIXTURE);
    await page.evaluate(() => window.__send({ type: "mode", mode: "pick" }));

    await frame.locator("th", { hasText: "是否二级订单" }).click();

    const input = frame.locator("[data-dsh-page-annotate-input]");
    await input.waitFor({ timeout: 3000 });
    assert.equal(await frame.locator('.data-dsh-page-annotate-head').count(), 0);

    await input.fill("这里调整成加粗字体");
    await frame.locator("[data-primary]").click();

    const change = await waitChange(page);
    assert.ok(change !== null, "saving posts a change frame");
    assert.equal(change.annotations.length, 1);
    const annotation = change.annotations[0];
    assert.equal(annotation.kind, "change");
    assert.equal(annotation.comment, "这里调整成加粗字体");
    assert.match(annotation.locator, /th/);
    assert.equal(annotation.text, "是否二级订单");
    // A selector comes back so a reload can re-bind the badge.
    assert.match(annotation.selector, /th/);
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    await browser.close();
  }
});

test("deep identical dialogs retain the second mask scope and bounded target evidence", { skip: !enabled }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame, errors } = await open(browser, MODAL_FIXTURE);
    await frame.locator("#secondModal .target").evaluate((node) => {
      for (const part of ["badge", "hover", "editor"]) {
        const marker = document.createElement("span");
        marker.className = "data-dsh-page-annotate-" + part;
        marker.hidden = true;
        marker.textContent = "annotation-tool-marker";
        node.prepend(marker);
      }
    });
    await page.evaluate(() => window.__send({ type: "mode", mode: "pick" }));
    await frame.locator("#secondModal .target").click({ position: { x: 5, y: 5 } });
    await frame.locator("[data-dsh-page-annotate-input]").fill("仅修改第二个弹窗的目标");
    await frame.locator("[data-primary]").click();
    const annotation = (await waitChange(page)).annotations[0];
    const context = annotation.targetContext;
    assert.equal(context.scopeSelector, "#secondModal", "preserves the unique mask ID, not shared .modal.wide");
    assert.equal(context.scopeTitle, "第二个工单弹窗", "does not collect the long dialog body as title");
    assert.equal(context.tag, "div");
    assert.equal(context.selectorMatches, 1);
    assert.match(annotation.selector, /^#secondModal > /);
    assert.equal(await frame.locator("body").evaluate((_, selector) => document.querySelectorAll(selector).length, annotation.selector), 1);
    assert.equal(await frame.locator(annotation.selector).evaluate((node) => node.closest(".modal-mask").id), "secondModal");
    assert.match(annotation.locator, /^#secondModal · div#secondModal/);
    assert.ok(annotation.locator.length > 400 && annotation.locator.length <= 1200);
    assert.match(annotation.locator, /div\.target$/);
    assert.match(context.html, /class="target"/);
    assert.match(context.html, /目标 target/);
    assert.ok(context.html.length <= 1600);
    assert.doesNotMatch(context.html, /<script|<style|onclick=|value=|private-|data-dsh-page-annotate|annotation-tool-marker/i);
    assert.equal(await frame.locator("#secondModal .target input").inputValue(), "private-input-value", "sanitization never mutates the live page");
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    await browser.close();
  }
});

test("a multi-line comment survives the channel into a compiled prompt", { skip: !enabled }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame } = await open(browser, FIXTURE);
    await page.evaluate(() => window.__send({ type: "mode", mode: "pick" }));
    await frame.locator("#page-title").click();
    await frame.locator("[data-dsh-page-annotate-input]").fill("第一行\n第二行");
    await frame.locator("[data-primary]").click();

    const change = await waitChange(page);
    assert.equal(change.annotations[0].comment, "第一行\n第二行");

    const text = compileMessage({ path: "x/page.html", annotations: change.annotations });
    assert.ok(text.includes("   第一行\n   第二行"), "both lines reach the prompt as indented rows");
    await page.close();
  } finally {
    await browser.close();
  }
});

test("several annotations accumulate and compile into one message", { skip: !enabled }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame, errors } = await open(browser, FIXTURE);
    await page.evaluate(() => window.__send({ type: "mode", mode: "pick" }));

    // Three picks in one session of pick mode: saving must not eject the
    // annotator, or collecting several notes would need a toggle per note.
    const targets = [
      ["#page-title", "change", "标题改小一号"],
      ["th:has-text('是否二级订单')", "remove", "这一列不需要"],
      ["td:has-text('是')", "question", "这里的取值规则是什么"]
    ];
    for (const [selector, kind, comment] of targets) {
      await frame.locator(selector).first().click();
      await frame.getByRole("button", { name: "批注配置" }).click();
      assert.equal(await frame.locator(".data-dsh-page-annotate-kind").count(), 0);
      await frame.locator("[data-dsh-page-annotate-input]").fill(comment);
      await frame.locator("[data-primary]").click();
    }

    const change = await waitChange(page, 3);
    assert.equal(change.annotations.length, 3, "all three notes arrive in one list");
    assert.deepEqual(
      change.annotations.map((a) => a.kind),
      ["change", "change", "change"]
    );
    assert.equal(new Set(change.annotations.map((a) => a.id)).size, 3, "each note has its own id");

    // The shell sends this list as a single prompt.
    const text = compileMessage({ path: "x/page.html", annotations: change.annotations });
    assert.match(text, /^1\. \[调整\]/m);
    assert.match(text, /^2\. \[调整\]/m);
    assert.match(text, /^3\. \[调整\]/m);
    assert.ok(text.includes("标题改小一号"));
    assert.ok(text.includes("这一列不需要"));
    assert.ok(text.includes("这里的取值规则是什么"));
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    await browser.close();
  }
});

test("restored legacy kinds stay intact without a kind UI and Esc leaves pick mode", { skip: !enabled }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame } = await open(browser, FIXTURE);
    await page.evaluate(() => window.__send({ type: "mode", mode: "pick" }));
    await frame.locator("h1").click();
    await frame.locator("[data-dsh-page-annotate-input]").fill("这一列不需要");
    await frame.getByRole("button", { name: "批注配置" }).click();
    assert.equal(await frame.locator('[class$="-kind"]').count(), 0);
    await frame.locator("[data-primary]").click();

    let change = await waitChange(page);
    assert.equal(change.annotations[0].kind, "change");
    const legacy = { ...change.annotations[0], kind: "remove" };
    await page.evaluate(annotation => window.__send({ type: "restore", annotations: [annotation] }), legacy);
    await frame.locator('.data-dsh-page-annotate-badge[data-kind="remove"]').waitFor();

    // Re-picking the same element edits the existing note rather than adding one.
    await frame.locator("h1").click();
    await frame.locator("[data-dsh-page-annotate-input]").waitFor();
    assert.equal(await frame.locator("[data-dsh-page-annotate-input]").inputValue(), "这一列不需要");
    await frame.getByRole("button", { name: "批注配置" }).click();
    assert.equal(await frame.locator(".data-dsh-page-annotate-kind").count(), 0);
    await frame.locator("[data-primary]").click();
    change = await waitChange(page, 2);
    assert.equal(change.annotations[0].kind, "remove");

    // Focus still sits on the cancelled editor's button inside the frame, so
    // this Escape reaches the overlay's document-level handler.
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => window.__frames.some((frame) => frame.type === "exit-pick"),
      undefined,
      { timeout: 3000 }
    );
    await page.close();
  } finally {
    await browser.close();
  }
});

for (const focus of ["textarea", "settings button"]) {
  test(`Esc from the ${focus} cancels a new draft and immediately leaves pick mode`, { skip: !enabled }, async () => {
    const browser = await playwright.chromium.launch();
    try {
      const { page, frame, errors } = await open(browser, FIXTURE);
      const body = frame.locator("body");
      assert.equal(await body.getAttribute("data-dsh-page-annotate-picking"), null);
      await page.evaluate(() => window.__send({ type: "mode", mode: "pick" }));
      await frame.locator("h1").hover();
      await frame.locator("h1").click();
      const input = frame.locator("[data-dsh-page-annotate-input]");
      await input.fill("尚未保存的批注");
      if (focus === "settings button") {
        await frame.getByRole("button", { name: "批注配置" }).click();
        await frame.getByRole("button", { name: "批注配置" }).focus();
      }
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => window.__frames.some((frame) => frame.type === "exit-pick"));

      // The harness deliberately never echoes browse mode: the overlay must
      // clear its own editor, hover box, and crosshair on the first Escape.
      assert.equal(await frame.locator(".data-dsh-page-annotate-editor").count(), 0);
      assert.equal(await frame.locator("[data-dsh-page-annotate-layer]").getAttribute("data-mode"), "browse");
      assert.equal(await body.getAttribute("data-dsh-page-annotate-picking"), null);
      assert.equal(await frame.locator(".data-dsh-page-annotate-hover").evaluate((node) => node.style.display), "none");
      assert.equal(await frame.locator(".data-dsh-page-annotate-badge").count(), 0);
      assert.deepEqual(await page.evaluate(() => window.__frames.map((frame) => frame.type)), ["ready", "exit-pick"]);
      await frame.locator("h1").evaluate((node) => {
        node.addEventListener("mousedown", () => { window.__pagePicked = true; });
      });
      await frame.locator("h1").click();
      assert.equal(await body.evaluate(() => window.__pagePicked), true, "normal page interaction resumes");
      assert.equal(await input.count(), 0);
      await page.keyboard.press("Escape");
      // A round trip also flushes messages from the preceding key event.
      await body.evaluate(() => undefined);
      assert.equal(await page.evaluate(() => window.__frames.filter((frame) => frame.type === "exit-pick").length), 1);
      assert.deepEqual(errors, []);
      await page.close();
    } finally {
      await browser.close();
    }
  });
}

test("Esc discards edits without mutating or losing saved annotations", { skip: !enabled }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame, errors } = await open(browser, FIXTURE);
    await page.evaluate(() => window.__send({ type: "mode", mode: "pick" }));
    await frame.locator("h1").click();
    const input = frame.locator("[data-dsh-page-annotate-input]");
    await input.fill("已保存的标题批注");
    await frame.locator("[data-primary]").click();
    const saved = (await waitChange(page)).annotations[0];

    await frame.locator("h1").click();
    await input.fill("不应保存的改动");
    await frame.getByRole("button", { name: "批注配置" }).click();
    await frame.getByRole("textbox", { name: "文字颜色", exact: true }).fill("#ff0000");
    await input.focus();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => window.__frames.some((frame) => frame.type === "exit-pick"));
    assert.equal(await input.count(), 0);
    const badge = frame.locator(".data-dsh-page-annotate-badge");
    assert.equal(await badge.count(), 1);
    assert.equal(await badge.getAttribute("title"), saved.comment);
    assert.equal(await badge.getAttribute("data-kind"), saved.kind);
    assert.equal(await page.evaluate(() => window.__frames.filter((frame) => frame.type === "change").length), 1);

    // Reopen in browse mode too: the saved draft must still have both its
    // original comment and kind, and Escape must not emit another exit-pick.
    await badge.click();
    assert.equal(await input.inputValue(), saved.comment);
    assert.equal(await frame.locator(".data-dsh-page-annotate-kind").count(), 0);
    await input.press("Escape");
    assert.equal(await input.count(), 0);

    // A subsequent save publishes the live list, detecting silent mutations
    // that would not have appeared in an earlier postMessage snapshot.
    await page.evaluate(() => window.__send({ type: "mode", mode: "pick" }));
    await frame.locator("th").last().click();
    await input.fill("另一条批注");
    await frame.locator("[data-primary]").click();
    const change = await waitChange(page, 2);
    assert.equal(change.annotations.length, 2);
    assert.deepEqual(change.annotations[0], saved);
    assert.equal(await page.evaluate(() => window.__frames.filter((frame) => frame.type === "exit-pick").length), 1);
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    await browser.close();
  }
});

test("restore re-binds badges to the elements the shell already knows", { skip: !enabled }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame } = await open(browser, FIXTURE);
    await page.evaluate(() =>
      window.__send({
        type: "restore",
        annotations: [
          {
            id: "a1",
            kind: "change",
            comment: "加粗",
            locator: "th.cell",
            selector: "#orders th:nth-of-type(2)",
            label: "th",
            text: "是否二级订单"
          }
        ]
      })
    );
    const badges = frame.locator(".data-dsh-page-annotate-badge");
    await badges.first().waitFor({ timeout: 3000 });
    assert.equal(await badges.count(), 1);
    assert.equal(await badges.first().textContent(), "1");
    assert.equal(await badges.first().getAttribute("data-kind"), "change");
    await page.close();
  } finally {
    await browser.close();
  }
});

test("the real design page loads, picks, and reports a usable locator", { skip: !enabled }, async (t) => {
  try {
    await access(DESIGN_PAGE);
  } catch {
    t.skip("design page not present");
    return;
  }
  const browser = await playwright.chromium.launch();
  try {
    const pageHtml = await readFile(DESIGN_PAGE, "utf8");
    const { page, frame, errors } = await open(browser, pageHtml);
    await page.evaluate(() => window.__send({ type: "mode", mode: "pick" }));

    // Pick any table header cell: the point is that a real 88 KB page with its
    // own inline script still takes the overlay and yields a locator.
    const cell = frame.locator("th").first();
    await cell.click();
    await frame.locator("[data-dsh-page-annotate-input]").fill("这里调整成加粗字体");
    await frame.locator("[data-primary]").click();

    const change = await waitChange(page);
    assert.ok(change !== null);
    assert.equal(change.annotations.length, 1);
    assert.ok(change.annotations[0].locator.length > 0);
    const text = compileMessage({
      path: "业务需求/20260923-提交工单AI预处理改造设计.html",
      title: "提交工单AI预处理改造设计",
      annotations: change.annotations
    });
    assert.match(text, /^请按下面的批注调整「提交工单AI预处理改造设计」。/);
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    await browser.close();
  }
});


test("compact composer hides advanced controls, toggles them, and fits a narrow viewport", { skip: !enabled }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame, errors } = await open(browser, FIXTURE);
    await page.locator("#f").evaluate((node) => { node.style.width = "280px"; });
    await page.evaluate(() => window.__send({ type: "mode", mode: "pick" }));
    await frame.locator("h1").click();
    const editor = frame.locator(".data-dsh-page-annotate-editor");
    const input = frame.locator("[data-dsh-page-annotate-input]");
    const settings = frame.getByRole("button", { name: "批注配置" });
    const save = frame.getByRole("button", { name: "保存批注", exact: true });
    const details = frame.locator(".data-dsh-page-annotate-details");
    assert.equal(await settings.getAttribute("aria-expanded"), "false");
    assert.equal(await details.isVisible(), false);
    assert.equal(await frame.locator(".data-dsh-page-annotate-head").count(), 0);
    assert.equal(await frame.locator(".data-dsh-page-annotate-kind").count(), 0);
    assert.equal(await frame.getByRole("button", { name: "取消" }).isVisible(), false);
    assert.equal(await save.isDisabled(), true);
    assert.equal(await frame.locator(".data-dsh-page-annotate-number").textContent(), "1");
    assert.equal(await input.getAttribute("rows"), "1");
    assert.equal(await input.evaluate((node) => getComputedStyle(node).cursor), "text");
    assert.equal(await settings.evaluate((node) => getComputedStyle(node).cursor), "pointer");
    assert.equal(await input.evaluate((node) => node.offsetHeight), 30);
    const bounds = await editor.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const anchor = document.querySelector("h1").getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width, viewport: innerWidth,
        expected: Math.max(8, Math.min(anchor.left + anchor.width / 2 - rect.width / 2, innerWidth - rect.width - 8)) };
    });
    assert.ok(bounds.left >= 8 && bounds.right <= bounds.viewport - 8);
    assert.equal(bounds.left, bounds.expected, "placement uses the actual border-box width");
    await settings.click();
    assert.equal(await settings.getAttribute("aria-expanded"), "true");
    assert.equal(await details.isVisible(), true);
    assert.equal(await frame.locator(".data-dsh-page-annotate-kind").count(), 0);
    assert.equal(await frame.getByRole("button", { name: "取消" }).isVisible(), true);

    await input.fill("新增说明");
    await settings.click();
    assert.equal(await settings.getAttribute("aria-expanded"), "false");
    assert.equal(await details.isVisible(), false);
    await save.click();
    assert.equal((await waitChange(page)).annotations[0].kind, "change");
    await frame.locator("h1").click();
    assert.equal(await details.isVisible(), false, "reopening starts compact");
    await settings.click();
    const remove = frame.getByRole("button", { name: "删除", exact: true }).last();
    assert.equal(await remove.isVisible(), true);
    await settings.click();
    assert.equal(await remove.isVisible(), false);
    await settings.click();
    await remove.click();
    assert.deepEqual((await waitChange(page, 2)).annotations, []);
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    await browser.close();
  }
});

test("Shift+Enter grows the textarea and Enter saves its multiple lines", { skip: !enabled }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame } = await open(browser, FIXTURE);
    await page.evaluate(() => window.__send({ type: "mode", mode: "pick" }));
    await frame.locator("h1").click();
    const input = frame.locator("[data-dsh-page-annotate-input]");
    await input.fill("第一行");
    const oneLine = await input.evaluate((node) => node.offsetHeight);
    await input.press("End");
    await input.press("Shift+Enter");
    await input.pressSequentially("第二行");
    assert.equal(await input.inputValue(), "第一行\n第二行");
    assert.ok(await input.evaluate((node) => node.offsetHeight) > oneLine);
    assert.equal(await page.evaluate(() => window.__frames.filter((f) => f.type === "change").length), 0);
    await input.press("Enter");
    assert.equal((await waitChange(page)).annotations[0].comment, "第一行\n第二行");
    assert.equal(await input.count(), 0);
    await frame.locator("h1").click();
    await input.fill("短");
    assert.equal(await input.evaluate((node) => node.offsetHeight), oneLine, "textarea shrinks as text is removed");
    await page.close();
  } finally {
    await browser.close();
  }
});

test("IME Enter never saves, while Ctrl/Meta+Enter remain supported", { skip: !enabled }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame } = await open(browser, FIXTURE);
    await page.evaluate(() => window.__send({ type: "mode", mode: "pick" }));
    await frame.locator("h1").click();
    const input = frame.locator("[data-dsh-page-annotate-input]");
    await input.fill("输入法组词");
    await input.dispatchEvent("compositionstart");
    await input.press("Enter");
    await input.press("Control+Enter");
    await input.dispatchEvent("compositionend");
    await input.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
    await input.dispatchEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true });
    assert.equal(await input.count(), 1);
    assert.equal(await page.evaluate(() => window.__frames.filter((f) => f.type === "change").length), 0);
    await input.fill("输入完成");
    await input.press("Control+Enter");
    assert.equal((await waitChange(page)).annotations[0].comment, "输入完成");
    await frame.locator("h1").click();
    await input.fill("兼容 Mac 快捷键");
    await input.press("Meta+Enter");
    assert.equal((await waitChange(page, 2)).annotations[0].comment, "兼容 Mac 快捷键");
    await page.close();
  } finally {
    await browser.close();
  }
});

test("blank comments disable save and Enter keeps the draft open without changing saved notes", { skip: !enabled }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame } = await open(browser, FIXTURE);
    await page.evaluate(() => window.__send({ type: "mode", mode: "pick" }));
    await frame.locator("h1").click();
    const input = frame.locator("[data-dsh-page-annotate-input]");
    const save = frame.getByRole("button", { name: "保存批注", exact: true });
    for (const value of ["", " \n\t　"]) {
      await input.fill(value);
      assert.equal(await save.isDisabled(), true);
      await input.press("Enter");
      await input.press("Control+Enter");
      await save.evaluate((node) => node.click());
      assert.equal(await input.count(), 1);
    }
    assert.equal(await page.evaluate(() => window.__frames.filter((f) => f.type === "change").length), 0);
    await input.fill("保留的批注");
    assert.equal(await save.isEnabled(), true);
    await save.click();
    const saved = (await waitChange(page)).annotations[0];
    await frame.locator("h1").click();
    await input.fill("   ");
    assert.equal(await save.isDisabled(), true);
    await input.press("Enter");
    assert.equal(await input.count(), 1);
    await input.press("Escape");
    assert.equal(await frame.locator(".data-dsh-page-annotate-badge").getAttribute("title"), saved.comment);
    assert.equal(await page.evaluate(() => window.__frames.filter((f) => f.type === "change").length), 1);
    await page.close();
  } finally {
    await browser.close();
  }
});


test("style targets read computed values, record changes without mutation, and compile without extra fields", { skip: !enabled }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame } = await open(browser, FIXTURE);
    await page.evaluate(() => window.__send({ type: "mode", mode: "pick" }));
    const title = frame.locator("h1");
    const original = await title.evaluate((node) => {
      const css = getComputedStyle(node);
      return { color: css.color, backgroundColor: css.backgroundColor, fontSize: css.fontSize,
        fontWeight: css.fontWeight, opacity: css.opacity, inline: node.getAttribute("style") };
    });
    await title.click();
    await frame.getByRole("button", { name: "批注配置" }).click();
    const fields = frame.locator("[data-style-key]");
    assert.equal(await fields.count(), 5);
    for (const key of ["color", "backgroundColor", "fontSize", "fontWeight", "opacity"]) {
      assert.equal(await frame.locator(`[data-style-key="${key}"]`).inputValue(), key === "fontSize" ? String(parseFloat(original[key])) : key === "color" ? "#000000" : original[key]);
    }
    const save = frame.getByRole("button", { name: "保存批注", exact: true });
    const color = frame.getByRole("textbox", { name: "文字颜色" });
    await color.fill("not-a-color");
    assert.equal(await color.getAttribute("aria-invalid"), "true");
    assert.equal(await save.isDisabled(), true);
    await color.fill("#ff0000");
    assert.equal(await save.isEnabled(), true, "style-only changes can be saved");
    await color.fill(original.color);
    assert.equal(await save.isDisabled(), true, "reverting removes a style delta");
    await color.fill("#ff0000");
    await frame.getByRole("textbox", { name: "背景颜色" }).fill("#eeeeee");
    await frame.getByRole("spinbutton", { name: "字号（px）" }).fill("24");
    await frame.getByRole("spinbutton", { name: "字重" }).fill("500");
    await frame.getByRole("spinbutton", { name: "不透明度" }).fill("0.5");
    assert.equal(await title.getAttribute("style"), original.inline);
    assert.equal(await title.evaluate((node) => getComputedStyle(node).color), original.color);
    await save.click();
    const annotation = (await waitChange(page)).annotations[0];
    assert.deepEqual(annotation.styleChanges, { color: "#ff0000", backgroundColor: "#eeeeee", fontSize: "24px", fontWeight: "500", opacity: "0.5" });
    assert.match(annotation.comment, /样式调整：文字颜色设为 #ff0000；背景颜色设为 #eeeeee；字号设为 24px；字重设为 500；不透明度设为 0.5/);
    assert.ok(compileMessage({ path: "page.html", annotations: [annotation] }).includes("字号设为 24px"));
    await title.click();
    await frame.locator("[data-dsh-page-annotate-input]").fill("保留手写说明");
    await frame.getByRole("button", { name: "批注配置" }).click();
    await frame.getByRole("spinbutton", { name: "不透明度" }).fill("2");
    assert.equal(await frame.getByRole("spinbutton", { name: "不透明度" }).getAttribute("aria-invalid"), "true");
    await frame.getByRole("spinbutton", { name: "字号（px）" }).fill("18");
    await save.click();
    assert.equal((await waitChange(page, 2)).annotations[0].comment, "保留手写说明\n样式调整：字号设为 18px。");
    await title.click();
    await frame.getByRole("button", { name: "批注配置" }).click();
    await color.fill("blue");
    await frame.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(await title.getAttribute("style"), original.inline);
    assert.equal(await page.evaluate(() => window.__frames.filter((f) => f.type === "change").length), 2);
    await page.close();
  } finally {
    await browser.close();
  }
});


async function setRange(locator, value) {
  await locator.evaluate((node, next) => { node.value = String(next); node.dispatchEvent(new Event("input", { bubbles: true })); }, value);
}

test("visual picker synchronizes SV, hue, hex and alpha without touching the original DOM", { skip: !enabled }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame, errors } = await open(browser, `<html><body><div id="target" style="color:rgb(12,34,56);background-color:rgba(20,40,60,.25);padding:30px">颜色目标</div>
      <script>window.activations=0;document.addEventListener('click',()=>window.activations++);</script></body></html>`);
    const target = frame.locator("#target");
    const before = await target.evaluate(node => node.outerHTML);
    await page.evaluate(() => window.__send({ type: "mode", mode: "pick" }));
    await target.click();
    await frame.getByRole("button", { name: "批注配置" }).click();
    const value = frame.getByRole("textbox", { name: "背景颜色", exact: true });
    assert.equal(await value.inputValue(), "rgba(20, 40, 60, 0.25)");
    await frame.getByRole("button", { name: "背景颜色取色器", exact: true }).click();
    assert.equal(await frame.getByRole("dialog", { name: "背景颜色取色面板" }).isVisible(), true);
    const alpha = frame.getByRole("slider", { name: "背景颜色透明度" });
    const hex = frame.getByRole("textbox", { name: "背景颜色 Hex", exact: true });
    assert.equal(await hex.inputValue(), "#14283c");
    assert.equal(await alpha.inputValue(), "25");
    await hex.fill("#ff0000");
    assert.equal(await value.inputValue(), "rgba(255, 0, 0, 0.25)");
    await setRange(alpha, 50);
    assert.equal(await value.inputValue(), "rgba(255, 0, 0, 0.5)");
    await setRange(frame.getByRole("slider", { name: "背景颜色色相" }), 120);
    assert.equal(await hex.inputValue(), "#00ff00");
    const sv = frame.getByRole("slider", { name: "背景颜色饱和度与明度" });
    await sv.click({ position: { x: 2, y: 2 } });
    const sampled = await hex.inputValue();
    assert.match(sampled, /^#[a-f\d]{6}$/);
    assert.notEqual(sampled, "#00ff00");
    await sv.press("ArrowRight");
    assert.notEqual(await hex.inputValue(), sampled, "SV supports keyboard adjustment");
    const rect = await sv.boundingBox();
    await page.mouse.move(rect.x + 3, rect.y + 3);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2, { steps: 4 });
    await page.mouse.up();
    assert.notEqual(await hex.inputValue(), sampled, "SV supports captured pointer dragging");
    await hex.fill("#12345680");
    assert.equal(await value.inputValue(), "rgba(18, 52, 86, 0.502)");
    assert.equal(Math.round(Number(await alpha.inputValue())), 50);
    await hex.fill("#wrong");
    assert.equal(await hex.getAttribute("aria-invalid"), "true");
    assert.equal(await value.inputValue(), "rgba(18, 52, 86, 0.502)");
    await value.fill("rgba(100, 150, 200, 0.4)");
    assert.equal(await hex.inputValue(), "#6496c8");
    assert.equal(await alpha.inputValue(), "40");
    const paint = frame.locator('.data-dsh-page-annotate-swatch[aria-label="背景颜色取色器"] span');
    assert.equal(await paint.evaluate(node => node.style.backgroundColor), "rgba(100, 150, 200, 0.4)");
    assert.equal(await target.evaluate(node => node.outerHTML), before);
    assert.equal(await frame.locator("body").evaluate(() => window.activations), 0, "picker events do not bubble into the page");
    await frame.getByRole("button", { name: "保存批注", exact: true }).click();
    const saved = (await waitChange(page)).annotations[0];
    assert.equal(saved.styleChanges.backgroundColor, "rgba(100, 150, 200, 0.4)");
    assert.equal(await target.evaluate(node => node.outerHTML), before);
    assert.deepEqual(errors, []);
    await page.close();
  } finally { await browser.close(); }
});

test("transparent backgrounds retain zero alpha, equivalent colors remove deltas, and cancel preserves saved notes", { skip: !enabled }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame } = await open(browser, FIXTURE);
    await page.evaluate(() => window.__send({ type: "mode", mode: "pick" }));
    await frame.locator("h1").click();
    await frame.locator("[data-dsh-page-annotate-input]").fill("保留原批注");
    await frame.locator("[data-primary]").click();
    const saved = (await waitChange(page)).annotations[0];
    await frame.locator("h1").click();
    await frame.getByRole("button", { name: "批注配置" }).click();
    await frame.getByRole("button", { name: "背景颜色取色器" }).click();
    const alpha = frame.getByRole("slider", { name: "背景颜色透明度" });
    assert.equal(await alpha.inputValue(), "0");
    await frame.getByRole("textbox", { name: "背景颜色 Hex", exact: true }).fill("#ffffff");
    assert.equal(await alpha.inputValue(), "0", "hex RGB edits preserve alpha even at zero");
    await setRange(alpha, 70);
    await frame.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(await frame.getByRole("dialog").count(), 0);
    assert.equal(await frame.locator(".data-dsh-page-annotate-badge").getAttribute("title"), saved.comment);
    assert.equal(await page.evaluate(() => window.__frames.filter(f => f.type === "change").length), 1);
    await frame.locator("th").last().click();
    await frame.getByRole("button", { name: "批注配置" }).click();
    const color = frame.getByRole("textbox", { name: "文字颜色", exact: true });
    await color.fill("#ff0000");
    await color.fill("rgb(0, 0, 0)");
    assert.equal(await frame.locator("[data-primary]").isDisabled(), true);
    await page.close();
  } finally { await browser.close(); }
});

test("picker Escape closes only the picker; second Escape discards the draft and exits", { skip: !enabled }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame } = await open(browser, FIXTURE);
    await page.evaluate(() => window.__send({ type: "mode", mode: "pick" }));
    await frame.locator("h1").click();
    const input = frame.locator("[data-dsh-page-annotate-input]");
    await input.fill("尚未保存");
    await frame.getByRole("button", { name: "批注配置" }).click();
    const swatch = frame.getByRole("button", { name: "文字颜色取色器", exact: true });
    await swatch.click();
    await frame.getByRole("textbox", { name: "文字颜色 Hex", exact: true }).fill("#00ff00");
    await page.keyboard.press("Escape");
    assert.equal(await frame.getByRole("dialog").count(), 0);
    assert.equal(await input.inputValue(), "尚未保存");
    assert.equal(await swatch.getAttribute("aria-expanded"), "false");
    assert.equal(await swatch.evaluate(node => node === document.activeElement), true);
    assert.equal(await frame.locator("[data-style-key=color]").inputValue(), "#00ff00");
    assert.deepEqual(await page.evaluate(() => window.__frames.map(f => f.type)), ["ready"]);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => window.__frames.some(f => f.type === "exit-pick"));
    assert.equal(await input.count(), 0);
    assert.equal(await frame.locator("[data-dsh-page-annotate-layer]").getAttribute("data-mode"), "browse");
    assert.equal(await page.evaluate(() => window.__frames.filter(f => f.type === "change").length), 0);
    await page.close();
  } finally { await browser.close(); }
});

test("expanded configuration and picker scroll inside a short narrow viewport", { skip: !enabled }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame, errors } = await open(browser, FIXTURE);
    await page.locator("#f").evaluate(node => { node.style.width = "240px"; node.style.height = "230px"; });
    await page.evaluate(() => window.__send({ type: "mode", mode: "pick" }));
    await frame.locator("h1").click();
    await frame.getByRole("button", { name: "批注配置" }).click();
    await frame.getByRole("button", { name: "背景颜色取色器" }).click();
    const editor = frame.locator(".data-dsh-page-annotate-editor");
    const bounds = await editor.evaluate(node => {
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight, scroll: node.scrollHeight > node.clientHeight, overflow: getComputedStyle(node).overflowY };
    });
    assert.ok(bounds.left >= 8 && bounds.right <= bounds.width - 8);
    assert.ok(bounds.top >= 8 && bounds.bottom <= bounds.height - 8);
    assert.equal(bounds.scroll, true);
    assert.equal(bounds.overflow, "auto");
    await frame.getByRole("textbox", { name: "背景颜色 Hex", exact: true }).fill("#112233");
    await setRange(frame.getByRole("slider", { name: "背景颜色透明度" }), 60);
    await frame.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(await editor.count(), 0);
    assert.equal(await page.evaluate(() => window.__frames.filter(f => f.type === "change").length), 0);
    assert.deepEqual(errors, []);
    await page.close();
  } finally { await browser.close(); }
});
