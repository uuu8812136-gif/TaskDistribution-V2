import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const readView = (relativePath) => readFileSync(
  new URL(`../src/views/tasks/${relativePath}`, import.meta.url),
  'utf8'
)

const taskListSource = readView('TaskList.vue')
const myTasksSource = readView('MyTasks.vue')
const taskBoardSource = readView('TaskBoard.vue')
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

test('task lists clear rows for a new query but preserve them during mutation refresh', () => {
  for (const source of [taskListSource, myTasksSource, taskBoardSource]) {
    assert.match(source, /\{ preserveExisting = false \} = \{\}/)
    assert.match(source, /if \(!preserveExisting\)/)
    assert.match(source, /fetchData\(\{ preserveExisting: true \}\)/)
  }
  assert.match(myTasksSource, /if \(!preserveExisting\) tasks\.value = \[\]/)
  assert.match(taskBoardSource, /loadError\.value = ''\s+if \(!preserveExisting\) tasks\.value = \[\]/)
  assert.match(taskBoardSource, /catch \(error\) \{[\s\S]*?if \(!preserveExisting\) tasks\.value = \[\]/)
  assert.match(taskListSource, /if \(!preserveExisting\) \{\s+taskList\.value = \[\]\s+pagination\.total = 0/)
  assert.match(taskListSource, /catch \(error\) \{[\s\S]*?if \(!preserveExisting\) \{[\s\S]*?taskList\.value = \[\]/)
})
