<template>
  <div class="message-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>消息中心</span>
          <div>
            <el-button type="primary" @click="handleMarkAllRead">全部已读</el-button>
            <el-button type="danger" @click="handleClearRead">清空已读</el-button>
          </div>
        </div>
      </template>

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
            <div :class="{ 'unread-title': !row.isRead }">{{ row.title }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="content" label="内容" min-width="300" show-overflow-tooltip />
        <el-table-column label="时间" width="180">
          <template #default="{ row }">
            {{ fromNow(row.createdAt) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <el-button v-if="!row.isRead" type="primary" size="small" text @click="handleMarkRead(row)">
              标记已读
            </el-button>
            <el-button type="danger" size="small" text @click="handleDelete(row)">删除</el-button>
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
        style="margin-top: 20px; justify-content: flex-end"
      />
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useMessageStore } from '@/stores/message'
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
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .unread-title {
    font-weight: 600;
    color: #303133;
  }
}
</style>

