<template>
  <div class="task-form" v-loading="initializing">
    <el-page-header @back="goBack" title="返回">
      <template #content>
        <span>{{ isEdit ? '编辑任务' : '创建任务' }}</span>
      </template>
    </el-page-header>

    <el-result
      v-if="initializationError"
      icon="warning"
      title="无法进入任务表单"
      :sub-title="initializationError"
      class="form-error"
    >
      <template #extra>
        <el-button type="primary" @click="goBack">返回</el-button>
      </template>
    </el-result>

    <el-card v-else-if="formReady" style="margin-top: 20px">
      <el-steps :active="currentStep" finish-status="success" style="margin-bottom: 30px">
        <el-step title="基本信息" />
        <el-step title="人员分配" />
        <el-step title="子任务" />
        <el-step title="附件上传" />
      </el-steps>

      <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
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
          <el-button type="primary" class="subtask-add" @click="addSubTask">
            <el-icon><Plus /></el-icon>
            添加子任务
          </el-button>
          <div v-for="(subTask, index) in form.subTasks" :key="index" class="subtask-card">
            <el-form-item :label="`子任务${index + 1}`">
              <el-input v-model="subTask.taskName" placeholder="子任务名称" />
            </el-form-item>
            <el-form-item label="描述">
              <el-input v-model="subTask.description" type="textarea" :rows="2" />
            </el-form-item>
            <el-button type="danger" plain size="small" class="subtask-remove" @click="removeSubTask(index)">
              <el-icon><Delete /></el-icon>
              删除
            </el-button>
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
              <el-button type="primary">
                <el-icon><Upload /></el-icon>
                选择文件
              </el-button>
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
import {
  createTask,
  updateTask,
  getTaskAssignableUsers,
  getTaskDetail,
  getTaskList
} from '@/api/task'
import { deleteFile, uploadTaskTemporaryFile } from '@/api/file'
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
import {
  firstInvalidTaskFormStep,
  taskFormFieldsThroughStep
} from '@/utils/taskFormValidation'
import { canCreateTask, canEditTask } from '@/utils/taskPolicy'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const isEdit = ref(!!route.params.id)

const currentStep = ref(0)
const formRef = ref(null)
const submitting = ref(false)
const initializing = ref(true)
const formReady = ref(false)
const formAuthorized = ref(false)
const initializationError = ref('')
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

const uploadTaskAttachment = (file) => uploadTaskTemporaryFile(
  file,
  isEdit.value
    ? { taskId: route.params.id }
    : { orgUnitId: form.orgUnitId }
)

const validateTaskForm = async (fields) => {
  try {
    const valid = fields
      ? await formRef.value?.validateField(fields)
      : await formRef.value?.validate()
    return valid !== false
  } catch (invalidFields) {
    const firstInvalidStep = firstInvalidTaskFormStep(invalidFields)
    if (firstInvalidStep !== null) {
      currentStep.value = firstInvalidStep
    }
    return false
  }
}

const nextStep = async () => {
  if (currentStep.value >= 3) return

  const fields = taskFormFieldsThroughStep(currentStep.value, {
    includeOrgUnit: isTeamTaskScope.value
  })
  if (await validateTaskForm(fields)) {
    currentStep.value++
  }
}

const prevStep = () => {
  if (currentStep.value > 0) {
    currentStep.value--
  }
}

const handleSubmit = async () => {
  if (submitting.value || !formAuthorized.value) return
  const valid = await validateTaskForm()
  if (!valid) return
  submitting.value = true
  let uploadedFileIds = []
  try {
    const prepared = await prepareAttachmentReferences(fileList.value, uploadTaskAttachment)
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
    await refreshFormAuthorization()
  } finally {
    submitting.value = false
  }
}

const goBack = () => {
  router.back()
}

const denyFormAccess = (message) => {
  formAuthorized.value = false
  formReady.value = false
  initializationError.value = message
}

const refreshFormAuthorization = async () => {
  try {
    const response = isEdit.value
      ? await getTaskDetail(route.params.id)
      : await getTaskList({ page: 1, limit: 1 })
    const authorized = isEdit.value
      ? canEditTask(response.task)
      : canCreateTask(response)
    formAuthorized.value = authorized
    if (!authorized) {
      denyFormAccess('当前负责人已接管，您现在没有维护该任务的权限。')
    }
    return response
  } catch (error) {
    denyFormAccess('暂时无法验证当前任务权限，请返回任务列表后重试。')
    return null
  }
}

onMounted(async () => {
  try {
    const authorizationResponse = await refreshFormAuthorization()
    if (!authorizationResponse || !formAuthorized.value) return

    // 获取所有用户，设置足够大的 limit
    const result = await getTaskAssignableUsers({ limit: 1000 })
    users.value = result.users

    if (!isEdit.value && isTeamTaskScope.value && orgUnitOptions.value.length === 1) {
      form.orgUnitId = orgUnitOptions.value[0].value
    }

    if (isEdit.value) {
      const taskData = authorizationResponse
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
    formReady.value = true
  } catch (error) {
    console.error('初始化失败:', error)
    denyFormAccess('加载任务数据失败，请返回任务列表后重试。')
  } finally {
    initializing.value = false
  }
})
</script>

<style scoped lang="scss">
.task-form {
  min-width: 0;

  :deep(.el-page-header) {
    margin-bottom: 20px;
  }

  .field-hint {
    margin-top: 6px;
    color: #909399;
    font-size: 12px;
    line-height: 1.5;
  }

  .form-error {
    margin-top: 20px;
  }

  .subtask-add {
    margin-bottom: 16px;
  }

  .subtask-card {
    margin-bottom: 16px;
    padding: 16px;
    background: rgb(245 249 255 / 72%);
    border: 1px solid var(--zl-border-soft);
    border-radius: 14px;
  }

  .subtask-remove {
    display: flex;
    margin-left: auto;
  }

  .step-actions {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin-top: 30px;
    padding-top: 20px;
    border-top: 1px solid #eee;
  }
}

@media (max-width: 760px) {
  .task-form {
    :deep(.el-card__body) {
      padding: 16px;
    }

    :deep(.el-step__title) {
      font-size: 12px;
      line-height: 1.35;
    }

    .step-actions .el-button {
      flex: 1;
    }
  }
}
</style>

