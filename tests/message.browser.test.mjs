import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { wrapAnnotationMessage } from '../src/message.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = await import('playwright'); } catch {
  try { playwright = await import('/Users/baigo/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs'); } catch { /* optional browser dependency */ }
}

async function browserReact() {
  const modules = new Map();
  async function collect(filename) {
    if (modules.has(filename)) return;
    const entry = { source: await readFile(filename, 'utf8'), deps: {} };
    modules.set(filename, entry);
    for (const match of entry.source.matchAll(/\brequire\(["']([^"']+)["']\)/g)) {
      const target = createRequire(filename).resolve(match[1]);
      entry.deps[match[1]] = target;
      await collect(target);
    }
  }
  const roots = Object.fromEntries(['react', 'react-dom/client'].map(id => [id, require.resolve(id)]));
  for (const filename of Object.values(roots)) await collect(filename);
  const definitions = [...modules].map(([filename, { source, deps }]) => `${JSON.stringify(filename)}:[function(require,module,exports,process){\n${source}\n},${JSON.stringify(deps)}]`).join(',\n');
  return `(() => { const modules={${definitions}}, cache={};
    function load(id) { if(cache[id]) return cache[id].exports;
      const [factory,deps]=modules[id]; const module=cache[id]={exports:{}};
      factory(name=>load(deps[name]),module,module.exports,{env:{NODE_ENV:'development'}}); return module.exports; }
    window.__react=Object.fromEntries(Object.entries(${JSON.stringify(roots)}).map(([id,path])=>[id,load(path)]));
  })();`;
}

test('real React in Chromium: inline card collapses, expands selectable complete raw text and keeps preview inert', { skip: !playwright }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<!doctype html><span id="message"></span><span id="preview"></span>');
    await page.addScriptTag({ content: await browserReact() });
    const source = (await readFile(new URL('../src/message.mjs', import.meta.url), 'utf8'))
      .replace(/^export\s+(const|function)\s/gm, '$1 ');
    await page.addScriptTag({ content: source + '\nwindow.__Message = createAnnotationMessageComponent(window.__react.react);' });
    const raw = wrapAnnotationMessage('完整提示词\n  保留缩进 <script>不可执行</script>\n' + '长段落🙂\n'.repeat(1500), { count: 2, imageCount: 2 });
    await page.evaluate(raw => {
      const React = window.__react.react;
      const createRoot = window.__react['react-dom/client'].createRoot;
      for (const id of ['message', 'preview']) createRoot(document.getElementById(id)).render(
        React.createElement(window.__Message, { node: {}, raw, interactive: id === 'message' }));
    }, raw);
    const button = page.locator('#message button');
    await button.waitFor();
    assert.match(await button.textContent(), /^2条批注 · 2张截图/);
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('[data-dpa-message-raw]').count(), 0);
    assert.equal(await page.locator('#preview').textContent(), '2条批注 · 2张截图');
    assert.equal(await page.locator('#preview button').count(), 0);
    await button.click();
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
    const full = page.locator('[data-dpa-message-raw]');
    assert.equal(await full.textContent(), raw);
    assert.deepEqual(await full.evaluate(el => {
      const style = getComputedStyle(el);
      const selection = window.getSelection();
      selection.selectAllChildren(el);
      return { whitespace: style.whiteSpace, selectable: style.userSelect, selected: selection.toString().trimEnd() === el.textContent.trimEnd() };
    }), { whitespace: 'pre-wrap', selectable: 'text', selected: true });
    assert.equal(await page.locator('#message div, #message p, #message pre, #message details').count(), 0);
    assert.equal(await page.locator('#message script').count(), 0);
    await button.click();
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    assert.equal(await full.count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
