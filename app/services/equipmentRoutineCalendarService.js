'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

function validDate(value, field = 'date') {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be a valid date`);
  return date;
}

function addUtcMonthsClamped(value, months) {
  const date = validDate(value);
  const originalDay = date.getUTCDate();
  const result = new Date(date.getTime());
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(
    result.getUTCFullYear(),
    result.getUTCMonth() + 1,
    0
  )).getUTCDate();
  result.setUTCDate(Math.min(originalDay, lastDay));
  return result;
}

function addCalendarInterval(value, unit, interval) {
  const date = validDate(value);
  if (!Number.isInteger(interval) || interval < 1) {
    throw new TypeError('interval must be a positive integer');
  }
  if (unit === 'DAY') return new Date(date.getTime() + interval * DAY_MS);
  if (unit === 'WEEK') return new Date(date.getTime() + interval * 7 * DAY_MS);
  if (unit === 'MONTH') return addUtcMonthsClamped(date, interval);
  throw new TypeError('Unsupported calendar unit');
}

function classifyCalendarDue({ now = new Date(), nextDueAt, unit, interval }) {
  const instant = validDate(now, 'now');
  const dueAt = validDate(nextDueAt, 'nextDueAt');
  if (instant < dueAt) return 'UPCOMING';
  return instant >= addCalendarInterval(dueAt, unit, interval) ? 'OVERDUE' : 'DUE';
}

function classifyRuntimeDue({ currentHours, nextDueHours, intervalHours }) {
  if (currentHours === null || currentHours === undefined) return 'WAITING_FOR_READING';
  if (currentHours < nextDueHours) return 'UPCOMING';
  return currentHours >= nextDueHours + intervalHours ? 'OVERDUE' : 'DUE';
}

function combineDueStates(calendarState, runtimeState, duePolicy) {
  const triggered = (state) => state === 'DUE' || state === 'OVERDUE';
  if (duePolicy === 'ANY') {
    if (calendarState === 'OVERDUE' || runtimeState === 'OVERDUE') return 'OVERDUE';
    if (triggered(calendarState) || triggered(runtimeState)) return 'DUE';
    if (calendarState === 'WAITING_FOR_READING' || runtimeState === 'WAITING_FOR_READING') {
      return 'WAITING_FOR_READING';
    }
    return 'UPCOMING';
  }
  if (duePolicy === 'ALL') {
    if (calendarState === 'WAITING_FOR_READING' || runtimeState === 'WAITING_FOR_READING') {
      return 'WAITING_FOR_READING';
    }
    if (!triggered(calendarState) || !triggered(runtimeState)) return 'UPCOMING';
    return calendarState === 'OVERDUE' || runtimeState === 'OVERDUE' ? 'OVERDUE' : 'DUE';
  }
  throw new TypeError('Unsupported combined due policy');
}

module.exports = {
  DAY_MS,
  addCalendarInterval,
  addUtcMonthsClamped,
  classifyCalendarDue,
  classifyRuntimeDue,
  combineDueStates,
  validDate
};
