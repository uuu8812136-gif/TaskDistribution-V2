export const TASK_FORM_STEP_FIELDS = Object.freeze([
  Object.freeze(['orgUnitId', 'taskName', 'plannedCompletionTime']),
  Object.freeze(['executor']),
  Object.freeze([]),
  Object.freeze([])
])

export function taskFormFieldsThroughStep(currentStep, { includeOrgUnit = true } = {}) {
  const lastStep = Math.min(
    Math.max(Number(currentStep) || 0, 0),
    TASK_FORM_STEP_FIELDS.length - 1
  )

  return TASK_FORM_STEP_FIELDS
    .slice(0, lastStep + 1)
    .flat()
    .filter((field) => includeOrgUnit || field !== 'orgUnitId')
}

export function firstInvalidTaskFormStep(invalidFields) {
  const fieldNames = Array.isArray(invalidFields)
    ? invalidFields
    : invalidFields && typeof invalidFields === 'object'
      ? Object.keys(invalidFields)
      : [invalidFields]

  const invalidFieldNames = new Set(fieldNames.filter((field) => typeof field === 'string'))
  const step = TASK_FORM_STEP_FIELDS.findIndex((fields) => (
    fields.some((field) => invalidFieldNames.has(field))
  ))

  return step === -1 ? null : step
}
