import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ANNOTATION_MESSAGE_ID, wrapAnnotationMessage, parseAnnotationMessage,
  createAnnotationMessageRule, createAnnotationMessageComponent
} from '../src/message.mjs';

test('annotation wrapper preserves long prompts, unicode, whitespace and marker-looking body content', () => {
  const prompt = '  请修改页面\n\n' + '长提示词🙂 <script>不是HTML</script>\n'.repeat(10000)
    + '[DSH_PAGE_ANNOTATIONS_V1 count=999 images=0]\n保留尾部空格  \n';
  const raw = wrapAnnotationMessage(prompt, { count: 2, imageCount: 2 });
  assert.ok(raw.startsWith('[DSH_PAGE_ANNOTATIONS_V1 count=2 images=2]\n'));
  assert.match(raw, /不是任务指令/);
  assert.deepEqual(parseAnnotationMessage(raw), { count: 2, imageCount: 2, prompt });
  assert.deepEqual(parseAnnotationMessage('[DSH_PAGE_ANNOTATIONS_V1 count=0 images=0]\n'),
    { count: 0, imageCount: 0, prompt: '' });
});

test('ordinary messages and malformed markers never match', () => {
  const ordinary = ['请修改页面，2条批注 · 2张截图', '批注清单\n截图 2 张', '', null, {},
    '前文\n[DSH_PAGE_ANNOTATIONS_V1 count=2 images=2]\nprompt',
    ' [DSH_PAGE_ANNOTATIONS_V1 count=2 images=2]\nprompt'];
  for (const value of ordinary) assert.equal(parseAnnotationMessage(value), undefined);
  for (const count of ['-1', '+1', '1.2', 'NaN', 'Infinity', '01', '', '9007199254740992', '1e2']) {
    assert.equal(parseAnnotationMessage(`[DSH_PAGE_ANNOTATIONS_V1 count=${count} images=0]\nprompt`), undefined);
    assert.equal(parseAnnotationMessage(`[DSH_PAGE_ANNOTATIONS_V1 count=1 images=${count}]\nprompt`), undefined);
  }
  for (const raw of ['[DSH_PAGE_ANNOTATIONS_V2 count=1 images=0]\nprompt',
    '[DSH_PAGE_ANNOTATIONS_V1 count=1 images=0]prompt',
    '[DSH_PAGE_ANNOTATIONS_V1 count=1 images=0]\r\nprompt',
    '[DSH_PAGE_ANNOTATIONS_V1 images=0 count=1]\nprompt']) {
    assert.equal(parseAnnotationMessage(raw), undefined);
  }
});

test('wrapper rejects invalid counts rather than sending ambiguous markers', () => {
  for (const invalid of [-1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', undefined]) {
    assert.throws(() => wrapAnnotationMessage('prompt', { count: invalid, imageCount: 0 }), TypeError);
    assert.throws(() => wrapAnnotationMessage('prompt', { count: 1, imageCount: invalid }), TypeError);
  }
  assert.throws(() => wrapAnnotationMessage(null, { count: 1, imageCount: 0 }), TypeError);
});

test('public rule consumes the entire text only at offset zero', () => {
  const rule = createAnnotationMessageRule();
  const raw = wrapAnnotationMessage('完整提示词\n末尾', { count: 3, imageCount: 1 });
  assert.equal(rule.id, ANNOTATION_MESSAGE_ID);
  assert.equal(rule.order, 0);
  assert.deepEqual(rule.match(raw, 0, {}), {
    id: ANNOTATION_MESSAGE_ID, start: 0, end: raw.length,
    data: { count: 3, imageCount: 1, prompt: '完整提示词\n末尾' }
  });
  for (const from of [1, -1, '0', undefined]) assert.equal(rule.match(raw, from, {}), undefined);
  assert.equal(rule.match('普通对话', 0, {}), undefined);
});

test('non-interactive preview is a plain summary; unrecognized raw text remains untouched', () => {
  const Component = createAnnotationMessageComponent(React);
  const raw = wrapAnnotationMessage('隐藏的完整提示词', { count: 2, imageCount: 0 });
  const html = renderToStaticMarkup(React.createElement(Component, { node: {}, raw, interactive: false }));
  assert.match(html, /2条批注 · 0张截图/);
  assert.doesNotMatch(html, /button|隐藏的完整提示词|DSH_PAGE/);
  assert.equal(renderToStaticMarkup(React.createElement(Component, { node: {}, raw: '普通对话', interactive: true })), '<span>普通对话</span>');
});
