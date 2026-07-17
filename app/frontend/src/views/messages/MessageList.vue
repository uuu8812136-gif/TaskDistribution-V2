<template>
  <div class="message-list">
    <header class="page-heading">
      <div>
        <h1>消息中心</h1>
        <p>集中查看任务通知和系统消息</p>
      </div>
      <div v-if="canModifyMessages" class="heading-actions">
        <el-button type="primary" @click="handleMarkAllRead">
          <el-icon><CircleCheck /></el-icon>
          全部已读
        </el-button>
        <el-button type="danger" plain @click="handleClearRead">
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
            <div
              :class="{ 'unread-title': !row.isRead, 'clickable-title': row.extraData?.statusApplicationId }"
              @click="openRelatedResource(row)"
            >{{ row.title }}</div>
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
              <el-button v-if="!row.isRead" type="primary" size="small" text @click="handleMarkRead(row)">
                标记已读
              </el-button>
              <el-button type="danger" size="small" text @click="handleDelete(row)">删除</el-button>
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
import { ElMessage, ElMessageBox } from 'element-plus'

const messageStore = useMessageStore()
const session = useSessionStore()
const router = useRouter()
const canModifyMessages = computed(() => session.isTeamMode && !session.isReadOnly)

const loading = ref(false)
const activeTab = ref('all')

const pagination = reactive({
  page: 1,
  limit: 10,
  total: 0
})

const messageList = ref([])

const fetchData = async () => {
  loading.value = true
  try {
    const result = await getMessageList({
      page: pagination.page,
      limit: pagination.limit,
      isRead: activeTab.value === 'unread' ? 'false' : undefined
    })
    messageList.value = result.messages
    pagination.total = result.pagination.total
  } catch (error) {
    console.error('获取消息列表失败:', error)
  } finally {
    loading.value = false
  }
}

const handleTabChange = () => {
  pagination.page = 1
  fetchData()
}

const openRelatedResource = (row) => {
  if (!row.extraData?.statusApplicationId) return
  router.push({
    name: 'EquipmentStatusApplicationDetail',
    params: { applicationId: row.extraData.statusApplicationId }
  })
}

const handleMarkRead = async (row) => {
  try {
    await markMessageAsRead(row._id)
    messageStore.decreaseUnreadCount()
    fetchData()
  } catch (error) {
    console.error('标记已读失败:', error)
  }
}

const handleMarkAllRead = () => {
  ElMessageBox.confirm('确定要将所有消息标记为已读吗？', '提示', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    type: 'warning'
  }).then(async () => {
    try {
      await markAllAsRead()
      messageStore.clearUnreadCount()
      ElMessage.success('操作成功')
      fetchData()
    } catch (error) {
      console.error('操作失败:', error)
    }
  }).catch(() => {})
}

const handleClearRead = () => {
  ElMessageBox.confirm('确定要清空所有已读消息吗？', '提示', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    type: 'warning'
  }).then(async () => {
    try {
      await clearReadMessages()
      ElMessage.success('清空成功')
      fetchData()
    } catch (error) {
      console.error('清空失败:', error)
    }
  }).catch(() => {})
}

const handleDelete = (row) => {
  ElMessageBox.confirm('确定要删除该消息吗？', '提示', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    type: 'warning'
  }).then(async () => {
    try {
      await deleteMessage(row._id)
      if (!row.isRead) {
        messageStore.decreaseUnreadCount()
      }
      ElMessage.success('删除成功')
      fetchData()
    } catch (error) {
      console.error('删除失败:', error)
    }
  }).catch(() => {})
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

  .clickable-title {
    color: var(--el-color-primary);
    cursor: pointer;
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

