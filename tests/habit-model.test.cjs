'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Model = require('../dist/habit-model.js');

// Read only the two configuration declarations, never execute the app or access storage.
const appSource = fs.readFileSync(path.join(__dirname, '../dist/index.html'), 'utf8');
const defsDeclaration = appSource.match(/const defs\s*=\s*\[[\s\S]*?\];/);
const groupsDeclaration = appSource.match(/const groups\s*=\s*\[[^\]]*\];/);
assert.ok(defsDeclaration && groupsDeclaration, 'Application habit configuration is available');
const { defs, groups } = JSON.parse(JSON.stringify(vm.runInNewContext(
  defsDeclaration[0] + '\n' + groupsDeclaration[0] + '\n({defs, groups})',
  {},
  { timeout: 1000 }
)));

const START = '2026-10-01';
const TODAY = '2026-10-20';
const YESTERDAY = '2026-10-19';
const TOMORROW = '2026-10-21';
const FUTURE = '2026-10-25';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function entry(statuses, extras = {}) {
  return { statuses, gentle: false, mood: null, note: '', ...extras };
}

function legacyState() {
  return {
    version: 3,
    start: START,
    habits: defs.map(([icon, name, group], id) => ({
      id, icon, name, group, days: [...ALL_DAYS]
    })),
    entries: {
      [YESTERDAY]: entry({ 0: 'done', 2: 'small' }, {
        gentle: true, mood: 2, note: 'Важная заметка за прошлый день'
      }),
      [TODAY]: entry({ 1: 'done' }, { mood: 5, note: 'Сегодня всё получилось' })
    },
    reflections: { 0: 'Мне помогло расписание', 2: 'Возвращаться после перерыва' }
  };
}

function draft(name = 'Читать художественную книгу') {
  return { name, icon: '📖', group: 'Дом и развитие', days: [...ALL_DAYS] };
}

function versionsAt(state, slot, date) {
  return state.habits.filter(habit => habit.slot === slot && Model.isEffectiveOn(habit, date));
}

function xp(entries) {
  return Object.values(entries).reduce((sum, day) => sum +
    Object.values(day.statuses).reduce((points, status) =>
      points + (status === 'done' ? 10 : status === 'small' ? 3 : 0), 0), 0);
}

test('v3 migration preserves existing habits, every entry, mood, notes and reflections', () => {
  const legacy = legacyState();
  legacy.habits[2].name = 'Моя собственная тренировка';
  legacy.habits[2].days = [1, 3, 5];
  legacy.habits[5].days = [];
  const before = JSON.stringify(legacy);
  const migrated = Model.sanitize(legacy, defs, groups);

  assert.ok(migrated);
  assert.equal(migrated.version, 4);
  assert.equal(migrated.start, START);
  assert.equal(migrated.habits.length, 19);
  assert.deepEqual(migrated.entries, legacy.entries);
  assert.deepEqual(migrated.reflections, legacy.reflections);
  assert.equal(migrated.habits[2].name, legacy.habits[2].name);
  assert.deepEqual(migrated.habits[2].days, [1, 3, 5]);
  assert.deepEqual(migrated.habits[5].days, []);
  assert.deepEqual(migrated.habits.map(habit => habit.id), [...Array(19).keys()]);
  assert.deepEqual(migrated.habits.map(habit => habit.slot), [...Array(19).keys()]);
  for (const habit of migrated.habits) {
    assert.equal(habit.startDate, null);
    assert.equal(habit.endDate, null);
  }
  assert.equal(JSON.stringify(legacy), before, 'Migration does not modify the original backup');
});

test('replacement without a today mark starts today and has a separate identity and history', () => {
  const state = Model.sanitize(legacyState(), defs, groups);
  state.entries[FUTURE] = entry({ 0: 'done' });
  const before = JSON.stringify(state);
  const previous = state.habits.find(habit => habit.id === 0);
  const result = Model.replaceHabit(state, 0, draft(), TODAY);
  const retired = result.state.habits.find(habit => habit.id === 0);

  assert.equal(Model.replacementDate(state, 0, TODAY), TODAY);
  assert.equal(result.startDate, TODAY);
  assert.equal(result.habit.startDate, TODAY);
  assert.equal(result.habit.endDate, null);
  assert.ok(result.habit.id > Math.max(...state.habits.map(habit => habit.id)));
  assert.equal(result.habit.slot, previous.slot);
  assert.equal(retired.name, previous.name);
  assert.deepEqual(retired.days, previous.days);
  assert.equal(retired.endDate, TODAY);
  assert.deepEqual(versionsAt(result.state, previous.slot, YESTERDAY).map(habit => habit.id), [0]);
  assert.deepEqual(versionsAt(result.state, previous.slot, TODAY).map(habit => habit.id), [result.habit.id]);
  assert.deepEqual(result.state.entries, state.entries, 'Past and future marks remain on their old IDs');
  for (const day of Object.values(result.state.entries)) {
    assert.equal(day.statuses[result.habit.id], undefined, 'No completed status is inherited');
  }
  assert.equal(xp(result.state.entries), xp(state.entries), 'Replacement neither grants nor removes XP');
  assert.equal(Model.currentHabits(result.state).length, 19);
  assert.equal(JSON.stringify(state), before, 'The source state is unchanged');
});

