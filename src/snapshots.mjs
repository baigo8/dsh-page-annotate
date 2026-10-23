import { normalizeAnnotations } from './core.mjs';

function failure(code, message, annotationId) {
  return Object.assign(new Error(message), { code, annotationId });
}

/**
 * In-memory, per-note screenshot ledger. Never persist images in restored notes.
 *
 * update() starts capture synchronously when idle, and never throws/rejects:
 * await it for { errors: [{ annotationId, error }] }. An unchanged failed note
 * is retried by the next update. The UI can display `pending` while work runs.
 *
 * Captures queued behind another render cannot represent the earlier DOM. They
 * are explicitly marked send-time (with a warning), not historical evidence.
 * collect() retries missing/failed images using the current viewport, also
 * marked send-time. A failed retry or quota violation rejects the whole send;
 * callers must keep the notes and let the user retry or uncheck screenshots.
 *
 * scope/note/capturedNumbers belong to the ledger envelope ONLY, never to the
 * ImageBlock. capturedNumbers preserves each note's number when its capture
 * task was created; deleting/reordering notes never relabels historical pixels.
 * maxBytes counts base64 characters (the ASCII payload's storage bytes), not
 * decoded PNG bytes. Limits apply before send-time deduplication.
 */
export function createAnnotationSnapshots({ capture, maxImages = 12, maxBytes = 20 * 1024 * 1024 } = {}) {
  if (typeof capture !== 'function') throw new TypeError('capture 必须是函数');
  if (![maxImages, maxBytes].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new TypeError('截图数量和 base64 预算必须为非负安全整数');
  }
  const records = new Map();
  const queue = [];
  let active;
  let revision = 0;

  function notesOf(annotations) {
    const seen = new Set();
    return normalizeAnnotations(annotations).map((note, index) => {
      const { id, ...content } = note;
      return { id, number: index + 1, signature: JSON.stringify(content) };
    }).filter(note => {
      if (!note.id || seen.has(note.id)) return false;
      seen.add(note.id);
      return true;
    });
  }

  const current = record => records.get(record.id) === record;
  function prune(notes) {
    const ids = new Set(notes.map(note => note.id));
    for (const id of records.keys()) if (!ids.has(id)) records.delete(id);
    // Retire queued work now; the active render still owns the capture lock.
    for (let index = queue.length - 1; index >= 0; index--) {
      if (!current(queue[index])) {
        queue.splice(index, 1)[0].resolve();
      }
    }
  }

  function validateImage(raw, id) {
    if (raw?.type !== 'image' || typeof raw.mediaType !== 'string' || !raw.mediaType.startsWith('image/') ||
        typeof raw.data !== 'string' || raw.data.length === 0) {
      throw failure('SNAPSHOT_INVALID', '截图未返回有效 ImageBlock，请重试或取消截图', id);
    }
    // Whitelist protocol fields: provenance metadata is never sent as image fields.
    return { type: 'image', mediaType: raw.mediaType, data: raw.data,
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}) };
  }

  function retain(record, raw) {
    if (!current(record)) return;
    const image = validateImage(raw, record.id);
    let count = 1, bytes = image.data.length;
    for (const other of records.values()) {
      if (other !== record && other.image) { count++; bytes += other.image.data.length; }
    }
    if (count > maxImages || bytes > maxBytes) {
      throw failure('SNAPSHOT_LIMIT', `截图超过 ${maxImages} 张或 base64 ${maxBytes} 字节预算；请删除部分批注、重试或取消截图后发送文字`, record.id);
    }
    record.image = image;
    record.error = undefined;
  }

  function pump() {
    if (active || queue.length === 0) return;
    const record = queue.shift();
    if (!current(record)) { record.resolve(); pump(); return; }
    active = record;
    // Deliberately call now, not in a Promise.then: capture clones the current
    // DOM before its first await, as close to the save event as possible.
    let work;
    try { work = capture(record.frame, { annotationIds: [record.id] }); } catch (error) { work = Promise.reject(error); }
    Promise.resolve(work).then(raw => retain(record, raw)).catch(error => {
      if (current(record)) record.error = error instanceof Error ? error : new Error(String(error));
    }).finally(() => {
      record.frame = undefined;
      record.settled = true;
      active = undefined;
      record.resolve();
      pump();
    });
  }

  function schedule(note, frame, sendTime = false) {
    const delayed = Boolean(active || queue.length);
    const record = { ...note, frame, settled: false,
      scope: sendTime || delayed ? 'send-time' : 'saved',
      note: sendTime ? '发送时补拍的当前视口，并非批注保存时的历史截图。'
        : delayed ? '截图排队后捕获的当前视口，并非批注保存瞬间的历史截图。'
          : '批注保存时捕获的视口。' };
    record.promise = new Promise(resolve => { record.resolve = resolve; });
    records.set(record.id, record);
    queue.push(record);
    pump();
    return record;
  }

  function update(annotations, frame) {
    try {
      const notes = notesOf(annotations);
      revision++;
      prune(notes);
      const selected = notes.map(note => {
        const old = records.get(note.id);
        return !old || old.signature !== note.signature || old.error
          ? schedule(note, frame) : old;
      });
      return Promise.all(selected.map(record => record.promise)).then(() => ({
        errors: selected.filter(record => current(record) && record.error)
          .map(record => ({ annotationId: record.id, error: record.error }))
      }));
    } catch (error) {
      return Promise.resolve({ errors: [{ annotationId: undefined, error }] });
    }
  }

  async function collect(annotations, frame) {
    const notes = notesOf(annotations);
    prune(notes);
    const startedAt = revision;
    // First wait for saves; don't retry a pending render concurrently.
    await Promise.all(notes.map(note => records.get(note.id)?.promise));
    if (revision !== startedAt) throw failure('SNAPSHOT_CHANGED', '批注在截图期间发生变化，请重新发送');
    const selected = notes.map(note => {
      const old = records.get(note.id);
      return !old || old.signature !== note.signature || old.error || !old.image
        ? schedule(note, frame, true) : old;
    });
    await Promise.all(selected.map(record => record.promise));
    const images = [], associations = [], byData = new Map();
    for (const record of selected) {
      if (!current(record)) throw failure('SNAPSHOT_CHANGED', '批注在截图期间发生变化，请重新发送', record.id);
      if (record.error) throw record.error;
      if (!record.image) throw failure('SNAPSHOT_MISSING', '批注缺少截图，请重试或取消截图', record.id);
      let entry = byData.get(record.image.data);
      if (!entry) {
        entry = { id: `S${images.length + 1}`, image: { ...record.image }, annotationIds: [], capturedNumbers: [],
          scope: record.scope, note: record.note };
        images.push(entry);
        byData.set(record.image.data, entry);
      } else if (record.scope === 'send-time') {
        // If identical bytes include a nonhistorical capture, don't promote
        // the combined image to historical evidence for all associated notes.
        entry.scope = 'send-time';
        entry.note = record.note;
      }
      entry.annotationIds.push(record.id);
      entry.capturedNumbers.push({ annotationId: record.id, number: record.number });
      associations.push({ annotationId: record.id, imageId: entry.id });
    }
    return { images, associations };
  }

  function clear() {
    revision++;
    records.clear();
    for (const record of queue.splice(0)) record.resolve();
    // Active work is not cancellable; object identity prevents a late write,
    // and the lock remains held until capture settles, even after clear().
  }

  return { update, collect, clear,
    get pending() { return (active ? 1 : 0) + queue.length; } };
}
