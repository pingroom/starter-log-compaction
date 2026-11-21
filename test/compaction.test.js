import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactLog, compactionPlan, validateInput, previewInput, hash } from '../src/model.js';
import { step, exportCompacted } from '../src/engine.js';
import { mockApi, CONFIG, ROOM_CODE, id } from '../src/mock.js';
import { readJson } from '../src/storage.js';
const example = await readJson(new URL('../examples/log.json', import.meta.url), 65536);
const base = (events = [], initial = []) => ({ logId: 'oracle', title: 'Keyed changes', context: 'Declared source format', initial, events });
const compare = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
function independentReplay(initial, events, mode) {
  let rows = structuredClone(initial);
  for (const event of events) {
    rows = rows.filter(row => row.key !== event.key);
    if (event.value !== null || mode === 'data') rows.push({ key: event.key, value: event.value });
  }
  return rows.sort(compare);
}

test('null data and deletion remain distinct, including initial null and absent-key tombstones', () => {
  const input = base([{ id: 'e1', key: 'a', value: null }, { id: 'e2', key: 'b', value: null }], [{ key: 'a', value: 'old' }, { key: 'c', value: null }]);
  assert.deepEqual(compactLog(input, 'data').finalState, [{ key: 'a', value: null }, { key: 'b', value: null }, { key: 'c', value: null }]);
  const deleted = compactLog(input, 'delete');
  assert.deepEqual(deleted.finalState, [{ key: 'c', value: null }]);
  assert.deepEqual(deleted.tombstoneKeys, ['a', 'b']); assert.equal(deleted.compactedEvents.length, 2);
});

test('all short logs match an independent array replay over multiple initial states', () => {
  const alphabet = ['a', 'b'].flatMap(key => [null, 0, 'value'].map(value => ({ key, value })));
  const initials = [[], [{ key: 'a', value: false }], [{ key: 'b', value: null }], [{ key: 'a', value: 99 }, { key: 'b', value: true }, { key: 'c', value: 'untouched' }]];
  let cases = 0;
  function check(sequence) {
    const events = sequence.map((entry, index) => ({ id: `e${index}`, ...entry }));
    const expectedRetained = events.filter((event, index) => !events.slice(index + 1).some(later => later.key === event.key));
    for (const initial of initials) for (const mode of ['data', 'delete']) {
      const input = base(events, initial), result = compactLog(input, mode); cases++;
      assert.deepEqual(result.compactedEvents, expectedRetained);
      assert.deepEqual(result.finalState, independentReplay(initial, events, mode));
      assert.deepEqual(independentReplay(initial, result.compactedEvents, mode), result.finalState);
      const again = compactLog(base(result.compactedEvents, initial), mode);
      assert.deepEqual(again.compactedEvents, result.compactedEvents); assert.deepEqual(again.finalState, result.finalState);
      assert.equal(result.removedEventCount, events.length - expectedRetained.length);
      assert.equal(result.finalStateHash, hash(result.finalState));
    }
    if (sequence.length < 4) for (const event of alphabet) check([...sequence, event]);
  }
  check([]); assert.equal(cases, 12440);
});

test('retained records preserve original relative order and typed values without mutation', () => {
  const values = [false, true, 0, '0', '', '\n', '雪', Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, null];
  const events = values.map((value, i) => ({ id: `e${i}`, key: `k${i}`, value }));
  events.unshift({ id: 'old', key: 'k3', value: 'superseded' });
  const input = base(events), before = structuredClone(input), result = compactLog(input, 'data');
  assert.deepEqual(result.retainedIndices, Array.from({ length: 10 }, (_, i) => i + 1));
  assert.deepEqual(result.compactedEvents.map(event => event.value), values); assert.deepEqual(input, before);
  result.compactedEvents[0].value = 'changed'; assert.deepEqual(input, before);
});