for (const status of ['done', 'small']) {
  test(`a ${status} mark today keeps the old habit today and starts the replacement tomorrow`, () => {
    const state = Model.init(defs, START);
    state.entries[TODAY] = entry({ 0: status });
    const result = Model.replaceHabit(state, 0, draft(), TODAY);

    assert.equal(Model.replacementDate(state, 0, TODAY), TOMORROW);
    assert.equal(result.startDate, TOMORROW);
    assert.deepEqual(versionsAt(result.state, 0, TODAY).map(habit => habit.id), [0]);
    assert.deepEqual(versionsAt(result.state, 0, TOMORROW).map(habit => habit.id), [result.habit.id]);
    assert.equal(result.state.entries[TODAY].statuses[0], status);
    assert.equal(result.state.entries[TODAY].statuses[result.habit.id], undefined);
    assert.equal(xp(result.state.entries), xp(state.entries));
    assert.equal(Model.currentHabits(result.state).find(habit => habit.slot === 0).id, result.habit.id,
      'The settings list can show a scheduled replacement before it starts');
  });
}

test('a second pending replacement keeps its date and never adds an overlapping planned version', () => {
  const initial = Model.init(defs, START);
  initial.entries[TODAY] = entry({ 0: 'done' });
  const first = Model.replaceHabit(initial, 0, draft('Читать книгу'), TODAY);
  first.state.entries[FUTURE] = entry({ [first.habit.id]: 'small', 0: 'done' });
  const before = JSON.stringify(first.state);
  const second = Model.replaceHabit(first.state, first.habit.id, draft('Практиковать английский'), TODAY);
  const intermediate = second.state.habits.find(habit => habit.id === first.habit.id);

  assert.equal(second.startDate, TOMORROW);
  assert.equal(intermediate.startDate, TOMORROW);
  assert.equal(intermediate.endDate, TOMORROW);
  assert.equal(Model.isEffectiveOn(intermediate, TOMORROW), false);
  assert.ok(second.habit.id > first.habit.id);
  assert.deepEqual(versionsAt(second.state, 0, TODAY).map(habit => habit.id), [0]);
  assert.deepEqual(versionsAt(second.state, 0, TOMORROW).map(habit => habit.id), [second.habit.id]);
  assert.deepEqual(second.state.entries, first.state.entries);
  assert.equal(second.state.entries[FUTURE].statuses[second.habit.id], undefined);
  assert.equal(JSON.stringify(first.state), before);
  const restored = Model.sanitize(JSON.parse(JSON.stringify(second.state)), defs, groups);
  assert.ok(restored, 'A zero-length intermediate version survives reload');
  assert.deepEqual(restored.habits, second.state.habits);
  assert.deepEqual(restored.entries, second.state.entries);
});

test('v4 backup roundtrip preserves replacement IDs above 18, intervals and all historical marks', () => {
  const initial = Model.sanitize(legacyState(), defs, groups);
  const first = Model.replaceHabit(initial, 0, draft(), TODAY);
  first.state.entries[TODAY].statuses[first.habit.id] = 'small';
  const secondDraft = { name: 'Вечерняя прогулка', icon: '🌲', group: 'Забота о себе', days: [2, 4, 6] };
  const second = Model.replaceHabit(first.state, first.habit.id, secondDraft, TODAY);
  second.state.entries[FUTURE] = entry({ [second.habit.id]: 'done', 0: 'small' }, { note: 'Будущая запись' });
  const exported = JSON.parse(JSON.stringify({ ...second.state, exportedAt: '2026-10-20T12:00:00.000Z' }));
  const restored = Model.sanitize(exported, defs, groups);

  assert.ok(restored);
  assert.equal(restored.version, 4);
  assert.deepEqual(restored.habits, second.state.habits);
  assert.deepEqual(restored.entries, second.state.entries);
  assert.deepEqual(restored.reflections, second.state.reflections);
  assert.equal(restored.habits.find(habit => habit.id === second.habit.id).group, secondDraft.group);
  assert.equal(restored.habits.find(habit => habit.id === second.habit.id).icon, secondDraft.icon);
  assert.equal(restored.entries[FUTURE].statuses[second.habit.id], 'done');
  assert.equal(Model.currentHabits(restored).length, 19);
  assert.equal(xp(restored.entries), xp(second.state.entries));
});

