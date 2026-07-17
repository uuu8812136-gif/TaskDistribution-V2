export const AUDIT_ACTION_OPTIONS = Object.freeze([
  ['LOGIN_SUCCESS', '登录成功'],
  ['LOGIN_FAILURE', '登录失败'],
  ['LOGOUT', '退出登录'],
  ['ENTER_TEAM', '进入团队'],
  ['EXIT_TEAM', '退出团队'],
  ['SWITCH_TEAM', '切换团队'],
  ['CREATE', '创建'],
  ['UPDATE', '更新'],
  ['DELETE', '删除'],
  ['ENABLE', '启用'],
  ['DISABLE', '停用'],
  ['ROLE_UPDATE', '角色调整'],
  ['PERMISSION_UPDATE', '权限调整'],
  ['STATUS_CHANGE', '状态变更'],
  ['ASSIGN', '分派'],
  ['UNASSIGN', '取消分派'],
  ['SUBMIT', '提交'],
  ['APPROVE', '通过'],
  ['REJECT', '驳回'],
  ['RETURN', '退回'],
  ['LOCK', '锁定'],
  ['UNLOCK', '解锁'],
  ['CORRECT', '纠正'],
  ['GENERATE', '生成'],
  ['IMPORT', '导入'],
  ['IMPORT_EXCEPTION_CONFIRM', '导入异常确认'],
  ['PUBLISH', '发布'],
  ['EXPORT', '导出'],
  ['FILE_DELETE', '删除文件']
].map(([value, label]) => Object.freeze({ value, label })))

export const AUDIT_RESOURCE_TYPE_OPTIONS = Object.freeze([
  ['SYSTEM', '系统'],
  ['USER', '用户'],
  ['PROJECT_TEAM', '项目团队'],
  ['ORG_UNIT', '组织单元'],
  ['TEAM_MEMBERSHIP', '团队成员关系'],
  ['AUTH_SESSION', '登录会话'],
  ['TASK', '任务'],
  ['TASK_REVIEW', '任务审核'],
  ['EXTENSION_REQUEST', '延期申请'],
  ['MESSAGE', '消息'],
  ['FILE_ASSET', '文件'],
  ['EQUIPMENT_ASSET', '设备台账'],
  ['EQUIPMENT_CATEGORY', '设备分类'],
  ['EQUIPMENT_CHANGE_LOG', '设备变更'],
  ['EQUIPMENT_RUNTIME_READING', '设备运行读数'],
  ['INVENTORY_SESSION', '盘点批次'],
  ['INVENTORY_ITEM', '盘点明细'],
  ['INVENTORY_APPROVAL', '盘点审批'],
  ['INSPECTION_TEMPLATE', '点检模板'],
  ['INSPECTION_PLAN', '点检计划'],
  ['INSPECTION_RECORD', '点检记录'],
  ['INSPECTION_EXCEPTION', '点检异常'],
  ['REPAIR_ORDER', '维修单'],
  ['MAINTENANCE_PLAN', '保养计划'],
  ['MAINTENANCE_RECORD', '保养记录'],
  ['MAINTENANCE_EXCEPTION', '保养异常'],
  ['EQUIPMENT_STATUS_APPLICATION', '设备状态申请'],
  ['EQUIPMENT_STATUS_APPROVAL', '设备状态审批'],
  ['TRANSPORT_RECORD', '运输提报'],
  ['ATTENDANCE_SUBMISSION', '出勤提报'],
  ['ATTENDANCE_REVIEW', '出勤审核'],
  ['ATTENDANCE_MONTHLY_SUMMARY', '出勤月报'],
  ['ATTENDANCE_REPORTER_ASSIGNMENT', '考勤提报人分配'],
  ['PRODUCTION_SCHEDULE', '生产排产'],
  ['GENERATED_DAILY_REPORT', '生产日报'],
  ['REPORT_CORRECTION_RECORD', '提报纠正记录'],
  ['IMPORT_JOB', '导入任务'],
  ['IMPORT_EXCEPTION', '导入异常']
].map(([value, label]) => Object.freeze({ value, label })))

const actionLabels = new Map(AUDIT_ACTION_OPTIONS.map((item) => [item.value, item.label]))
const resourceLabels = new Map(AUDIT_RESOURCE_TYPE_OPTIONS.map((item) => [item.value, item.label]))

function trimmed(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isoDate(value) {
  if (!value) return undefined
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export function canViewAudit({
  isSuperAdmin = false,
  isTeamMode = false,
  isGlobalReadOnly = false,
  membershipRole = null,
  permissionKeys = []
} = {}) {
  if (!permissionKeys.includes('audit.view')) return false
  if (isSuperAdmin) return isTeamMode || isGlobalReadOnly
  return isTeamMode && membershipRole === 'PROJECT_ADMIN'
}

export function buildAuditQuery(filters = {}, { global = false } = {}) {
  const range = Array.isArray(filters.timeRange) ? filters.timeRange : []
  return Object.fromEntries(Object.entries({
    startTime: isoDate(range[0]),
    endTime: isoDate(range[1]),
    actorUserId: trimmed(filters.actorUserId),
    targetTeamId: global ? trimmed(filters.targetTeamId) : undefined,
    resourceType: trimmed(filters.resourceType),
    action: trimmed(filters.action),
    resourceId: trimmed(filters.resourceId),
    requestId: trimmed(filters.requestId),
    page: Number(filters.page) || 1,
    pageSize: Number(filters.pageSize) || 20
  }).filter(([, value]) => value !== undefined && value !== ''))
}

export function auditActionLabel(value) {
  return actionLabels.get(value) || value || '-'
}

export function auditResourceLabel(value) {
  return resourceLabels.get(value) || value || '-'
}

export function formatAuditSnapshot(value) {
  if (value === undefined) return '无快照'
  return JSON.stringify(value, null, 2)
}
