<template>
  <div class="task-form">
    <el-page-header @back="goBack" title="返回">
      <template #content>
        <span>{{ isEdit ? '编辑任务' : '创建任务' }}</span>
      </template>
    </el-page-header>

    <el-card style="margin-top: 20px">
      <el-steps :active="currentStep" finish-status="success" style="margin-bottom: 30px">
        <el-step title="基本信息" />
        <el-step title="人员分配" />
        <el-step title="子任务" />
        <el-step title="附件上传" />
      </el-steps>

      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <!-- 步骤1：基本信息 -->
        <div v-show="currentStep === 0">
          <el-form-item
            v-if="isTeamTaskScope"
            label="任务所属组织"
            prop="orgUnitId"
          >
            <el-select
              v-model="form.orgUnitId"
              filterable
              :disabled="isEdit"
              placeholder="请选择任务归属的分部或组织"
              style="width: 100%"
              @change="handleOrgUnitChange"
            >
              <el-option
                v-for="orgUnit in orgUnitOptions"
                :key="orgUnit.value"
                :label="orgUnit.label"
                :value="orgUnit.value"
              />
            </el-select>
            <div class="field-hint">
              普通执行人和抄送人必须属于该组织，创建后不能修改归属。
            </div>
          </el-form-item>
          <el-form-item label="任务名称" prop="taskName">
            <el-input v-model="form.taskName" placeholder="请输入任务名称" />
          </el-form-item>
          <el-form-item label="任务类型" prop="taskType">
            <el-input v-model="form.taskType" placeholder="如:重汽任务、公司任务、部门任务等" />
          </el-form-item>
          <el-form-item label="任务来源" prop="taskSource">
            <el-input v-model="form.taskSource" placeholder="如:会议纪要、现场检查等" />
          </el-form-item>
          <el-form-item label="任务描述" prop="description">
            <el-input v-model="form.description" type="textarea" :rows="4" />
          </el-form-item>
          <el-form-item label="优先级" prop="priority">
            <el-radio-group v-model="form.priority">
              <el-radio label="low">低</el-radio>
              <el-radio label="normal">普通</el-radio>
              <el-radio label="high">高</el-radio>
              <el-radio label="urgent">紧急</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="计划完成时间" prop="plannedCompletionTime">
            <el-date-picker
              v-model="form.plannedCompletionTime"
              type="datetime"
              placeholder="选择日期时间"
              style="width: 100%"
            />
          </el-form-item>
        </div>

        <!-- 步骤2：人员分配 -->
        <div v-show="currentStep === 1">
          <el-form-item label="执行人" prop="executor">
            <el-select
              v-model="form.executor"
              multiple
              filterable
              :disabled="isTeamTaskScope && !form.orgUnitId"
              placeholder="选择执行人"
              style="width: 100%"
            >
              <el-option
                v-for="user in assignableUsers"
                :key="user._id"
                :label="userOptionLabel(user)"
                :value="user._id"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="主负责人" prop="mainExecutor">
            <el-select v-model="form.mainExecutor" placeholder="选择主负责人" style="width: 100%">
              <el-option
                v-for="userId in form.executor"
                :key="userId"
                :label="getUserName(userId)"
                :value="userId"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="抄送人" prop="ccUsers">
            <el-select
              v-model="form.ccUsers"
              multiple
              filterable
              :disabled="isTeamTaskScope && !form.orgUnitId"
              placeholder="选择抄送人"
              style="width: 100%"
            >
              <el-option
                v-for="user in assignableUsers"
                :key="user._id"
                :label="userOptionLabel(user)"
                :value="user._id"
              />
            </el-select>
          </el-form-item>
        </div>

        <!-- 步骤3：子任务 -->
        <div v-show="currentStep === 2">
          <el-button type="primary" @click="addSubTask" style="margin-bottom: 20px">添加子任务</el-button>
          <div v-for="(subTask, index) in form.subTasks" :key="index" style="margin-bottom: 20px; padding: 15px; border: 1px solid #eee; border-radius: 4px">
            <el-form-item :label="`子任务${index + 1}`">
              <el-input v-model="subTask.taskName" placeholder="子任务名称" />
            </el-form-item>
            <el-form-item label="描述">
              <el-input v-model="subTask.description" type="textarea" :rows="2" />
            </el-form-item>
            <el-button type="danger" size="small" @click="removeSubTask(index)">删除</el-button>
          </div>
          <el-empty v-if="form.subTasks.length === 0" description="暂无子任务" />
        </div>

        <!-- 步骤4：附件 -->
        <div v-show="currentStep === 3">
          <el-form-item label="附件上传">
            <el-upload
              :file-list="fileList"
              :on-change="handleFileChange"
              :on-remove="handleFileChange"
              :auto-upload="false"
              multiple
            >
              <el-button type="primary">选择文件</el-button>
              <template #tip>
                <div class="el-upload__tip">支持上传图片、文档，单个文件不超过10MB</div>
              </template>
            </el-upload>
          </el-form-item>
        </div>
      </el-form>

      <div class="step-actions">
        <el-button v-if="currentStep > 0" @click="prevStep">上一步</el-button>
        <el-button v-if="currentStep < 3" type="primary" @click="nextStep">下一步</el-button>
        <el-button v-if="currentStep === 3" type="success" @click="handleSubmit" :loading="submitting">
          {{ isEdit ? '保存' : '创建' }}
        </el-button>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { computed, ref, reactive, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getUserList } from '@/api/user'
