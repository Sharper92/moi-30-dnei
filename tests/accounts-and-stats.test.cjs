'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Model = require('../dist/habit-model.js');
const { emptyState, liaState } = require('../server/default-state.js');
global.HabitModel = Model;
const Stats = require('../dist/habit-stats.js');

const START = '2026-10-20';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

test('a new account starts with an empty valid tracker', () => {
  const state = Model.init([], START);
  assert.equal(state.version, 5);
  assert.equal(state.startDateChosen, true);
  assert.deepEqual(state.habits, []);
  assert.deepEqual(Model.sanitize(state, []), state);
});

test('start-date onboarding is explicit and legacy states keep their existing date', () => {
  const pending = { ...Model.init([], START), startDateChosen: false };
  assert.equal(Model.sanitize(pending, []).startDateChosen, false);

  const legacy = Model.init([], START);
  delete legacy.startDateChosen;
  assert.equal(Model.sanitize(legacy, []).startDateChosen, true);
  assert.equal(emptyState().startDateChosen, false);
  assert.equal(liaState().startDateChosen, true);
});

test('a new user can add the first custom habit', () => {
  const initial = Model.init([], START);
  const result = Model.addHabit(initial, {
    name: 'Читать 15 минут',
    icon: '📖',
    group: 'Дом и развитие',
    days: ALL_DAYS
  }, START);
  assert.equal(initial.habits.length, 0);
  assert.equal(result.state.habits.length, 1);
  assert.equal(result.habit.id, 0);
  assert.equal(result.habit.slot, 0);
  assert.equal(result.habit.startDate, START);
  assert.ok(Model.sanitize(result.state, []));
});

test('future marks do not affect counters, active days or XP until their date arrives', () => {
  let state = Model.addHabit(Model.init([], START), {
    name: 'Прогулка', icon: '🌳', group: 'Забота о себе', days: ALL_DAYS
  }, START).state;
  state.entries[START] = { statuses: { 0: 'small' }, gentle: false, mood: null, note: '' };
  state.entries['2026-10-21'] = { statuses: { 0: 'done' }, gentle: false, mood: null, note: '' };

  const onStart = Stats.all(state, START);
  assert.deepEqual(
    { full: onStart.full, small: onStart.small, active: onStart.active, xp: onStart.xp },
    { full: 0, small: 1, active: 1, xp: 3 }
  );

  const nextDay = Stats.all(state, '2026-10-21');
  assert.deepEqual(
    { full: nextDay.full, small: nextDay.small, active: nextDay.active, xp: nextDay.xp },
    { full: 1, small: 1, active: 2, xp: 13 }
  );
});
