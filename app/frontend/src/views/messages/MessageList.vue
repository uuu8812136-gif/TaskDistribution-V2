<template>
  <div class="message-list">
    <header class="page-heading">
      <div>
        <h1>消息中心</h1>
        <p>集中查看任务通知和系统消息</p>
      </div>
      <div v-if="canModifyMessages" class="heading-actions">
        <el-button
          type="primary"
          :loading="bulkAction === 'read-all'"
          :disabled="Boolean(bulkAction) || hasPendingRow"
          @click="handleMarkAllRead"
        >
          <el-icon><CircleCheck /></el-icon>
          全部已读
        </el-button>
        <el-button
          type="danger"
          plain
          :loading="bulkAction === 'clear-read'"
          :disabled="Boolean(bulkAction) || hasPendingRow"
          @click="handleClearRead"
        >
          <el-icon><Delete /></el-icon>
          清空已读
        </el-button>
      </div>
    </header>

    <el-card>
      <el-tabs v-model="activeTab" @tab-change="handleTabChange">
        <el-tab-pane label="全部" name="all" />
        <el-tab-pane label="未读" name="unread" />
      </el-tabs>

      <el-table :data="messageList" v-loading="loading">
        <el-table-column width="60">
          <template #default="{ row }">
            <el-icon :size="24" :color="row.isRead ? '#909399' : '#409eff'">
              <component :is="messageTypeIcon[row.type]" />
            </el-icon>
          </template>
        </el-table-column>
        <el-table-column label="标题" min-width="200">
          <template #default="{ row }">
            <button
              v-if="hasMessageResource(row)"
              type="button"
              :class="['message-title-link', { 'unread-title': !row.isRead }]"
              :disabled="isRowPending(row) || Boolean(bulkAction)"
              @click="openRelatedResource(row)"
            >
              {{ row.title }}
            </button>
            <span v-else :class="{ 'unread-title': !row.isRead }">{{ row.title }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="content" label="内容" min-width="300" show-overflow-tooltip />
        <el-table-column label="时间" width="180">
          <template #default="{ row }">
            {{ fromNow(row.createdAt) }}
          </template>
        </el-table-column>
        <el-table-column v-if="canModifyMessages" label="操作" width="150" align="center">
          <template #default="{ row }">
            <div class="table-actions">
              <el-button
                v-if="!row.isRead"
                type="primary"
                size="small"
                text
                :loading="rowAction(row) === 'read' || rowAction(row) === 'open'"
                :disabled="isRowPending(row) || Boolean(bulkAction)"
                @click="handleMarkRead(row)"
              >
                标记已读
              </el-button>
              <el-button
                type="danger"
                size="small"
                text
                :loading="rowAction(row) === 'delete'"
                :disabled="isRowPending(row) || Boolean(bulkAction)"
                @click="handleDelete(row)"
              >删除</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        :current-page="pagination.page"
        :page-size="pagination.limit"
        :total="pagination.total"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        @size-change="val => { pagination.limit = val; pagination.page = 1; fetchData(); }"
        @current-change="val => { pagination.page = val; fetchData(); }"
        class="pagination"
      />
    </el-card>
  </div>
</template>

<script setup>
import { computed, ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useMessageStore } from '@/stores/message'
import { useSessionStore } from '@/stores/session'
import {
  getMessageList,
  markMessageAsRead,
  markAllAsRead,
  deleteMessage,
  clearReadMessages
} from '@/api/message'
import { fromNow, messageTypeIcon } from '@/utils/format'
import { hasMessageResource, messageResourceLocation } from '@/utils/messageNavigation'
import { requestErrorMessage } from '@/utils/request'
import { ElMessage, ElMessageBox } from 'element-plus'

const messageStore = useMessageStore()
const session = useSessionStore()
const router = useRouter()
const canModifyMessages = computed(() => session.isTeamMode && !session.isReadOnly)

const loading = ref(false)
const activeTab = ref('all')
const bulkAction = ref('')
const pendingRows = reactive({})
const hasPendingRow = computed(() => Object.keys(pendingRows).length > 0)

const pagination = reactive({
  page: 1,
  limit: 10,
  total: 0
})

const messageList = ref([])
let listRequestId = 0

const fetchData = async () => {
  const requestId = ++listRequestId
  const params = {
    page: pagination.page,
    limit: pagination.limit,
    isRead: activeTab.value === 'unread' ? 'false' : undefined
  }
  messageList.value = []
  pagination.total = 0
  loading.value = true
  try {
    const result = await getMessageList(params)
    if (requestId !== listRequestId) return
    messageList.value = result.messages
    pagination.total = result.pagination.total
  } catch (error) {
    if (requestId === listRequestId) console.error('获取消息列表失败:', error)
  } finally {
    if (requestId === listRequestId) loading.value = false
  }
}

const handleTabChange = () => {
  pagination.page = 1
  fetchData()
}

const rowAction = (row) => pendingRows[String(row?._id || '')] || ''
const isRowPending = (row) => Boolean(rowAction(row))

const setRowAction = (row, action) => {
  const id = String(row?._id || '')
  if (!id) return
  if (action) pendingRows[id] = action
  else delete pendingRows[id]
}

const markRowAsRead = async (row) => {
  if (row.isRead) return false
  await markMessageAsRead(row._id)
  if (!row.isRead) {
    row.isRead = true
    messageStore.decreaseUnreadCount()
  }
  return true
}

const openRelatedResource = async (row) => {
  const location = messageResourceLocation(row, { includeTeamId: session.isGlobalReadOnly })
  if (!location || isRowPending(row) || bulkAction.value) return

  if (canModifyMessages.value && !row.isRead) {
    setRowAction(row, 'open')
    try {
      await markRowAsRead(row)
    } catch (error) {
      console.error('打开消息前标记已读失败:', error)
      ElMessage.error(requestErrorMessage(error, '消息标记已读失败，请重试后再打开'))
      return
    } finally {
      setRowAction(row, '')
    }
  }

  await router.push(location)
}

const handleMarkRead = async (row) => {
  if (isRowPending(row) || bulkAction.value || row.isRead) return
  setRowAction(row, 'read')
  try {
    await markRowAsRead(row)
    await fetchData()
  } catch (error) {
    console.error('标记已读失败:', error)
    ElMessage.error(requestErrorMessage(error, '标记已读失败，请稍后重试'))
  } finally {
    setRowAction(row, '')
  }
}

const handleMarkAllRead = () => {
  if (bulkAction.value || hasPendingRow.value) return
  bulkAction.value = 'confirm-read-all'
  ElMessageBox.confirm('确定要将所有消息标记为已读吗？', '提示', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    type: 'warning'
  }).then(async () => {
    if (bulkAction.value !== 'confirm-read-all' || hasPendingRow.value) return
    bulkAction.value = 'read-all'
    try {
      await markAllAsRead()
      messageStore.clearUnreadCount()
      messageList.value.forEach((row) => { row.isRead = true })
      ElMessage.success('操作成功')
      await fetchData()
    } catch (error) {
      console.error('操作失败:', error)
      ElMessage.error(requestErrorMessage(error, '全部标记已读失败，请稍后重试'))
    } finally {
      bulkAction.value = ''
    }
  }).catch(() => {
    if (bulkAction.value === 'confirm-read-all') bulkAction.value = ''
  })
}

