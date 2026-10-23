/** Documents are locked so cleanup never removes another capture's clone. */
const captureDocuments = new WeakSet();

/**
 * Render the current same-origin preview viewport, not an illustrative fallback.
 * `source` is the OFFLINE html2canvas 1.4.1 UMD text supplied by the bundler.
 * No upload, proxy or CDN is used; html2canvas may re-request page resources.
 * Unsupported CSS, video/WebGL and images without CORS permission can be absent.
 *
 * Only temporary library script/clone frames touch the live document. Editor,
 * hover, animation and caret changes are confined to the cloned document.
 * @param {HTMLIFrameElement} frame preview frame (scripts + same-origin required)
 * @param {string} source vendored html2canvas browser program
 * @param {{timeoutMs?: number}} options overall time budget, including image loads
 * @returns {Promise<{type: 'image', mediaType: 'image/png', data: string, name: string}>}
 */
export async function capturePreview(frame, source, { timeoutMs = 15000, annotationIds } = {}) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('截图组件源码不可用');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('截图超时设置无效');
  let doc, win;
  try {
    doc = frame?.contentDocument;
    win = frame?.contentWindow;
    if (!doc?.documentElement || !doc.body || !win) throw new Error('not ready');
    // Explicitly probe same-origin access before injecting anything.
    void win.location.href;
  } catch {
    throw new Error('无法访问预览页面，截图需要同源且已加载的 iframe');
  }
  if (captureDocuments.has(doc)) throw new Error('页面截图正在进行中');
  const width = win.innerWidth;
  const height = win.innerHeight;
  if (!(width > 0 && height > 0)) throw new Error('预览视口尺寸无效');
  const scrollX = win.scrollX;
  const scrollY = win.scrollY;
  const previousLibrary = Object.getOwnPropertyDescriptor(win, 'html2canvas');
  const previousClones = new Set(doc.querySelectorAll('iframe.html2canvas-container'));
  const ownedClones = new Set();
  let timer, script, expired = false;
  captureDocuments.add(doc);
  const collectClones = () => {
    for (const node of doc.querySelectorAll('iframe.html2canvas-container')) {
      if (!previousClones.has(node)) ownedClones.add(node);
    }
  };
  const cleanupClones = () => {
    for (const node of ownedClones) node.remove();
  };
  try {
    // Evaluate in the iframe realm: html2canvas's document, Image and canvas
    // must belong to the preview, never the parent application document.
    script = doc.createElement('script');
    script.textContent = source;
    (doc.head || doc.documentElement).appendChild(script);
    const render = win.html2canvas;
    script.remove();
    script = undefined;
    if (typeof render !== 'function' || render === previousLibrary?.value) {
      throw new Error('截图组件未能在预览页面加载（可能受到 CSP 限制）');
    }
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        cleanupClones();
        reject(new Error('页面截图超时，请重试或仅发送文字批注'));
      }, timeoutMs);
    });
    // html2canvas synchronously appends its clone frame before its first await.
    // Collect even when render throws; the library itself does not clean up on
    // every rejection. onclone guards late continuation after a timeout.
    let work;
    try {
      work = Promise.resolve(render(doc.documentElement, {
        width, height, x: scrollX, y: scrollY,
        windowWidth: width, windowHeight: height, scrollX, scrollY,
        // html2canvas 1.4.x computes shadow clipping with canvas pixel bounds
        // in a CSS-coordinate context. A sub-1 render scale can fill the right
        // side with a shadow color. Render at CSS 1x, then downsample the PNG.
        scale: 1,
        useCORS: true,
        allowTaint: false,
        imageTimeout: timeoutMs,
        logging: false,
        removeContainer: true,
        onclone(clone) {
          if (expired) throw new Error('页面截图已超时');
          const style = clone.createElement('style');
          style.textContent = `
            *, *::before, *::after {
              animation: none !important; transition: none !important;
              caret-color: transparent !important;
            }
            .data-dsh-page-annotate-editor,
            .data-dsh-page-annotate-hover { display: none !important; }
          `;
          (clone.head || clone.documentElement).appendChild(style);
          // The library also paints zero-blur inset accents as four-sided
          // shadows. Recreate only this narrow, single-shadow case as a strip.
          for (const element of clone.querySelectorAll('body *')) {
            const computed = clone.defaultView.getComputedStyle(element);
            const shadow = computed.boxShadow;
            const parsed = /^(rgba?\([^)]+\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+0px\s+0px\s+inset$/.exec(shadow);
            if (!parsed || Number(parsed[2]) <= 0 || Number(parsed[2]) > 12 || Number(parsed[3]) !== 0) continue;
            element.style.setProperty('box-shadow', 'none', 'important');
            if (computed.position === 'static') element.style.position = 'relative';
            const strip = clone.createElement('span');
            strip.setAttribute('data-dpa-capture-accent', '');
            Object.assign(strip.style, { position: 'absolute', left: '0', top: '0', bottom: '0',
              width: `${parsed[2]}px`, background: parsed[1], pointerEvents: 'none',
              borderRadius: 'inherit' });
            element.appendChild(strip);
          }
          // The live hover can point elsewhere after save. Draw each saved
          // badge's own target in the clone, never a stale mouse highlight.
          // Each per-note image must contain only that note's markers.
          // Filter in the clone so the live batch keeps all its annotations.
          if (Array.isArray(annotationIds)) {
            const included = new Set(annotationIds);
            for (const badge of clone.querySelectorAll('.data-dsh-page-annotate-badge')) {
              if (!included.has(badge.getAttribute('data-dpa-annotation-id'))) badge.remove();
            }
          }
          const layer = clone.querySelector('[data-dsh-page-annotate-layer]');
          for (const badge of clone.querySelectorAll('.data-dsh-page-annotate-badge[data-dpa-target-selector]')) {
            const selector = badge.getAttribute('data-dpa-target-selector');
            if (!selector || !layer) continue;
            let target;
            try { target = clone.querySelector(selector); } catch { continue; }
            if (!target) continue;
            const rect = target.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= height || rect.left >= width) continue;
            const outline = clone.createElement('div');
            outline.setAttribute('data-dpa-capture-outline', '');
            Object.assign(outline.style, {
              position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
              width: `${rect.width}px`, height: `${rect.height}px`,
              boxSizing: 'border-box', border: '2px solid #1677ff',
              background: 'rgba(22,119,255,0.06)', pointerEvents: 'none',
              zIndex: '0'
            });
            layer.insertBefore(outline, layer.firstChild);
            // Explicitly retain number above the outline even in unusual pages.
            badge.style.zIndex = '2';
          }
        }
      }));
    } finally {
      collectClones();
    }
    // Attach a rejection handler even if the deadline wins the race; no late
    // rejection becomes unhandled and any delayed render completion is retired.
    const canvas = await Promise.race([work.finally(cleanupClones), deadline]);
    if (frame.contentDocument !== doc) throw new Error('截图期间预览页面已重新加载');
    let output = canvas;
    const outputScale = Math.min(1, 1600 / Math.max(width, height));
    if (outputScale < 1) {
      output = doc.createElement('canvas');
      output.width = Math.round(width * outputScale);
      output.height = Math.round(height * outputScale);
      const context = output.getContext('2d');
      if (!context) throw new Error('截图缩放失败');
      context.drawImage(canvas, 0, 0, output.width, output.height);
    }
    const url = output.toDataURL('image/png');
    if (!url.startsWith('data:image/png;base64,') || url.length < 30) {
      throw new Error('截图未生成有效 PNG');
    }
    return { type: 'image', mediaType: 'image/png', data: url.slice(22), name: '页面批注.png' };
  } finally {
    clearTimeout(timer);
    script?.remove();
    cleanupClones();
    if (previousLibrary) Object.defineProperty(win, 'html2canvas', previousLibrary);
    else delete win.html2canvas;
    captureDocuments.delete(doc);
  }
}
