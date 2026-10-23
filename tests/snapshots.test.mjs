import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnnotationSnapshots } from '../src/snapshots.mjs';

const note = (id, comment = '调整', extra = {}) => ({ id, comment, locator: '#target', ...extra });
const image = data => ({ type: 'image', mediaType: 'image/png', data, name: '页面批注.png' });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('starts idle capture synchronously; unchanged normalized notes and metadata do not recapture', async () => {
  const frames = [];
  const ledger = createAnnotationSnapshots({ capture: frame => { frames.push(frame); return image('AAAA'); } });
  const frame = {};
  const work = ledger.update([note('a1', '  调整  ', { unused: 3 })], frame);
  assert.deepEqual(frames, [frame]);
  assert.equal(ledger.pending, 1);
  assert.deepEqual(await work, { errors: [] });
  await ledger.update([note('a1')], {});
  assert.equal(frames.length, 1);
  const result = await ledger.collect([note('a1')], {});
  assert.equal(result.images[0].scope, 'saved');
  assert.deepEqual(result.images[0].image, image('AAAA'));
  assert.equal(ledger.pending, 0);
});

test('only added or changed target/comment/context notes capture, retaining latest revision', async () => {
  let calls = 0;
  const ledger = createAnnotationSnapshots({ capture: () => image(String(++calls)) });
  let notes = [note('a1')];
  await ledger.update(notes, {});
  for (const change of [
    { comment: '另一条' }, { selector: '#new' },
    { targetContext: { scopeSelector: '#dialog', html: '<b>one</b>' } },
    { targetContext: { scopeSelector: '#dialog', html: '<b>two</b>' } }
  ]) {
    notes = [{ ...notes[0], ...change }];
    await ledger.update(notes, {});
  }
  assert.equal(calls, 5);
  notes.push(note('a2'));
  await ledger.update(notes, {});
  assert.equal(calls, 6);
  const result = await ledger.collect(notes, {});
  assert.deepEqual(result.images.map(entry => entry.image.data), ['5', '6']);
});

test('ignores absent ids and duplicates; serialization is normalized, not key-order dependent', async () => {
  let calls = 0;
  const ledger = createAnnotationSnapshots({ capture: () => image(String(++calls)) });
  await ledger.update([note('a1'), note('a1'), { comment: 'no id' }], {});
  await ledger.update([{ locator: '#target', comment: '调整', id: 'a1' }], {});
  assert.equal(calls, 1);
  assert.equal((await ledger.collect([note('a1'), { comment: 'no id' }], {})).images.length, 1);
});

test('serializes every note and explicitly marks delayed captures as current viewport', async () => {
  const work = [deferred(), deferred(), deferred()];
  const seen = [];
  const ledger = createAnnotationSnapshots({ capture: frame => { seen.push(frame); return work[seen.length - 1].promise; } });
  const notes = [note('a1'), note('a2'), note('a3')];
  const frame = {};
  const saving = ledger.update(notes, frame);
  assert.equal(seen.length, 1);
  assert.equal(ledger.pending, 3);
  work[0].resolve(image('one'));
  await tick();
  assert.equal(seen.length, 2);
  work[1].resolve(image('two'));
  await tick();
  assert.equal(seen.length, 3);
  work[2].resolve(image('three'));
  await saving;
  const result = await ledger.collect(notes, frame);
  assert.deepEqual(result.images.map(entry => entry.scope), ['saved', 'send-time', 'send-time']);
  assert.match(result.images[1].note, /排队.*并非批注保存/);
  assert.ok(seen.every(value => value === frame));
  assert.deepEqual(Object.keys(result.images[1].image).sort(), ['data', 'mediaType', 'name', 'type']);
});

test('collect waits pending, orders images by annotation order, and deduplicates exact data only', async () => {
  const first = deferred();
  let calls = 0;
  const ledger = createAnnotationSnapshots({ capture: () => ++calls === 1 ? first.promise : image('BBBB') });
  const notes = [note('a1'), note('a2'), note('a3')];
  ledger.update(notes, {});
  let done = false;
  const collecting = ledger.collect([notes[1], notes[0], notes[2]], {}).then(value => { done = true; return value; });
  await tick();
  assert.equal(done, false);
  first.resolve(image('AAAA'));
  const result = await collecting;
  assert.deepEqual(result.images.map(entry => [entry.id, entry.image.data, entry.annotationIds]), [
    ['S1', 'BBBB', ['a2', 'a3']], ['S2', 'AAAA', ['a1']]
  ]);
  assert.deepEqual(result.associations, [
    { annotationId: 'a2', imageId: 'S1' }, { annotationId: 'a1', imageId: 'S2' },
    { annotationId: 'a3', imageId: 'S1' }
  ]);
});