import { createTask, updateTask, getTaskDetail } from '@/api/task'
import { deleteFile, uploadTemporaryFile } from '@/api/file'
import {
  cleanupTemporaryFiles,
  existingAttachmentFileList,
  prepareAttachmentReferences
} from '@/utils/attachments'
import { ElMessage } from 'element-plus'
import { useSessionStore } from '@/stores/session'
import {
  buildTaskOrgUnitOptions,
  filterTaskParticipants
} from '@/utils/taskAssignment'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const isEdit = ref(!!route.params.id)

const currentStep = ref(0)
const formRef = ref(null)
const submitting = ref(false)
const users = ref([])
const fileList = ref([])

const form = reactive({
  orgUnitId: session.context.membership?.orgUnitId || '',
  taskName: '',
  taskType: '',
  taskSource: '',
  description: '',
  priority: 'normal',
  plannedCompletionTime: '',
  executor: [],
  mainExecutor: '',
  ccUsers: [],
  subTasks: []
})

const rules = {
  orgUnitId: [{ required: true, message: '请选择任务所属组织', trigger: 'change' }],
  taskName: [{ required: true, message: '请输入任务名称', trigger: 'blur' }],
  plannedCompletionTime: [{ required: true, message: '请选择计划完成时间', trigger: 'change' }],
  executor: [{ required: true, message: '请选择执行人', trigger: 'change' }]
}

const isTeamTaskScope = computed(() => session.moduleDataScopes.task === 'TEAM')
const orgUnitOptions = computed(() => buildTaskOrgUnitOptions(users.value))
const assignableUsers = computed(() => filterTaskParticipants(
  users.value,
  form.orgUnitId,
  isTeamTaskScope.value
))

const getUserName = (userId) => {
  return users.value.find(u => u._id === userId)?.name || ''
}

const userOptionLabel = (user) => (
  user.department ? `${user.name} · ${user.department}` : user.name
)

const handleOrgUnitChange = () => {
  form.executor = []
  form.mainExecutor = ''
  form.ccUsers = []
}

const addSubTask = () => {
  form.subTasks.push({
    taskName: '',
    description: ''
  })
}

const removeSubTask = (index) => {
  form.subTasks.splice(index, 1)
}

const handleFileChange = (file, files) => {
  fileList.value = files
}

const nextStep = () => {
  if (currentStep.value < 3) {
    currentStep.value++
  }
}

const prevStep = () => {
  if (currentStep.value > 0) {
    currentStep.value--
  }
}

const handleSubmit = async () => {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  let uploadedFileIds = []
  try {
    const prepared = await prepareAttachmentReferences(fileList.value, uploadTemporaryFile)
    uploadedFileIds = prepared.uploadedFileIds
    const payload = {
      ...form,
      executor: [...form.executor],
      ccUsers: [...form.ccUsers],
      subTasks: form.subTasks.map((subTask) => ({ ...subTask })),
      attachments: prepared.references
    }

    if (isEdit.value) {
      await updateTask(route.params.id, payload)
      ElMessage.success('任务更新成功')
    } else {
      await createTask(payload)
      ElMessage.success('任务创建成功')
    }
    router.push('/tasks')
  } catch (error) {
    await cleanupTemporaryFiles(error.uploadedFileIds || uploadedFileIds, deleteFile)
    console.error('提交失败:', error)
  } finally {
    submitting.value = false
  }
}

const goBack = () => {
  router.back()
}

onMounted(async () => {
  try {
    // 获取所有用户，设置足够大的 limit
    const result = await getUserList({ limit: 1000 })
    users.value = result.users

    if (!isEdit.value && isTeamTaskScope.value && orgUnitOptions.value.length === 1) {
      form.orgUnitId = orgUnitOptions.value[0].value
    }

    if (isEdit.value) {
      const taskData = await getTaskDetail(route.params.id)
      // 回填表单数据
      Object.assign(form, {
        orgUnitId: taskData.task.orgUnitId,
        taskName: taskData.task.taskName,
        taskType: taskData.task.taskType,
        taskSource: taskData.task.taskSource,
        description: taskData.task.description,
        priority: taskData.task.priority,
        plannedCompletionTime: taskData.task.plannedCompletionTime,
        executor: taskData.task.executor.map(e => e._id),
        mainExecutor: taskData.task.mainExecutor?._id || '',
        ccUsers: taskData.task.ccUsers.map(cc => cc._id),
        subTasks: taskData.task.subTasks || []
      })
      fileList.value = existingAttachmentFileList(taskData.task.attachments)
    }
  } catch (error) {
    console.error('初始化失败:', error)
    ElMessage.error('加载任务数据失败')
  }
})
</script>

<style scoped lang="scss">
.task-form {
  .field-hint {
    margin-top: 6px;
    color: #909399;
    font-size: 12px;
    line-height: 1.5;
  }

  .step-actions {
    display: flex;
    justify-content: center;
    gap: 20px;
    margin-top: 30px;
    padding-top: 20px;
    border-top: 1px solid #eee;
  }
}
</style>

