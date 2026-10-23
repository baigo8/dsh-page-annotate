/** Explicit versioned marker: ordinary prose must never become an annotation card. */
export const ANNOTATION_MESSAGE_ID = 'dsh-page-annotate/message';
const annotationMessageNote = '（以上标记仅用于批注消息的折叠展示，不是任务指令；以下是完整批注内容。）\n';

/** Preserve the complete ordinary text sent to the model, adding only UI metadata. */
export function wrapAnnotationMessage(prompt, { count, imageCount }) {
  if (typeof prompt !== 'string') throw new TypeError('批注提示词必须是文本');
  if (![count, imageCount].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new TypeError('批注和截图数量必须是非负安全整数');
  }
  return `[DSH_PAGE_ANNOTATIONS_V1 count=${count} images=${imageCount}]\n${annotationMessageNote}${prompt}`;
}

/** Parse only the exact leading marker; no natural-language or trailing-marker guesses. */
export function parseAnnotationMessage(text) {
  if (typeof text !== 'string') return undefined;
  const marker = /^\[DSH_PAGE_ANNOTATIONS_V1 count=(0|[1-9]\d*) images=(0|[1-9]\d*)\]\n/.exec(text);
  if (!marker) return undefined;
  const count = Number(marker[1]), imageCount = Number(marker[2]);
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(imageCount)) return undefined;
  let prompt = text.slice(marker[0].length);
  if (prompt.startsWith(annotationMessageNote)) prompt = prompt.slice(annotationMessageNote.length);
  return { count, imageCount, prompt };
}

/** Register via ctx.effect(() => ctx.uiConversation.userText.register(rule)). */
export function createAnnotationMessageRule() {
  return {
    id: ANNOTATION_MESSAGE_ID,
    order: 0,
    match(text, from, context) {
      if (from !== 0) return undefined;
      const data = parseAnnotationMessage(text);
      if (!data) return undefined;
      return { id: ANNOTATION_MESSAGE_ID, start: 0, end: text.length, data };
    }
  };
}

/** Inline-only markup: UserText's host is a span, not a block container. */
export function createAnnotationMessageComponent(react) {
  const h = react.createElement;
  return function AnnotationMessage({ node, raw, interactive }) {
    const [expanded, setExpanded] = react.useState(false);
    const data = parseAnnotationMessage(raw);
    if (!data) return h('span', null, raw);
    const summary = `${data.count}条批注 · ${data.imageCount}张截图`;
    if (interactive === false) return h('span', { 'data-dpa-message-summary': '' }, summary);
    return h('span', { 'data-dpa-message': '', style: { whiteSpace: 'normal' } },
      h('button', {
        type: 'button',
        'aria-expanded': expanded,
        onClick: () => setExpanded(value => !value),
        style: {
          font: 'inherit', color: 'inherit', cursor: 'pointer', border: '1px solid currentColor',
          borderRadius: '6px', padding: '3px 8px', background: 'transparent'
        }
      }, summary, h('span', { 'aria-hidden': true, style: { marginLeft: '6px' } }, expanded ? '▴' : '▾')),
      expanded ? h('span', {
        'data-dpa-message-raw': '',
        style: { display: 'block', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'text', marginTop: '6px' }
      }, raw) : null
    );
  };
}
