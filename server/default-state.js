'use strict';

const defaults = require('../dist/default-habits.js');
const HabitModel = require('../dist/habit-model.js');

function dateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function emptyState() {
  return { ...HabitModel.init([], dateKey()), startDateChosen: false };
}

function liaState() {
  return HabitModel.init(defaults, dateKey());
}

module.exports = { emptyState, liaState };
