import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}



const safeId = value => word(value) && value.length <= 24 && !['constructor', 'prototype', '__proto__', 'unknown'].includes(value);
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const scalar = value => value === null || typeof value === 'boolean'
  || typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)
  || typeof value === 'string' && value.length <= 256 && value.isWellFormed();
export const POLICY = Object.freeze({ name: 'keyed-last-mutation-v1',
  bounds: '0..256 ordered events, 0..64 initial entries, at most 64 distinct keys in their union',
  order: 'event array order is authoritative; retain the final event for each key in its original relative order',
  values: 'null, boolean, safe integer without negative zero, or well-formed string up to 256 UTF-16 units',
  nulls: 'owner declares null stored as data or null deletes the key; initial snapshot nulls are always stored values',
  tombstones: 'retain final null events even if their key is absent initially',
  equivalence: 'compare final typed key/value state from the supplied initial snapshot; history and side effects are not preserved',
  execution: 'local JSON artifacts only; no broker, database or original-log changes' });
export const POLICY_HASH = hash(POLICY);
const promptFor = input => `${input.title}\n${input.context}\nFor log ${input.logId}, what does a null event value mean?\nNull is data: store a present key with null value.\nNull deletes: remove the key.\nChoose from source documentation, or Unknown. Initial snapshot nulls remain stored data. Event keys and values stay local.`;
export function validateInput(input) {
  if (!keys(input, ['logId', 'title', 'context', 'initial', 'events']) || !word(input.logId)
    || !line(input.title, 40) || !line(input.context, 80)
    || !Array.isArray(input.initial) || input.initial.length > 64
    || !Array.isArray(input.events) || input.events.length > 256) throw new Error('Supply log metadata, up to 64 initial entries and up to 256 ordered events.');
  const initialKeys = new Set(), eventIds = new Set(), allKeys = new Set();
  const initial = Array.from(input.initial, entry => {
    if (!keys(entry, ['key', 'value']) || !safeId(entry.key) || initialKeys.has(entry.key) || !scalar(entry.value)) throw new Error('Initial entries need distinct safe keys and supported scalar values.');
    initialKeys.add(entry.key); allKeys.add(entry.key); return { ...entry };
  }).sort((a, b) => order(a.key, b.key));
  const events = Array.from(input.events, event => {
    if (!keys(event, ['id', 'key', 'value']) || !safeId(event.id) || eventIds.has(event.id) || !safeId(event.key) || !scalar(event.value)) throw new Error('Events need unique safe IDs, safe keys and supported scalar values.');
    eventIds.add(event.id); allKeys.add(event.key); return { ...event };
  });
  if (allKeys.size > 64) throw new Error('Initial snapshot and events may use at most 64 distinct keys in total.');
  const result = { logId: input.logId, title: input.title, context: input.context, initial, events };
  if (promptFor(result).length > 500) throw new Error('Null-semantics Question exceeds 500 UTF-16 units.');
  return result;
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact log owner UUID and label.');
  return structuredClone(config);
}
export const itemsFor = rawInput => { validateInput(rawInput); return [{ id: 'nulls' }]; };
export function requestFor(rawInput, config, itemId, attemptId) {
  const input = validateInput(rawInput); validateConfig(config);
  if (itemId !== 'nulls' || !isId(attemptId)) throw new Error('Invalid null-semantics declaration or attempt.');
  const key = `compact-${attemptId}`;
  return { prompt: promptFor(input), context: `To ${config.participant.id}`,
    options: [{ value: 'data', label: 'Null is data', style: 'default' }, { value: 'delete', label: 'Null deletes', style: 'default' }, { value: 'unknown', label: 'Unknown', style: 'default' }],
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), initial_hash: hash(input.initial), policy_hash: POLICY_HASH, item_id: itemId, attempt_id: attemptId }, idempotencyKey: key };
}
export function previewInput(rawInput, config) {
  const input = validateInput(rawInput), request = requestFor(input, config, 'nulls', '01990000-0000-7000-8000-000000000001');
  const { correlation_id, idempotencyKey, data, ...question } = request;
  return { source: input, sourceHash: hash(input), policy: POLICY, policyHash: POLICY_HASH, question,
    note: 'The attempt UUID, correlation ID and input/initial/policy hashes are bound when a session creates its Question.' };
}
function replay(initial, events, nullPolicy) {
  const state = new Map(initial.map(entry => [entry.key, entry.value]));
  for (const event of events) {
    if (nullPolicy === 'delete' && event.value === null) state.delete(event.key);
    else state.set(event.key, event.value);
  }
  return [...state].map(([key, value]) => ({ key, value })).sort((a, b) => order(a.key, b.key));
}
/** Pure compaction. CLI export additionally requires attributed source-owner evidence. */
export function compactLog(rawInput, nullPolicy) {
  const input = validateInput(rawInput);
  if (!['data', 'delete'].includes(nullPolicy)) throw new Error('Declare null as data or deletion before compaction.');
  const last = new Map(); input.events.forEach((event, index) => last.set(event.key, index));
  const retainedIndices = [...last.values()].sort((a, b) => a - b);
  const compactedEvents = retainedIndices.map(index => ({ ...input.events[index] }));
  const originalState = replay(input.initial, input.events, nullPolicy), compactedState = replay(input.initial, compactedEvents, nullPolicy);
  if (JSON.stringify(originalState) !== JSON.stringify(compactedState)) throw new Error('Compacted replay differs from the original final state.');
  return { nullPolicy, inputEventCount: input.events.length, retainedEventCount: compactedEvents.length,
    removedEventCount: input.events.length - compactedEvents.length, retainedIndices, compactedEvents,
    finalState: compactedState, finalNullKeys: compactedState.filter(entry => entry.value === null).map(entry => entry.key),
    tombstoneKeys: nullPolicy === 'delete' ? compactedEvents.filter(event => event.value === null).map(event => event.key).sort(order) : [],
    initialStateHash: hash(input.initial), finalStateHash: hash(compactedState), sourceHash: hash(input), policyHash: POLICY_HASH,
    finalStateEquivalent: true, logChanged: false, brokerOrDatabaseWritten: false };
}
export function compactionPlan(rawInput, choice) {
  const input = validateInput(rawInput);
  if (![null, 'unknown', 'data', 'delete'].includes(choice)) throw new Error('Supply a known null policy, Unknown or a missing declaration.');
  return { status: choice === null ? 'incomplete' : choice === 'unknown' ? 'unknown' : 'complete', analysis: choice === null || choice === 'unknown' ? null : compactLog(input, choice) };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > itemsFor(input).length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed log metadata. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = itemsFor(input), ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved null-value declaration or order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last confirmation may have an active Question.');
  }
  return state;
}




