"use strict";

const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;

let customNowGetter = null;

function setNowGetter(fn) {
  customNowGetter = typeof fn === "function" ? fn : null;
}

function resetNowGetter() {
  customNowGetter = null;
}

function getNowDate() {
  if (customNowGetter) {
    const val = customNowGetter();
    return val instanceof Date ? val : new Date(val);
  }
  return new Date();
}

function getNowTimestamp() {
  return getNowDate().getTime();
}

function getNowIso() {
  return getNowDate().toISOString();
}

function toShanghaiDate(dateOrTimestamp) {
  const ts = typeof dateOrTimestamp === "number"
    ? dateOrTimestamp
    : new Date(dateOrTimestamp).getTime();
  return new Date(ts + SHANGHAI_OFFSET_MS);
}

function formatShanghaiDate(dateOrTimestamp) {
  if (!dateOrTimestamp) return "—";
  const d = toShanghaiDate(dateOrTimestamp);
  const pad = (n) => String(n).padStart(2, "0");
  const year = d.getUTCFullYear();
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hours = pad(d.getUTCHours());
  const minutes = pad(d.getUTCMinutes());
  return `${year}.${month}.${day} ${hours}:${minutes}`;
}

function addCalendarMonths(startMs, months, anchorDay = null) {
  const d = toShanghaiDate(startMs);
  const startYear = d.getUTCFullYear();
  const startMonth = d.getUTCMonth();
  const originalAnchor = anchorDay || d.getUTCDate();
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const seconds = d.getUTCSeconds();
  const ms = d.getUTCMilliseconds();

  const targetMonthIndex = startMonth + months;
  const targetYear = startYear + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;

  const daysInTargetMonth = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(originalAnchor, daysInTargetMonth);

  const targetUtcMs = Date.UTC(targetYear, normalizedMonth, clampedDay, hours, minutes, seconds, ms);
  return targetUtcMs - SHANGHAI_OFFSET_MS;
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

module.exports = {
  SHANGHAI_OFFSET_MS,
  setNowGetter,
  resetNowGetter,
  getNowDate,
  getNowTimestamp,
  getNowIso,
  toShanghaiDate,
  formatShanghaiDate,
  addCalendarMonths,
  isLeapYear,
};