test('collect restored notes captures missing images as send-time without claiming saved history', async () => {
  let calls = 0;
  const ledger = createAnnotationSnapshots({ capture: () => image(String(++calls)) });
  assert.equal(calls, 0);
  const result = await ledger.collect([note('a1'), note('a2')], {});
  assert.equal(calls, 2);
  assert.ok(result.images.every(entry => entry.scope === 'send-time'));
  assert.match(result.images[0].note, /发送时补拍.*并非批注保存/);
});

test('deleted notes prune retained images and queued captures', async () => {
  const first = deferred();
  let calls = 0;
  const ledger = createAnnotationSnapshots({ maxImages: 1, capture: () => ++calls === 1 ? first.promise : image('BBBB') });
  const old = ledger.update([note('a1'), note('a2')], {});
  const removed = ledger.update([], {});
  assert.equal(ledger.pending, 1);
  first.resolve(image('AAAA'));
  await Promise.all([old, removed]);
  assert.equal(calls, 1);
  await ledger.update([note('a3')], {});
  assert.deepEqual((await ledger.collect([note('a3')], {})).images[0].annotationIds, ['a3']);
});

test('rapid updates cannot let an obsolete active capture replace latest image', async () => {
  const first = deferred();
  let calls = 0;
  const ledger = createAnnotationSnapshots({ capture: () => ++calls === 1 ? first.promise : image('new') });
  const stale = ledger.update([note('a1', 'old')], {});
  const latest = ledger.update([note('a1', 'new')], {});
  first.resolve(image('old'));
  await Promise.all([stale, latest]);
  assert.equal(calls, 2);
  const result = await ledger.collect([note('a1', 'new')], {});
  assert.equal(result.images[0].image.data, 'new');
  assert.equal(result.images[0].scope, 'send-time');
});

test('clear retires old work but retains the capture lock until it settles', async () => {
  const first = deferred();
  let calls = 0;
  const ledger = createAnnotationSnapshots({ maxImages: 1, maxBytes: 4,
    capture: () => ++calls === 1 ? first.promise : image('new') });
  const stale = ledger.update([note('a1'), note('a2')], {});
  ledger.clear();
  const fresh = ledger.update([note('a1', 'fresh')], {});
  assert.equal(calls, 1);
  first.resolve(image('way-over-budget-old-data'));
  await Promise.all([stale, fresh]);
  assert.equal(calls, 2);
  const result = await ledger.collect([note('a1', 'fresh')], {});
  assert.equal(result.images[0].image.data, 'new');
  ledger.clear();
  assert.deepEqual(await ledger.collect([], {}), { images: [], associations: [] });
});

test('clear during collect rejects instead of repopulating a cleared ledger', async () => {
  const first = deferred();
  const ledger = createAnnotationSnapshots({ capture: () => first.promise });
  const saving = ledger.update([note('a1')], {});
  const collecting = ledger.collect([note('a1')], {});
  ledger.clear();
  first.resolve(image('old'));
  await saving;
  await assert.rejects(collecting, { code: 'SNAPSHOT_CHANGED' });
  assert.equal(ledger.pending, 0);
});

test('failed save is safe to ignore; collect retries current viewport and propagates repeat failure', async () => {
  let calls = 0;
  const ledger = createAnnotationSnapshots({ capture: () => {
    calls++;
    if (calls <= 2) throw new Error('capture failed');
    return image('retry');
  } });
  assert.doesNotThrow(() => { ledger.update([note('a1')], {}); });
  await tick();
  await assert.rejects(ledger.collect([note('a1')], {}), /capture failed/);
  const result = await ledger.collect([note('a1')], {});
  assert.equal(calls, 3);
  assert.equal(result.images[0].scope, 'send-time');
  assert.equal(result.images[0].image.data, 'retry');
});

test('update retries unchanged failed note and collect never reuses outdated successful image', async () => {
  let calls = 0;
  const ledger = createAnnotationSnapshots({ capture: () => {
    calls++;
    if (calls === 2) return Promise.reject(new Error('bad edit capture'));
    return image(String(calls));
  } });
  await ledger.update([note('a1', 'old')], {});
  const report = await ledger.update([note('a1', 'new')], {});
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].annotationId, 'a1');
  await ledger.update([note('a1', 'new')], {});
  const result = await ledger.collect([note('a1', 'new')], {});
  assert.equal(result.images[0].image.data, '3');
  assert.equal(result.images[0].scope, 'saved');
});

