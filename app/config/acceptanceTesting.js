'use strict';

const ACCEPTANCE_TEST_MODE_ENV = 'ACCEPTANCE_TEST_MODE';
const TIME_BYPASS_USERNAMES_ENV = 'ACCEPTANCE_TIME_BYPASS_USERNAMES';
const TIME_BYPASS_EXPIRES_AT_ENV = 'ACCEPTANCE_TIME_BYPASS_EXPIRES_AT';

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function acceptanceTestModeEnabled(env = process.env) {
  return String(env?.[ACCEPTANCE_TEST_MODE_ENV] || '').trim().toLowerCase() === 'true';
}

function timeBypassUsernames(env = process.env) {
  return new Set(String(env?.[TIME_BYPASS_USERNAMES_ENV] || '')
    .split(',')
    .map(normalizeUsername)
    .filter(Boolean));
}

function timeBypassExpiresAt(env = process.env) {
  const value = String(env?.[TIME_BYPASS_EXPIRES_AT_ENV] || '').trim();
  if (!value) return null;
  const expiresAt = new Date(value);
  return Number.isNaN(expiresAt.getTime()) ? null : expiresAt;
}

function isAcceptanceTimeRestrictionBypassed(
  authContext,
  env = process.env,
  now = new Date()
) {
  if (!acceptanceTestModeEnabled(env)) return false;
  const expiresAt = timeBypassExpiresAt(env);
  const instant = now instanceof Date ? now : new Date(now);
  if (!expiresAt || Number.isNaN(instant.getTime()) || instant.getTime() >= expiresAt.getTime()) {
    return false;
  }
  const username = normalizeUsername(authContext?.user?.username);
  return Boolean(username && timeBypassUsernames(env).has(username));
}

module.exports = {
  ACCEPTANCE_TEST_MODE_ENV,
  TIME_BYPASS_EXPIRES_AT_ENV,
  TIME_BYPASS_USERNAMES_ENV,
  acceptanceTestModeEnabled,
  isAcceptanceTimeRestrictionBypassed,
  normalizeUsername,
  timeBypassExpiresAt,
  timeBypassUsernames
};
