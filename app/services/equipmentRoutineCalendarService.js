'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

function validDate(value, field = 'date') {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be a valid date`);
  return date;
}

function timeZoneParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, Number(value)])
  );
}

function zonedDate({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  let candidate = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rendered = timeZoneParts(new Date(candidate), timeZone);
    const renderedUtc = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
      rendered.second
    );
    const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const correction = desiredUtc - renderedUtc;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate);
}

function addLocalDays(parts, days) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
}

function weekdayFromParts(parts) {
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
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

function addCalendarInterval(value, unit, interval, timeZone = 'UTC') {
  const date = validDate(value);
  if (!Number.isInteger(interval) || interval < 1) {
    throw new TypeError('interval must be a positive integer');
  }
  const parts = timeZoneParts(date, timeZone);
  if (unit === 'DAY' || unit === 'WEEK') {
    return zonedDate({
      ...addLocalDays(parts, interval * (unit === 'WEEK' ? 7 : 1)),
      hour: parts.hour,
      minute: parts.minute,
      second: parts.second
    }, timeZone);
  }
  if (unit === 'MONTH') {
    const targetMonthIndex = parts.year * 12 + (parts.month - 1) + interval;
    const year = Math.floor(targetMonthIndex / 12);
    const month = targetMonthIndex - year * 12 + 1;
    return zonedDate({
      year,
      month,
      day: Math.min(parts.day, lastDayOfMonth(year, month)),
      hour: parts.hour,
      minute: parts.minute,
      second: parts.second
    }, timeZone);
  }
  throw new TypeError('Unsupported calendar unit');
}

function calendarAnchorsAround(firstDueAt, unit, interval, now, timeZone = 'UTC') {
  const first = validDate(firstDueAt, 'firstDueAt');
  const instant = validDate(now, 'now');
  if (!Number.isInteger(interval) || interval < 1) {
    throw new TypeError('interval must be a positive integer');
  }
  const anchorAt = (cycles) => cycles === 0
    ? new Date(first)
    : addCalendarInterval(first, unit, cycles * interval, timeZone);
  let cycles;
  if (unit === 'DAY' || unit === 'WEEK') {
    const firstParts = timeZoneParts(first, timeZone);
    const instantParts = timeZoneParts(instant, timeZone);
    const roughDays = Math.floor((
      Date.UTC(instantParts.year, instantParts.month - 1, instantParts.day) -
      Date.UTC(firstParts.year, firstParts.month - 1, firstParts.day)
    ) / DAY_MS);
    cycles = Math.max(0, Math.floor(
      roughDays / (interval * (unit === 'WEEK' ? 7 : 1))
    ));
  } else if (unit === 'MONTH') {
    const firstParts = timeZoneParts(first, timeZone);
    const instantParts = timeZoneParts(instant, timeZone);
    const roughMonths = (
      (instantParts.year - firstParts.year) * 12 +
      instantParts.month - firstParts.month
    );
    cycles = Math.max(0, Math.floor(roughMonths / interval));
  } else {
    throw new TypeError('Unsupported calendar unit');
  }
  let current = anchorAt(cycles);
  while (current > instant && cycles > 0) {
    cycles -= 1;
    current = anchorAt(cycles);
  }
  let next = anchorAt(cycles + 1);
  while (next <= instant) {
    cycles += 1;
    current = next;
    next = anchorAt(cycles + 1);
  }
  return { current, next };
}

function calendarAnchorAtOrBefore(firstDueAt, unit, interval, now, timeZone = 'UTC') {
  return calendarAnchorsAround(firstDueAt, unit, interval, now, timeZone).current;
}

function configuredAnchorParts(anchor, unit, config) {
  let parts = timeZoneParts(validDate(anchor), config.timeZone);
  if (unit === 'WEEK') {
    parts = {
      ...parts,
      ...addLocalDays(parts, config.weeklyDay - weekdayFromParts(parts))
    };
  }
  if (unit === 'MONTH') {
    parts.day = Math.min(config.monthlyDay, lastDayOfMonth(parts.year, parts.month));
  }
  return parts;
}

function windowBounds(anchor, unit, window, config) {
  const anchorParts = configuredAnchorParts(anchor, unit, config);
  const [startHour, startMinute] = window.startTime.split(':').map(Number);
  const [endHour, endMinute] = window.endTime.split(':').map(Number);
  const scheduledFor = zonedDate({
    ...anchorParts,
    hour: startHour,
    minute: startMinute,
    second: 0
  }, config.timeZone);
  let dueAt = zonedDate({
    ...anchorParts,
    hour: endHour,
    minute: endMinute,
    second: 0
  }, config.timeZone);
  if (dueAt <= scheduledFor) {
    dueAt = zonedDate({
      ...addLocalDays(anchorParts, 1),
      hour: endHour,
      minute: endMinute,
      second: 0
    }, config.timeZone);
  }
  return { scheduledFor, dueAt };
}

function statusAt({ scheduledFor, dueAt }, now) {
  const instant = validDate(now);
  if (instant < scheduledFor) return 'PLANNED';
  if (instant <= dueAt) return 'IN_WINDOW';
  return 'OVERDUE';
}

function classifyCalendarDue({ now = new Date(), nextDueAt, unit, interval, timeZone = 'UTC' }) {
  const instant = validDate(now, 'now');
  const dueAt = validDate(nextDueAt, 'nextDueAt');
  if (instant < dueAt) return 'UPCOMING';
  return instant >= addCalendarInterval(dueAt, unit, interval, timeZone) ? 'OVERDUE' : 'DUE';
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
  calendarAnchorAtOrBefore,
  calendarAnchorsAround,
  classifyCalendarDue,
  classifyRuntimeDue,
  combineDueStates,
  statusAt,
  timeZoneParts,
  validDate,
  windowBounds,
  zonedDate
};