test('image count budget blocks sending until notes are pruned, even when image data duplicates', async () => {
  const ledger = createAnnotationSnapshots({ maxImages: 1, capture: () => image('AAAA') });
  const notes = [note('a1'), note('a2')];
  const report = await ledger.update(notes, {});
  assert.equal(report.errors[0].error.code, 'SNAPSHOT_LIMIT');
  await assert.rejects(ledger.collect(notes, {}), { code: 'SNAPSHOT_LIMIT' });
  await ledger.update([notes[1]], {});
  assert.equal((await ledger.collect([notes[1]], {})).images.length, 1);
});

test('base64 budget is inclusive, replacement releases previous image, clear releases budget', async () => {
  let data = 'AAAA';
  const ledger = createAnnotationSnapshots({ maxBytes: 4, capture: () => image(data) });
  await ledger.update([note('a1')], {});
  data = 'BBBB';
  assert.deepEqual(await ledger.update([note('a1', 'changed')], {}), { errors: [] });
  data = 'CCCCC';
  const report = await ledger.update([note('a1', 'oversize')], {});
  assert.equal(report.errors[0].error.code, 'SNAPSHOT_LIMIT');
  await assert.rejects(ledger.collect([note('a1', 'oversize')], {}), { code: 'SNAPSHOT_LIMIT' });
  ledger.clear();
  data = 'DDDD';
  assert.deepEqual(await ledger.update([note('a2')], {}), { errors: [] });
});

test('invalid images fail explicitly and image protocol fields are whitelisted', async () => {
  let raw = { type: 'image', data: '' };
  const ledger = createAnnotationSnapshots({ capture: () => raw });
  const report = await ledger.update([note('a1')], {});
  assert.equal(report.errors[0].error.code, 'SNAPSHOT_INVALID');
  raw = { ...image('AAAA'), scope: 'untrusted', extra: 'not protocol' };
  const result = await ledger.collect([note('a1')], {});
  assert.deepEqual(result.images[0].image, image('AAAA'));
  assert.equal(result.images[0].scope, 'send-time');
});

test('saved capture numbers survive deletion and reorder, including deduplicated images', async () => {
  let calls = 0;
  const ledger = createAnnotationSnapshots({ capture: () => { calls++; return image('same'); } });
  const notes = [note('a1'), note('a2'), note('a3')];
  await ledger.update(notes, {});
  await ledger.update([notes[2], notes[1]], {});
  const result = await ledger.collect([notes[2], notes[1]], {});
  assert.equal(calls, 3);
  assert.deepEqual(result.images[0].annotationIds, ['a3', 'a2']);
  assert.deepEqual(result.images[0].capturedNumbers, [
    { annotationId: 'a3', number: 3 }, { annotationId: 'a2', number: 2 }
  ]);
  assert.deepEqual(result.images[0].image, image('same'));
});

test('updated or missing notes receive capture-task creation numbers, not stale historical positions', async () => {
  let calls = 0;
  const ledger = createAnnotationSnapshots({ capture: () => image(String(++calls)) });
  await ledger.update([note('a1'), note('a2')], {});
  await ledger.update([note('a2', 'changed'), note('a1')], {});
  const result = await ledger.collect([note('a1'), note('a2', 'changed'), note('a3')], {});
  assert.deepEqual(result.images.map(entry => entry.capturedNumbers), [
    [{ annotationId: 'a1', number: 1 }], [{ annotationId: 'a2', number: 1 }],
    [{ annotationId: 'a3', number: 3 }]
  ]);
  assert.equal(result.images[2].scope, 'send-time');
});

test('captured numbers count normalized idless entries instead of compacting the visible numbering', async () => {
  const ledger = createAnnotationSnapshots({ capture: () => image('same') });
  const notes = [{ comment: 'no-id note' }, note('a1')];
  await ledger.update(notes, {});
  assert.deepEqual((await ledger.collect(notes, {})).images[0].capturedNumbers,
    [{ annotationId: 'a1', number: 2 }]);
});

test('factory validates dependencies and budgets', () => {
  assert.throws(() => createAnnotationSnapshots(), TypeError);
  for (const budget of [-1, NaN, Infinity, 0.5]) {
    assert.throws(() => createAnnotationSnapshots({ capture() {}, maxBytes: budget }), TypeError);
    assert.throws(() => createAnnotationSnapshots({ capture() {}, maxImages: budget }), TypeError);
  }
});