export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const attempt = state.attempts[0], answer = attempt?.observation?.answer;
  const answers = [{ itemId: 'nulls', status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
    choice: answer?.value ?? null, label: answer?.label ?? null, questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
    responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null, askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null }];
  const calculation = compactionPlan(input, answers[0].choice);
  const status = ['create_unknown', 'pending'].includes(answers[0].status) ? answers[0].status : answers[0].status === 'unasked' ? 'ready' : calculation.status;
  return { version: 1, logId: input.logId, sourceHash: hash(input), source: input, policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, configHash: hash(state.config), answers, ...calculation, status };
}

export function handoff(report) {
  if (report.status !== 'complete' || report.analysis === null) throw new Error('A known null declaration is required before export.');
  return { version: 1, status: 'complete', logId: report.logId, sourceHash: report.sourceHash,
    policy: report.policy, policyHash: report.policyHash, participant: report.participant, room: report.room,
    configHash: report.configHash, answers: report.answers, analysis: report.analysis };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved null-value declaration evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered null-value declarations must not contain null-value declaration evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || (q.is_handoff !== undefined && q.is_handoff !== false)
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || (q.results !== undefined && q.results !== null) || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || Array.from(q.options).some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || (option?.primary !== undefined && option.primary !== false) || (option?.destructive !== undefined && option.destructive !== false))) throw new Error('Question does not match the saved configuration, room, or reviewer.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
