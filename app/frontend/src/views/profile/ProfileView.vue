<template>
  <div class="profile-view">
    <header class="page-heading">
      <div>
        <h1>个人中心</h1>
        <p>查看账号信息、任务统计并维护登录密码</p>
      </div>
    </header>

    <el-row :gutter="20">
      <el-col :xs="24" :lg="8" class="profile-sidebar">
        <el-card>
          <div class="profile-header">
            <el-avatar :size="80">{{ userStore.userInfo?.name?.substring(0, 1) }}</el-avatar>
            <h3 style="margin-top: 15px">{{ userStore.userInfo?.name }}</h3>
            <p style="color: #909399">{{ userStore.userInfo?.username }}</p>
          </div>
        </el-card>

        <el-card style="margin-top: 20px">
          <template #header>
            <span>我的统计</span>
          </template>
          <el-descriptions :column="1" border>
            <el-descriptions-item label="执行任务">{{ stats.executorTasks || 0 }}</el-descriptions-item>
            <el-descriptions-item label="抄送任务">{{ stats.ccTasks || 0 }}</el-descriptions-item>
            <el-descriptions-item label="完成任务">{{ stats.finishedTasks || 0 }}</el-descriptions-item>
          </el-descriptions>
        </el-card>
      </el-col>

      <el-col :xs="24" :lg="16" class="profile-main">
        <el-card>
          <template #header>
            <span>个人信息</span>
          </template>
          <el-descriptions :column="descriptionColumns" border>
            <el-descriptions-item label="用户名">{{ userStore.userInfo?.username }}</el-descriptions-item>
            <el-descriptions-item label="姓名">{{ userStore.userInfo?.name }}</el-descriptions-item>
            <el-descriptions-item label="手机号">{{ userStore.userInfo?.phone }}</el-descriptions-item>
            <el-descriptions-item label="邮箱">{{ userStore.userInfo?.email }}</el-descriptions-item>
            <el-descriptions-item label="部门">{{ userStore.userInfo?.department }}</el-descriptions-item>
            <el-descriptions-item label="角色">
              <el-tag v-for="role in userStore.userInfo?.roles" :key="role" size="small" style="margin-right: 5px">
                {{ roleMap[role] }}
              </el-tag>
            </el-descriptions-item>
          </el-descriptions>
        </el-card>

        <el-card style="margin-top: 20px">
          <template #header>
            <span>修改密码</span>
          </template>
          <el-form
            ref="passwordFormRef"
            :model="passwordForm"
            :rules="passwordRules"
            :label-position="descriptionColumns === 1 ? 'top' : 'right'"
            label-width="100px"
            style="max-width: 500px"
          >
            <el-form-item label="旧密码" prop="oldPassword">
              <el-input v-model="passwordForm.oldPassword" type="password" show-password />
            </el-form-item>
            <el-form-item label="新密码" prop="newPassword">
              <el-input v-model="passwordForm.newPassword" type="password" show-password />
            </el-form-item>
            <el-form-item label="确认密码" prop="confirmPassword">
              <el-input v-model="passwordForm.confirmPassword" type="password" show-password />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="handleChangePassword">提交</el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import { useUserStore } from '@/stores/user'
import { changePassword } from '@/api/auth'
import { getMyTasks } from '@/api/task'
import { roleMap } from '@/utils/format'
import { ElMessage } from 'element-plus'

const userStore = useUserStore()
const passwordFormRef = ref(null)
const descriptionColumns = ref(2)

const syncResponsiveLayout = () => {
  descriptionColumns.value = window.matchMedia('(max-width: 760px)').matches ? 1 : 2
}

const stats = ref({
  executorTasks: 0,
  ccTasks: 0,
  finishedTasks: 0
})

const passwordForm = reactive({
  oldPassword: '',
  newPassword: '',
  confirmPassword: ''
})

const passwordRules = {
  oldPassword: [{ required: true, message: '请输入旧密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, message: '密码长度至少6位', trigger: 'blur' }
  ],
  confirmPassword: [
    { required: true, message: '请确认新密码', trigger: 'blur' },
    {
      validator: (rule, value, callback) => {
        if (value !== passwordForm.newPassword) {
          callback(new Error('两次输入的密码不一致'))
        } else {
          callback()
        }
      },
      trigger: 'blur'
    }
  ]
}

const handleChangePassword = async () => {
  await passwordFormRef.value.validate(async (valid) => {
    if (valid) {
      try {
        await changePassword({
          oldPassword: passwordForm.oldPassword,
          newPassword: passwordForm.newPassword
        })
        ElMessage.success('密码修改成功，请重新登录')
        setTimeout(() => {
          userStore.logout()
        }, 1500)
      } catch (error) {
        console.error('修改密码失败:', error)
      }
    }
  })
}

const fetchStats = async () => {
  try {
    const [executorRes, ccRes, finishedRes] = await Promise.all([
      getMyTasks({ type: 'executor' }),
      getMyTasks({ type: 'cc' }),
      getMyTasks({ type: 'executor', status: 'finished' })
    ])
    stats.value = {
      executorTasks: executorRes.tasks?.length || 0,
      ccTasks: ccRes.tasks?.length || 0,
      finishedTasks: finishedRes.tasks?.length || 0
    }
  } catch (error) {
    console.error('获取统计数据失败:', error)
  }
}

onMounted(() => {
  syncResponsiveLayout()
  window.addEventListener('resize', syncResponsiveLayout)
  fetchStats()
})

onUnmounted(() => {
  window.removeEventListener('resize', syncResponsiveLayout)
})
</script>

<style scoped lang="scss">
.profile-view {
  min-width: 0;

  .page-heading h1 {
    margin: 0 0 5px;
    font-size: 24px;
  }

  .page-heading p {
    margin: 0;
    color: var(--zl-muted);
  }

  .profile-header {
    text-align: center;
    padding: 20px 0;
  }
}

@media (max-width: 1199px) {
  .profile-main {
    margin-top: 20px;
  }
}

@media (max-width: 760px) {
  .profile-view :deep(.el-form-item__label) {
    width: auto !important;
  }
}
</style>

