import assert from 'node:assert/strict'
import test from 'node:test'

import {
  firstInvalidTaskFormStep,
  taskFormFieldsThroughStep
} from '../src/utils/taskFormValidation.js'

test('the first task step validates its visible required fields', () => {
  assert.deepEqual(taskFormFieldsThroughStep(0), [
    'orgUnitId',
    'taskName',
    'plannedCompletionTime'
  ])
  assert.deepEqual(taskFormFieldsThroughStep(0, { includeOrgUnit: false }), [
    'taskName',
    'plannedCompletionTime'
  ])
})

test('advancing from the assignment step also revalidates earlier required fields', () => {
  assert.deepEqual(taskFormFieldsThroughStep(1), [
    'orgUnitId',
    'taskName',
    'plannedCompletionTime',
    'executor'
  ])
})

test('validation returns the earliest invalid task step regardless of error order', () => {
  assert.equal(firstInvalidTaskFormStep({
    executor: [{ message: 'required' }],
    plannedCompletionTime: [{ message: 'required' }]
  }), 0)
  assert.equal(firstInvalidTaskFormStep({ executor: [{ message: 'required' }] }), 1)
})

test('validation ignores fields that are not part of the task wizard', () => {
  assert.equal(firstInvalidTaskFormStep({ unknown: [{ message: 'invalid' }] }), null)
  assert.equal(firstInvalidTaskFormStep(null), null)
})