const handleClearRead = () => {
  if (bulkAction.value || hasPendingRow.value) return
  bulkAction.value = 'confirm-clear-read'
  ElMessageBox.confirm('确定要清空所有已读消息吗？', '提示', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    type: 'warning'
  }).then(async () => {
    if (bulkAction.value !== 'confirm-clear-read' || hasPendingRow.value) return
    bulkAction.value = 'clear-read'
    try {
      await clearReadMessages()
      ElMessage.success('清空成功')
      await fetchData()
    } catch (error) {
      console.error('清空失败:', error)
      ElMessage.error(requestErrorMessage(error, '清空已读消息失败，请稍后重试'))
    } finally {
      bulkAction.value = ''
    }
  }).catch(() => {
    if (bulkAction.value === 'confirm-clear-read') bulkAction.value = ''
  })
}

const handleDelete = (row) => {
  if (isRowPending(row) || bulkAction.value) return
  setRowAction(row, 'confirm-delete')
  ElMessageBox.confirm('确定要删除该消息吗？', '提示', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    type: 'warning'
  }).then(async () => {
    if (rowAction(row) !== 'confirm-delete' || bulkAction.value) return
    setRowAction(row, 'delete')
    try {
      await deleteMessage(row._id)
      if (!row.isRead) {
        messageStore.decreaseUnreadCount()
      }
      ElMessage.success('删除成功')
      await fetchData()
    } catch (error) {
      console.error('删除失败:', error)
      ElMessage.error(requestErrorMessage(error, '删除消息失败，请稍后重试'))
    } finally {
      setRowAction(row, '')
    }
  }).catch(() => {
    if (rowAction(row) === 'confirm-delete') setRowAction(row, '')
  })
}

onMounted(() => {
  fetchData()
})
</script>

<style scoped lang="scss">
.message-list {
  min-width: 0;

  .page-heading h1 {
    margin: 0 0 5px;
    font-size: 24px;
  }

  .page-heading p {
    margin: 0;
    color: var(--zl-muted);
  }

  .unread-title {
    font-weight: 600;
    color: #303133;
  }

  .message-title-link {
    display: inline;
    padding: 0;
    color: var(--el-color-primary);
    font: inherit;
    text-align: left;
    background: none;
    border: 0;
    cursor: pointer;
  }

  .message-title-link:hover,
  .message-title-link:focus-visible {
    text-decoration: underline;
  }

  .message-title-link:disabled {
    cursor: wait;
    opacity: 0.65;
  }

  .table-actions {
    justify-content: center;
  }

  .pagination {
    justify-content: flex-end;
    margin-top: 20px;
  }
}

@media (max-width: 760px) {
  .message-list {
    .heading-actions .el-button {
      flex: 1;
    }

    .pagination {
      justify-content: flex-start;
      overflow-x: auto;
      padding-bottom: 4px;
    }
  }
}
</style>

