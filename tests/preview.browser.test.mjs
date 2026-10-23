/** Real React + Chromium regression for the live document renderer.
 * Services are recorded doubles; React, the built loader bundle, overlay, DOM
 * events and screenshot renderer are the production implementations.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = await import('playwright'); } catch {
  try { playwright = await import('/Users/baigo/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs'); } catch { /* optional local browser dependency */ }
}

// The installed React distribution exposes CommonJS, not browser ESM or UMD.
// Bundle only its static require graph in memory: no downloads, build tools,
// production dependency, generated repository files, or fake React hooks.
async function browserReact() {
  const modules = new Map();
  async function collect(filename) {
    if (modules.has(filename)) return;
    const entry = { source: await readFile(filename, 'utf8'), deps: {} };
    modules.set(filename, entry);
    for (const match of entry.source.matchAll(/\brequire\(["']([^"']+)["']\)/g)) {
      const id = match[1];
      const target = createRequire(filename).resolve(id);
      entry.deps[id] = target;
      await collect(target);
    }
  }
  const roots = Object.fromEntries(['react', 'react/jsx-runtime', 'react-dom/client'].map(id => [id, require.resolve(id)]));
  for (const filename of Object.values(roots)) await collect(filename);
  const definitions = [...modules].map(([filename, { source, deps }]) => `${JSON.stringify(filename)}:[function(require,module,exports,process){\n${source}\n},${JSON.stringify(deps)}]`).join(',\n');
  return `(() => { const modules={${definitions}}, cache={};
    function load(id) { if(cache[id]) return cache[id].exports;
      const [factory,deps]=modules[id]; const module=cache[id]={exports:{}};
      factory(name=>load(deps[name]),module,module.exports,{env:{NODE_ENV:'development'}}); return module.exports; }
    const roots=${JSON.stringify(roots)};
    window.__reactFixture=Object.fromEntries(Object.entries(roots).map(([id,path])=>[id,load(path)]));
  })();`;
}