test('repeated replacements use stable IDs rather than an array index and retain 19 settings slots', () => {
  let state = Model.init(defs, START);
  let currentId = 18;
  const seen = new Set(state.habits.map(habit => habit.id));
  for (let index = 0; index < 4; index++) {
    const result = Model.replaceHabit(state, currentId, draft('Новая привычка ' + index), TODAY);
    assert.equal(seen.has(result.habit.id), false);
    seen.add(result.habit.id);
    currentId = result.habit.id;
    state = result.state;
  }
  assert.equal(state.habits.length, 23);
  assert.deepEqual(Model.currentHabits(state).map(habit => habit.slot), [...Array(19).keys()]);
  assert.equal(Model.currentHabits(state).find(habit => habit.slot === 18).id, currentId);
  assert.deepEqual(versionsAt(state, 18, TODAY).map(habit => habit.id), [currentId]);
});

test('replacement date crosses the end of a month correctly', () => {
  const state = Model.init(defs, START);
  state.entries['2026-10-31'] = entry({ 0: 'done' });
  assert.equal(Model.replacementDate(state, 0, '2026-10-31'), '2026-11-01');
});

test('malformed backups return null or sanitized data without crashing', () => {
  const invalidStarts = ['2026-02-30', '2026-13-01', 'not-a-date', '2026-1-01'];
  for (const value of [null, undefined, 17, 'text', [], {}, { habits: {}, start: START }]) {
    assert.doesNotThrow(() => assert.equal(Model.sanitize(value, defs, groups), null));
  }
  for (const start of invalidStarts) {
    const state = legacyState();
    state.start = start;
    assert.equal(Model.sanitize(state, defs, groups), null, start + ' is not a valid calendar date');
  }
  for (const malformed of [null, [], 'text', { invalid: true }]) {
    const state = legacyState();
    state.entries[TODAY] = malformed;
    assert.doesNotThrow(() => Model.sanitize(state, defs, groups));
  }
});

test('import discards unknown IDs and invalid statuses without dropping known replacement history', () => {
  const changed = Model.replaceHabit(Model.init(defs, START), 0, draft(), TODAY);
  changed.state.entries[TODAY] = entry({ 0: 'small', [changed.habit.id]: 'done', 99999: 'done', 1: 'invalid' });
  const restored = Model.sanitize(changed.state, defs, groups);
  assert.ok(restored);
  assert.deepEqual(restored.entries[TODAY].statuses, { 0: 'small', [changed.habit.id]: 'done' });
});

test('invalid replacements fail without changing history or settings', () => {
  const state = Model.sanitize(legacyState(), defs, groups);
  const before = JSON.stringify(state);
  const badDrafts = [
    { ...draft(), name: '' },
    { ...draft(), name: '   ' },
    { ...draft(), name: 'я'.repeat(131) },
    { ...draft(), group: 'Неизвестная категория' },
    { ...draft(), days: [] },
    { ...draft(), days: [7] },
    { ...draft(), days: ['1'] },
    null
  ];
  for (const replacement of badDrafts) {
    assert.throws(() => Model.replaceHabit(state, 0, replacement, TODAY));
    assert.equal(JSON.stringify(state), before);
  }
  assert.throws(() => Model.replaceHabit(state, 99999, draft(), TODAY));
  assert.throws(() => Model.replaceHabit(state, 0, draft(), '2026-02-30'));
  const replacement = Model.replaceHabit(state, 0, draft(), TODAY);
  const replacedBefore = JSON.stringify(replacement.state);
  assert.throws(() => Model.replaceHabit(replacement.state, 0, draft(), TODAY), 'An archived version cannot be replaced again');
  assert.equal(JSON.stringify(replacement.state), replacedBefore);
});
