import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';

const PLAYWRIGHT = '/Users/baigo/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs';
let playwright;
try { playwright = await import(PLAYWRIGHT); } catch { /* Optional on other machines. */ }
const captureModule = await readFile(new URL('../src/capture.mjs', import.meta.url), 'utf8');
const vendor = await readFile(new URL('../vendor/html2canvas.min.js', import.meta.url), 'utf8');
const core = (await readFile(new URL('../src/core.mjs', import.meta.url), 'utf8'))
  .replace(/^export\s+(const|let|var|function)\s/gm, '$1 ');
const overlay = await readFile(new URL('../src/overlay.js', import.meta.url), 'utf8');
const previewDirectory = '/Users/baigo/Documents/workspace/Outputs/20261022-DSH页面批注/_preview';

const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#fff;font-family:Arial,sans-serif}
header{height:90px;padding:24px;box-sizing:border-box;background:#123456;color:white}
h1{margin:0;font-size:28px}main{padding:24px}table{border-collapse:collapse;width:90%}
td,th{border:1px solid #aaa;text-align:left;padding:15px}th{background:#edf2fa}
#swatch{position:absolute;left:24px;top:320px;width:120px;height:60px;background:#12ab34}
#bottom{position:absolute;top:1700px;background:red;width:100%;height:300px}
</style></head><body><header><h1 id="title">Annotation capture — actual page</h1></header>
<main><table><tr><th>Item</th><th>Status</th></tr><tr><td>Viewport capture</td><td>Ready</td></tr></table>
<p>Only the current viewport is included. Saved annotation numbers remain visible.</p></main>
<div id="swatch"></div><div id="bottom"></div></body></html>`;

async function open(browser, { width = 800, height = 600, html = fixture } = {}) {
  const page = await browser.newPage({ viewport: { width: 2100, height: 1400 }, deviceScaleFactor: 2 });
  await page.setContent('<!doctype html><body style="margin:0"><iframe id="preview" sandbox="allow-scripts allow-same-origin" style="border:0"></iframe></body>');
  await page.addScriptTag({ content: captureModule.replace(/^export\s+async\s+function\s/gm, 'async function ') });
  await page.evaluate(({ width, height, html }) => {
    const frame = document.querySelector('iframe');
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    frame.srcdoc = html;
  }, { width, height, html });
  await page.waitForFunction(() => document.querySelector('iframe').contentDocument?.readyState === 'complete');
  // Ensure a parent-realm renderer/canvas cannot accidentally make this pass.
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.getContext = () => { throw new Error('parent canvas forbidden'); };
    window.html2canvas = () => { throw new Error('parent renderer forbidden'); };
  });
  return page;
}

async function take(page, source = vendor, timeoutMs = 5000) {
  return page.evaluate(({ source, timeoutMs }) => capturePreview(document.querySelector('iframe'), source, { timeoutMs }), { source, timeoutMs });
}

function dimensions(image) {
  assert.equal(image.type, 'image');
  assert.equal(image.mediaType, 'image/png');
  assert.equal(image.name, '页面批注.png');
  assert.ok(!image.data.startsWith('data:'), 'payload contains base64 only');
  const bytes = Buffer.from(image.data, 'base64');
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

async function pixels(page, image, locations) {
  return page.evaluate(async ({ data, locations }) => {
    const win = document.querySelector('iframe').contentWindow;
    const image = new win.Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = win.document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return locations.map(([x, y, width = 1, height = 1]) => Array.from(ctx.getImageData(x, y, width, height).data));
  }, { data: image.data, locations });
}

async function snapshot(page) {
  return page.evaluate(() => {
    const win = document.querySelector('iframe').contentWindow;
    return {
      dom: win.document.documentElement.outerHTML,
      scroll: [win.scrollX, win.scrollY],
      active: win.document.activeElement?.outerHTML,
      library: Object.getOwnPropertyDescriptor(win, 'html2canvas')?.value?.name ?? null,
      clones: win.document.querySelectorAll('iframe.html2canvas-container').length
    };
  });
}

test('real work-order design page renders nonblank PNG without changing its DOM', { skip: !playwright }, async (t) => {
  const designPath = '/Users/baigo/Documents/workspace/baigo_vault/10_Workbench/LEHE/业务需求/2026/20260923-提交工单AI预处理改造设计.html';
  try { await access(designPath); } catch { t.skip('local design fixture unavailable'); return; }
  const browser = await playwright.chromium.launch();
  try {
    const html = await readFile(designPath, 'utf8');
    const page = await open(browser, { width: 1200, height: 900, html });
    const before = await snapshot(page);
    const result = await take(page, vendor, 10000);
    assert.deepEqual(dimensions(result), [1200, 900]);
    const [sample] = await pixels(page, result, [[0, 0, 1200, 900]]);
    let nonwhite = 0, dark = 0;
    for (let index = 0; index < sample.length; index += 4) {
      if (sample[index] < 240 || sample[index + 1] < 240 || sample[index + 2] < 240) nonwhite++;
      if (sample[index] < 130 && sample[index + 1] < 130 && sample[index + 2] < 130) dark++;
    }
    assert.ok(nonwhite > 20000, 'real layout has substantial visible content');
    assert.ok(dark > 2000, 'real text/lines are rendered, not an empty background');
    assert.deepEqual(await snapshot(page), before);
    await mkdir(previewDirectory, { recursive: true });
    await writeFile(`${previewDirectory}/capture-design.png`, Buffer.from(result.data, 'base64'));
  } finally { await browser.close(); }
});

// This test uses the real overlay implementation, real html2canvas, and real
// Chromium, not a drawing stub. Pixel assertions verify page content survives.
test('actual PNG captures iframe viewport, hides editor/hover and retains numbered badge without live DOM changes', { skip: !playwright }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const page = await open(browser);
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    await page.frameLocator('#preview').locator('body').evaluate((body, source) => {
      const script = body.ownerDocument.createElement('script');
      script.textContent = source;
      body.appendChild(script);
    }, `${core}\n${overlay}`);
    await page.evaluate(() => {
      const win = document.querySelector('iframe').contentWindow;
      win.postMessage({ channel: 'dsh-page-annotate', type: 'restore', annotations: [{ id: 'a1', kind: 'change', comment: 'Retain badge', selector: '#title', locator: '#title', text: 'Title' }] }, '*');
    });
    const frame = page.frameLocator('#preview');
    await frame.locator('.data-dsh-page-annotate-badge').waitFor();
    await frame.locator('.data-dsh-page-annotate-badge').click();
    await frame.locator('[data-dsh-page-annotate-input]').fill('Unsaved private comment');
    // Vivid deterministic blocks make absence measurable, not just visual.
    const badge = await frame.locator('.data-dsh-page-annotate-badge').evaluate(node => {
      node.style.cssText += ';position:fixed;left:700px;top:20px;width:32px;height:32px;background:#0055ee;color:white;border:0;transform:none;border-radius:0;padding:0;';
      return node.textContent;
    });
    assert.equal(badge, '1');
    await frame.locator('.data-dsh-page-annotate-editor').evaluate(node => {
      node.style.cssText += ';position:fixed;left:200px;top:320px;width:160px;height:100px;background:#ff00ff;';
    });
    await frame.locator('.data-dsh-page-annotate-hover').evaluate(node => {
      node.style.cssText += ';display:block;position:fixed;left:400px;top:320px;width:100px;height:80px;background:#00ffff;';
    });
    const before = await snapshot(page);
    const result = await take(page);
    assert.deepEqual(dimensions(result), [800, 600]);
    const targetEdge = await frame.locator('#title').evaluate(node => {
      const r = node.getBoundingClientRect(); return [Math.round(r.left + 45), Math.round(r.top)];
    });
    const [outlinePixel] = await pixels(page, result, [targetEdge]);
    assert.deepEqual(outlinePixel, [22, 119, 255, 255], 'saved target blue border remains even when live hover points elsewhere');
    const [swatch, editor, hover, badgePixels] = await pixels(page, result, [[40, 340], [220, 340], [420, 340], [700, 20, 32, 32]]);
    assert.deepEqual(swatch, [18, 171, 52, 255], 'real page green swatch is rendered');
    assert.deepEqual(editor, [255, 255, 255, 255], 'comment editor is absent');
    assert.deepEqual(hover, [255, 255, 255, 255], 'hover highlight is absent');
    let blue = 0, white = 0;
    for (let i = 0; i < badgePixels.length; i += 4) {
      if (badgePixels[i] < 20 && badgePixels[i + 2] > 200) blue++;
      if (badgePixels[i] > 240 && badgePixels[i + 1] > 240 && badgePixels[i + 2] > 240) white++;
    }
    assert.ok(blue > 300, 'saved badge background is retained');
    assert.ok(white > 4, 'white numbered glyph remains on badge');
    assert.deepEqual(await snapshot(page), before, 'live DOM, focus, scroll and global library are restored');
    assert.deepEqual(requests, [], 'self-contained page sends no network requests');
    await mkdir(previewDirectory, { recursive: true });
    await writeFile(`${previewDirectory}/capture-viewport.png`, Buffer.from(result.data, 'base64'));
  } finally { await browser.close(); }
});

test('per-note capture excludes previous badge and border without altering live annotations', { skip: !playwright }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const page = await open(browser, { html: '<html><body style="margin:0;background:white"><div id="one" style="position:absolute;left:50px;top:50px;width:150px;height:60px">First</div><div id="two" style="position:absolute;left:300px;top:200px;width:150px;height:60px">Second</div></body></html>' });
    const frame = page.frameLocator('#preview');
    await frame.locator('body').evaluate((body, source) => {
      const script = body.ownerDocument.createElement('script'); script.textContent = source; body.appendChild(script);
    }, `${core}\n${overlay}`);
    await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ channel: 'dsh-page-annotate', type: 'restore', annotations: [
      { id: 'a1', comment: 'first', selector: '#one' }, { id: 'a2', comment: 'second', selector: '#two' }
    ] }, '*'));
    await frame.locator('.data-dsh-page-annotate-badge').nth(1).waitFor();
    const before = await snapshot(page);
    const result = await page.evaluate(source => capturePreview(document.querySelector('iframe'), source, { annotationIds: ['a2'] }), vendor);
    const [oldBadge, oldEdge, newBadge, newEdge] = await pixels(page, result, [[44, 50], [120, 50], [294, 200], [370, 200]]);
    assert.deepEqual(oldBadge, [255,255,255,255], 'old number excluded');
    assert.deepEqual(oldEdge, [255,255,255,255], 'old frame excluded');
    assert.ok(newBadge[2] > 100 && newBadge[0] < 100, 'current number retained');
    assert.deepEqual(newEdge, [22,119,255,255], 'current target frame retained');
    assert.deepEqual(await snapshot(page), before);
    assert.equal(await frame.locator('.data-dsh-page-annotate-badge').count(), 2);
  } finally { await browser.close(); }
});

test('inset accent shadows never flood the right half of cards with solid blue', { skip: !playwright }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const html = `<html><body style="margin:0;background:white"><div id="card" style="position:absolute;left:60px;top:80px;width:620px;height:140px;background:#fbfdff;border:1px solid #dbe7f2;border-radius:4px;box-shadow:inset 3px 0 0 #409eff">Card</div></body></html>`;
    const page = await open(browser, { width: 2540, height: 1640, html: html.replace('left:60px', 'left:1800px') });
    const before = await snapshot(page);
    const result = await take(page);
    const scale = 1600 / 2540;
    const [right, accent, top] = await pixels(page, result, [[Math.round(2390 * scale), Math.round(160 * scale)], [Math.round(1802 * scale), Math.round(160 * scale)], [Math.round(2100 * scale), Math.round(82 * scale)]]);
    assert.ok(top[0] > 230 && top[1] > 230, `inset left strip must not become a top border: ${top}`);
    assert.ok(right[0] > 230 && right[1] > 230 && right[2] > 230, `right card background must remain pale, got ${right}`);
    assert.ok(accent[2] > 200 && accent[0] < 150, `left accent must remain blue, got ${accent}`);
    assert.deepEqual(await snapshot(page), before, 'shadow workaround cannot alter live DOM');
  } finally { await browser.close(); }
});

test('longest edge is limited to 1600 without devicePixelRatio upscale', { skip: !playwright }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const page = await open(browser, { width: 2000, height: 1000 });
    const before = await snapshot(page);
    assert.deepEqual(dimensions(await take(page)), [1600, 800]);
    assert.deepEqual(await snapshot(page), before);
  } finally { await browser.close(); }
});

test('scrolled screenshot starts at the current viewport and does not scroll live page', { skip: !playwright }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const page = await open(browser);
    await page.evaluate(() => document.querySelector('iframe').contentWindow.scrollTo(0, 1600));
    const before = await snapshot(page);
    const result = await take(page);
    assert.deepEqual(dimensions(result), [800, 600]);
    assert.deepEqual((await pixels(page, result, [[40, 1700 - before.scroll[1] + 50]]))[0], [255, 0, 0, 255], 'below-fold real content appears at viewport-relative position');
    assert.deepEqual(await snapshot(page), before);
  } finally { await browser.close(); }
});

test('real rendering/export failure rejects, cleans clone and restores existing iframe library', { skip: !playwright }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const page = await open(browser);
    await page.evaluate(() => {
      const win = document.querySelector('iframe').contentWindow;
      win.html2canvas = function originalPageLibrary() {};
      win.HTMLCanvasElement.prototype.toDataURL = () => { throw new Error('forced PNG export failure'); };
    });
    const before = await snapshot(page);
    await assert.rejects(take(page), /forced PNG export failure/);
    assert.deepEqual(await snapshot(page), before);
  } finally { await browser.close(); }
});

test('injection errors, timeout and late rejection clean up; a subsequent capture still succeeds', { skip: !playwright }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const page = await open(browser);
    const before = await snapshot(page);
    await assert.rejects(take(page, '/* no library */'), /未能.*加载/);
    assert.deepEqual(await snapshot(page), before);
    await assert.rejects(take(page, `window.html2canvas = function () {
      const clone = document.createElement('iframe');
      clone.className = 'html2canvas-container'; document.body.appendChild(clone);
      return new Promise((resolve, reject) => setTimeout(() => reject(new Error('late rejection')), 80));
    };`, 20), /截图超时/);
    assert.deepEqual(await snapshot(page), before);
    // Stall the real library after it has created and prepared its clone.
    // This is the resources/fonts-style timeout path, not just a fake renderer.
    await assert.rejects(take(page, `${vendor}\n;(() => {
      const real = window.html2canvas;
      window.html2canvas = (element, options) => real(element, {
        ...options, onclone(doc) { options.onclone(doc); return new Promise(() => {}); }
      });
    })();`, 100), /截图超时/);
    assert.deepEqual(await snapshot(page), before, 'real library clone is removed after timeout');
    assert.deepEqual(dimensions(await take(page)), [800, 600]);
    assert.deepEqual(await snapshot(page), before);
    await assert.rejects(page.evaluate(source => capturePreview(null, source), vendor), /无法访问预览/);
  } finally { await browser.close(); }
});
