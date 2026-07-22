import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const readView = (relativePath) => readFileSync(
  new URL(`../src/views/tasks/${relativePath}`, import.meta.url),
  'utf8'
)

const taskListSource = readView('TaskList.vue')
const myTasksSource = readView('MyTasks.vue')
const taskTableSource = readView('components/TaskTable.vue')

test('global read-only task lists identify and filter the owning project team', () => {
  assert.match(taskListSource, /v-if="session\.isGlobalReadOnly" label="项目团队"/)
  assert.match(taskListSource, /v-model="searchForm\.teamId"/)
  assert.match(taskListSource, /teamId: session\.isGlobalReadOnly \? searchForm\.teamId : undefined/)
  assert.match(taskListSource, /session\.isGlobalReadOnly && searchForm\.teamId\) exportParams\.teamId = searchForm\.teamId/)
  assert.match(taskListSource, /resolveTeamName\(row\)/)
})

test('my-task tables expose team labels only in global read-only mode', () => {
  assert.match(myTasksSource, /:show-team="session\.isGlobalReadOnly"/)
  assert.match(myTasksSource, /:teams="session\.teams"/)
  assert.match(taskTableSource, /v-if="showTeam" label="项目团队"/)
  assert.match(taskTableSource, /props\.teams\.find/)
})

test('task list and my-task requests ignore stale responses', () => {
  for (const source of [taskListSource, myTasksSource]) {
    assert.match(source, /let fetchRequestId = 0/)
    assert.match(source, /const requestId = \+\+fetchRequestId/)
    assert.match(source, /if \(requestId !== fetchRequestId\) return/)
    assert.match(source, /if \(requestId === fetchRequestId\) loading\.value = false/)
  }
})

test('task list and my-task requests clear rows before a new query and after its failure', () => {
  assert.match(myTasksSource, /loading\.value = true\s+tasks\.value = \[\]/)
  assert.match(myTasksSource, /catch \(error\) \{[\s\S]*?tasks\.value = \[\]/)
  assert.match(taskListSource, /loading\.value = true\s+taskList\.value = \[\]\s+pagination\.total = 0/)
  assert.match(taskListSource, /catch \(error\) \{[\s\S]*?taskList\.value = \[\][\s\S]*?pagination\.total = 0/)
})