test('empty log preserves initial snapshot and zero-event exports still require known semantics', () => {
  const input = base([], [{ key: 'z', value: null }, { key: 'a', value: 0 }]);
  for (const mode of ['data', 'delete']) {
    const result = compactLog(input, mode); assert.deepEqual(result.compactedEvents, []); assert.equal(result.removedEventCount, 0);
    assert.deepEqual(result.finalState, [{ key: 'a', value: 0 }, { key: 'z', value: null }]);
  }
  assert.equal(compactionPlan(input, 'unknown').analysis, null); assert.equal(compactionPlan(input, null).analysis, null);
  assert.throws(() => compactLog(input, 'unknown')); assert.throws(() => compactionPlan(input, 'skip'));
});

test('maximum bounded log keeps exactly the final mutation for each key', () => {
  const input = base(Array.from({ length: 256 }, (_, i) => ({ id: `e${i}`, key: `k${i % 64}`, value: i })));
  const result = compactLog(input, 'data'); assert.equal(result.retainedEventCount, 64); assert.equal(result.removedEventCount, 192);
  assert.deepEqual(result.retainedIndices, Array.from({ length: 64 }, (_, i) => i + 192));
  assert.deepEqual(result.finalState, independentReplay([], input.events, 'data'));
});

test('invalid scalar, sparse, duplicate and oversized inputs are rejected', () => {
  const mutations = [
    x => { x.events = new Array(1); }, x => { x.initial = new Array(1); },
    x => { x.events[0].value = -0; }, x => { x.events[0].value = 1.5; }, x => { x.events[0].value = Infinity; },
    x => { x.events[0].value = Number.MAX_SAFE_INTEGER + 1; }, x => { x.events[0].value = {}; }, x => { x.events[0].value = []; },
    x => { x.events[0].value = undefined; }, x => { x.events[0].value = '\ud800'; }, x => { x.events[0].value = 'a'.repeat(257); },
    x => { x.events.push({ ...x.events[0] }); }, x => { x.initial.push({ ...x.initial[0] }); },
    x => { x.events[0].key = '__proto__'; }, x => { x.events[0].id = 'event\n'; }, x => { x.events[0].extra = 1; },
    x => { x.events = Array.from({ length: 257 }, (_, i) => ({ id: `e${i}`, key: 'a', value: i })); },
    x => { x.initial = Array.from({ length: 65 }, (_, i) => ({ key: `k${i}`, value: null })); },
    x => { x.initial = Array.from({ length: 64 }, (_, i) => ({ key: `k${i}`, value: null })); },
  ];
  for (const mutate of mutations) { const input = structuredClone(example); mutate(input); assert.throws(() => validateInput(input)); }
});

test('initial entry order canonicalizes; event order remains significant', () => {
  const input = structuredClone(example), initialReversed = { ...input, initial: input.initial.toReversed() };
  assert.equal(hash(validateInput(input)), hash(validateInput(initialReversed)));
  assert.notEqual(hash(validateInput(input)), hash(validateInput({ ...input, events: input.events.toReversed() })));
});

test('Question transmits metadata and hashes while keeping keys and values local', () => {
  const input = structuredClone(example), preview = previewInput(input, CONFIG);
  assert(!JSON.stringify(preview.question).includes('Draft text')); assert(!JSON.stringify(preview.question).includes('removed'));
  assert.equal(preview.question.options.length, 3); assert(preview.question.prompt.length <= 500);
});

test('compact handoff excludes original and intermediate log values; report retains source privately', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'compaction-export-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now), input = structuredClone(example);
  const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
  await step(options); api.answer(id(1), 'delete'); const report = await step(options), result = await exportCompacted(directory, input);
  assert.equal(report.source.events[0].value, 'Draft text'); assert.equal(Object.hasOwn(result, 'source'), false);
  assert.equal(JSON.stringify(result).includes('Draft text'), false); assert.equal(JSON.stringify(result).includes('Old card'), false);
  assert.deepEqual(result.analysis.compactedEvents, report.analysis.compactedEvents);
  const again = await exportCompacted(directory, input); assert.deepEqual(again, result);
  assert.equal(api.calls.filter(call => call.method === 'POST').length, 1);
});
