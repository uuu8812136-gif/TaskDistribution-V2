'use strict';

const BUSINESS_TIME_ZONE = 'Asia/Shanghai';
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInNaturalMonth(year, month) {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) return 0;
  if (!Number.isInteger(month) || month < 1 || month > 12) return 0;
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseNaturalMonth(value) {
  if (typeof value !== 'string') return null;
  const match = MONTH_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1900 || year > 9999 || month < 1 || month > 12) return null;
  return Object.freeze({ value, year, month });
}

function parseNaturalDate(value) {
  if (typeof value !== 'string') return null;
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const monthDays = daysInNaturalMonth(year, month);
  if (monthDays === 0 || day < 1 || day > monthDays) return null;
  return Object.freeze({ value, year, month, day });
}

function isNaturalMonth(value) {
  return parseNaturalMonth(value) !== null;
}

function isNaturalDate(value) {
  return parseNaturalDate(value) !== null;
}

function naturalMonthFromDate(value) {
  const parsed = parseNaturalDate(value);
  return parsed ? `${String(parsed.year).padStart(4, '0')}-${String(parsed.month).padStart(2, '0')}` : null;
}

function shiftNaturalMonth(value, delta) {
  const parsed = parseNaturalMonth(value);
  if (!parsed || !Number.isInteger(delta)) return null;
  const absoluteMonth = parsed.year * 12 + (parsed.month - 1) + delta;
  const year = Math.floor(absoluteMonth / 12);
  const month = absoluteMonth - year * 12 + 1;
  if (year < 1900 || year > 9999) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

function businessDateInShanghai(now = new Date()) {
  const instant = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(instant.getTime())) {
    throw new TypeError('now must be a valid instant');
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(instant);
  const partMap = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${partMap.year}-${partMap.month}-${partMap.day}`;
}

function businessMonthInShanghai(now = new Date()) {
  return naturalMonthFromDate(businessDateInShanghai(now));
}

function monthForDailySlot(slot, now = new Date()) {
  const currentMonth = businessMonthInShanghai(now);
  if (slot === 'current') return currentMonth;
  if (slot === 'previous') return shiftNaturalMonth(currentMonth, -1);
  return null;
}

function naturalDatesForMonth(value) {
  const parsed = parseNaturalMonth(value);
  if (!parsed) return null;
  const count = daysInNaturalMonth(parsed.year, parsed.month);
  return Array.from({ length: count }, (_, index) => (
    `${value}-${String(index + 1).padStart(2, '0')}`
  ));
}

function weekdayLabel(value) {
  const parsed = parseNaturalDate(value);
  if (!parsed) return null;
  const labels = ['日', '一', '二', '三', '四', '五', '六'];
  return labels[new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay()];
}

module.exports = {
  BUSINESS_TIME_ZONE,
  businessDateInShanghai,
  businessMonthInShanghai,
  daysInNaturalMonth,
  isLeapYear,
  isNaturalDate,
  isNaturalMonth,
  monthForDailySlot,
  naturalDatesForMonth,
  naturalMonthFromDate,
  parseNaturalDate,
  parseNaturalMonth,
  shiftNaturalMonth,
  weekdayLabel
};