const prototype = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:16px Arial;margin:20px}button,input{font:inherit;padding:8px}
#modal{position:fixed;left:80px;top:80px;width:420px;padding:24px;background:#def;border:2px solid #357}
#modal[hidden]{display:none}#modal-child{display:inline-block;padding:14px;background:white}
</style></head><body><button id="open">Open prototype modal</button>
<section id="modal" hidden><h2>Prototype modal</h2><input id="draft" value="initial">
<button id="original"><span id="modal-child">Original JS action</span></button><output id="count">0</output></section>
<script>(()=>{let count=0;document.querySelector('#open').onclick=()=>document.querySelector('#modal').hidden=false;
document.querySelector('#original').addEventListener('click',()=>{document.querySelector('#count').textContent=String(++count)});
window.readClosure=()=>count;})();</script></body></html>`;

async function mount(browser) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<!doctype html><html><head><style>html,body{margin:0;height:100%}#host{height:780px}#preview{height:740px}</style></head><body><div id="host" data-sidebar-right-tab="document-occurrence-7"><div id="action"></div><div id="preview"></div></div></body></html>');
  await page.addScriptTag({ content: await browserReact() });
  await page.evaluate(() => { window.__ModuleLoader__ = { load(registration) { window.__plugin = registration.factory(id => {
    if (!(id in window.__reactFixture)) throw new Error(`Unexpected require ${id}`);
    return window.__reactFixture[id];
  }); } }; });
  await page.addScriptTag({ content: await readFile(new URL('../lib/client.js', import.meta.url), 'utf8') });
  await page.evaluate(html => {
    const state = window.__testState = { slots: [], renderers: [], prompts: [], navigation: [], outcome: 'success' };
    const ctx = {
      effect(fn) { return fn(); }, locale: { register() {} }, sidebarRightTabs: { register() {} },
      documentPreviews: { register(value) { state.renderers.push(value); } },
      uiConversation: { userText: { register(rule) { state.messageRule = rule; return () => {}; } } },
      slots: { inject(_seat, fn) { return fn(); }, register(header, component) { state.slots.push({ ...header, component }); } },
      sidebarRight: { openResourceIn(...args) { state.navigation.push(args); } },
      sessions: { binding() { return { session: { async prompt(content, mode) {
        state.prompts.push({ content, mode });
        if (state.outcome === 'throw') throw new Error('forced transport failure');
        if (state.outcome === 'reject') return { ok: false, error: { message: 'forced send failure' } };
        return { ok: true };
      } } }; } }, get() {}, remote: { workspaceFiles: { readBytes() { throw new Error('embedded content must not be re-read'); } } }
    };
    window.__plugin.apply(ctx);
    const renderer = state.slots.find(slot => slot.name === 'sidebar.right.tab.document' && slot.key === 'dsh-page-annotate/html');
    if (!renderer) throw new Error('Missing live HTML document renderer registration');
    const action = state.slots.find(slot => slot.name === 'sidebar.right.tab.document.actions');
    const React = window.__reactFixture.react;
    const { createRoot } = window.__reactFixture['react-dom/client'];
    const sessionId = 'session-live';
    const address = 'dsh-resource://file/session/session-live//work/prototype.html';
    const tab = { id: 'document-occurrence-7', contentId: address, signal: new AbortController().signal };
    const common = { sessionId, t: (key, values) => values ? `${key}: ${values.message ?? values.count ?? ''}` : key, useTabInfo: () => ({ tab }) };
    createRoot(document.querySelector('#preview')).render(React.createElement(renderer.component, {
      ...renderer.inject(sessionId), ...common, content: { kind: 'bytes', data: new TextEncoder().encode(html) }, resourceAddress: address
    }));
    createRoot(document.querySelector('#action')).render(React.createElement(action.component, {
      ...action.inject(sessionId), ...common, absolutePath: '/work/prototype.html'
    }));
  }, prototype);
  await page.frameLocator('[data-dpa-frame]').locator('#open').waitFor();
  return { page, frame: page.frameLocator('[data-dpa-frame]'), errors };
}

async function prepare(page, frame) {
  await assertPlain(page);
  await frame.locator('#open').click();
  await frame.locator('#draft').fill('unsaved modal input');
  await frame.locator('#modal-child').click();
  await page.evaluate(() => {
    const frame = document.querySelector('[data-dpa-frame]');
    window.__identities = { frame, win: frame.contentWindow, doc: frame.contentDocument,
      modal: frame.contentDocument.querySelector('#modal'), input: frame.contentDocument.querySelector('#draft'),
      closure: frame.contentWindow.readClosure };
    window.__frameLoads = 0;
    frame.addEventListener('load', () => window.__frameLoads++);
  });
  await page.locator('[data-dpa-open]').click();
  await page.locator('.dpa_bar').waitFor();
  await assertPreserved(page);
  // Activation may begin in pick mode; otherwise explicitly enable it.
  const pick = page.locator('.dpa_bar button[aria-pressed]');
  if (await pick.getAttribute('aria-pressed') !== 'true') await pick.click();
  await frame.locator('#modal-child').click();
  await frame.locator('[data-dsh-page-annotate-input]').fill('Keep this open modal and update its child');
  await frame.getByRole('button', { name: '保存批注', exact: true }).click();
  await page.locator('[data-dpa-row]').waitFor();
  await assertPreserved(page); // pick must not fire the original button.
}

async function assertPreserved(page, count = 1) {
  assert.deepEqual(await page.evaluate(() => {
    const old = window.__identities, frame = document.querySelector('[data-dpa-frame]');
    return { frame: frame === old.frame, win: frame.contentWindow === old.win, doc: frame.contentDocument === old.doc,
      modal: frame.contentDocument.querySelector('#modal') === old.modal,
      input: frame.contentDocument.querySelector('#draft') === old.input,
      closure: frame.contentWindow.readClosure === old.closure,
      open: !old.modal.hidden, value: old.input.value, count: old.closure(), loads: window.__frameLoads,
      navigation: window.__testState.navigation.length };
  }), { frame: true, win: true, doc: true, modal: true, input: true, closure: true,
    open: true, value: 'unsaved modal input', count, loads: 0, navigation: 0 });
}

async function assertPlain(page) {
  assert.equal(await page.locator('#preview iframe').count(), 1);
  assert.equal(await page.locator('#preview .dpa_bar:visible, #preview .dpa_list:visible, #preview .dpa_foot:visible, #preview button:visible, #preview input:visible').count(), 0,
    'ordinary preview has no visible annotation controls');
  assert.equal(await page.locator('#preview').evaluate(root => [...root.querySelectorAll('*')].filter(node =>
    node.tagName !== 'IFRAME' && node.checkVisibility() && [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim())).length), 0,
    'ordinary preview has no visible extra text UI');
}

test('live HTML renderer keeps modal, input, document and original JS across annotation and successful screenshot send', { skip: !playwright }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame, errors } = await mount(browser);
    await prepare(page, frame);
    await page.locator('.dpa_primary').click();
    await page.locator('.dpa_foot').waitFor({ state: 'hidden' });
    await assertPlain(page);
    await assertPreserved(page);
    assert.equal(await frame.locator('[data-dsh-page-annotate-input]').count(), 0);
    assert.equal(await frame.locator('.data-dsh-page-annotate-badge').count(), 0);
    const prompts = await page.evaluate(() => window.__testState.prompts);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].mode, 'queue');
    assert.match(prompts[0].content[0].text, /Keep this open modal/);
    assert.equal(prompts[0].content[1].mediaType, 'image/png');
    assert.equal(Buffer.from(prompts[0].content[1].data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    await frame.locator('#modal-child').click();
    await assertPreserved(page, 2);
    // Reactivate the same occurrence: no leaked badges or stale annotations.
    await page.locator('[data-dpa-open]').click();
    await page.locator('.dpa_foot').waitFor();
    assert.equal(await page.locator('[data-dpa-row]').count(), 0);
    await assertPreserved(page, 2);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('two saved viewport snapshots retain distinct PNG mapping and render a folded ordinary user message', { skip: !playwright }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, frame, errors } = await mount(browser);
    // Observe completed real PNG exports; no fake capture implementation or timer sleeps.
    await page.evaluate(() => {
      const win = document.querySelector('[data-dpa-frame]').contentWindow;
      const original = win.HTMLCanvasElement.prototype.toDataURL;
      window.__pngExports = [];
      win.HTMLCanvasElement.prototype.toDataURL = function (...args) {
        const result = original.apply(this, args);
        if (args[0] === 'image/png') window.__pngExports.push(result.slice(22));
        return result;
      };
    });
    await prepare(page, frame);
    await page.waitForFunction(() => window.__pngExports.length === 1);
    // Return to normal page interaction, visibly change the real page, then pick a different element.
    await frame.locator('body').press('Escape');
    await page.waitForFunction(() => document.querySelector('.dpa_bar button[aria-pressed]')?.getAttribute('aria-pressed') === 'false');
    await frame.locator('#draft').fill('second snapshot changed input');
    await frame.locator('body').evaluate(body => {
      body.style.background = '#ffe39b';
      document.querySelector('#modal').style.background = '#ffbfd9';
      document.querySelector('#modal h2').textContent = 'Second viewport state';
    });
    await page.locator('.dpa_bar button[aria-pressed]').click();
    await frame.locator('#modal h2').click();
    await frame.locator('[data-dsh-page-annotate-input]').fill('Second note belongs to the changed pink modal');
    await frame.getByRole('button', { name: '保存批注', exact: true }).click();
    await page.waitForFunction(() => window.__pngExports.length === 2);
    assert.equal(await page.locator('[data-dpa-row]').count(), 2);
    await page.locator('.dpa_primary').click();
    await page.locator('.dpa_foot').waitFor({ state: 'hidden' });
    const sent = await page.evaluate(() => ({ prompts: window.__testState.prompts, exports: window.__pngExports }));
    assert.equal(sent.prompts.length, 1);
    const [text, first, second] = sent.prompts[0].content;
    assert.equal(sent.prompts[0].content.length, 3);
    assert.ok(text.text.startsWith('[DSH_PAGE_ANNOTATIONS_V1 count=2 images=2]\n'));
    assert.match(text.text, /Keep this open modal and update its child/);
    assert.match(text.text, /Second note belongs to the changed pink modal/);
    assert.match(text.text, /附图 1（S1）对应批注 1/);
    assert.match(text.text, /附图 2（S2）对应批注 2/);
    assert.equal(first.name, '截图01-批注1.png');
    assert.equal(second.name, '截图02-批注2.png');
    assert.equal(first.mediaType, 'image/png');
    assert.equal(second.mediaType, 'image/png');
    assert.notEqual(first.data, second.data);
    assert.equal(first.data, sent.exports[0]);
    assert.equal(second.data, sent.exports[1]);
    for (const image of [first, second]) assert.equal(Buffer.from(image.data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const match = await page.evaluate(() => {
      const state = window.__testState;
      const raw = state.prompts[0].content[0].text;
      const node = state.messageRule.match(raw, 0, {});
      const slot = state.slots.find(slot => slot.name === 'conversation.user.text.node' && slot.key === 'dsh-page-annotate/message');
      if (!slot || !node) throw new Error('Missing registered annotation message rule/slot');
      const host = document.createElement('span');
      host.id = 'sent-message';
      document.body.appendChild(host);
      window.__reactFixture['react-dom/client'].createRoot(host).render(
        window.__reactFixture.react.createElement(slot.component, { node, raw, interactive: true }));
      return node;
    });
    assert.equal(match.start, 0);
    assert.equal(match.end, text.text.length);
    assert.equal(match.data.count, 2);
    assert.equal(match.data.imageCount, 2);
    const toggle = page.locator('#sent-message button');
    await toggle.waitFor();
    assert.match(await toggle.textContent(), /^2条批注 · 2张截图/);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#sent-message [data-dpa-message-raw]').count(), 0);
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#sent-message [data-dpa-message-raw]').textContent(), text.text);
    await toggle.click();
    assert.equal(await page.locator('#sent-message [data-dpa-message-raw]').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

for (const failure of ['capture', 'reject', 'throw']) {
  test(`live preview retains modal and annotations after ${failure} failure and can retry without remount`, { skip: !playwright }, async () => {
    const browser = await playwright.chromium.launch();
    try {
      const { page, frame, errors } = await mount(browser);
      // Fail capture before saving: screenshots now start when a note saves.
      if (failure === 'capture') await page.evaluate(() => {
        const win = document.querySelector('[data-dpa-frame]').contentWindow;
        window.__originalExport = win.HTMLCanvasElement.prototype.toDataURL;
        win.HTMLCanvasElement.prototype.toDataURL = () => { throw new Error('forced screenshot failure'); };
      });
      await prepare(page, frame);
      await page.evaluate(failure => {
        if (failure === 'capture') {
          const win = document.querySelector('[data-dpa-frame]').contentWindow;
          // Already replaced before prepare; do not overwrite the original.
          win.HTMLCanvasElement.prototype.toDataURL = () => { throw new Error('forced screenshot failure'); };
        } else window.__testState.outcome = failure;
      }, failure);
      await page.locator('.dpa_primary').click();
      await page.waitForFunction(() => document.querySelector('[data-dpa-status]')?.getAttribute('data-tone') === 'error');
      assert.match(await page.locator('[data-dpa-status]').textContent(), failure === 'capture' ? /capture.failed/ : /status.sendFailed/);
      assert.equal(await page.locator('[data-dpa-row]').count(), 1);
      assert.equal(await page.locator('.dpa_foot').count(), 1);
      assert.equal(await page.evaluate(() => window.__testState.prompts.length), failure === 'capture' ? 0 : 1);
      await assertPreserved(page);
      // A save-time error can render before send's pending capture retry settles.
      // Keep the forced failure installed until send's finally re-enables retry.
      await page.waitForFunction(() => document.querySelector('.dpa_primary')?.disabled === false);
      await page.evaluate(() => {
        window.__testState.outcome = 'success';
        if (window.__originalExport) document.querySelector('[data-dpa-frame]').contentWindow.HTMLCanvasElement.prototype.toDataURL = window.__originalExport;
      });
      await page.locator('.dpa_primary').click();
      await page.locator('.dpa_foot').waitFor({ state: 'hidden' });
      await assertPlain(page);
      await assertPreserved(page);
      await frame.locator('#modal-child').click();
      await assertPreserved(page, 2);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
