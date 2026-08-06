'use strict';

const BASELINE_CUMULATIVE_MONTH = 6;

function productionCumulativeEndMonth(reportMonth) {
  const month = Number(reportMonth);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new TypeError('reportMonth must be an integer from 1 to 12');
  }
  return Math.max(BASELINE_CUMULATIVE_MONTH, month - 1);
}

function productionCumulativeMonths(year, reportMonth) {
  const numericYear = Number(year);
  if (!Number.isInteger(numericYear)) {
    throw new TypeError('year must be an integer');
  }
  const endMonth = productionCumulativeEndMonth(reportMonth);
  return Array.from({ length: endMonth }, (_, index) => (
    `${numericYear}-${String(index + 1).padStart(2, '0')}`
  ));
}

module.exports = {
  BASELINE_CUMULATIVE_MONTH,
  productionCumulativeEndMonth,
  productionCumulativeMonths
};
