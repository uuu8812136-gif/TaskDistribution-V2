import { requestErrorMessage } from './requestErrorMessages.js'

export const MEMBERSHIP_ROLES = Object.freeze({
  PROJECT_ADMIN: 'PROJECT_ADMIN',
  MEMBER: 'MEMBER'
})

export const MEMBERSHIP_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED'
})

export const TEAM_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED'
})

export const ORG_UNIT_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED'
})

export const POSITION_OPTIONS = Object.freeze([
  { value: 'DEPARTMENT_MANAGER', label: '部门经理', level: 1 },
  { value: 'DEPARTMENT_DEPUTY_MANAGER', label: '部门副经理', level: 2 },
  { value: 'DEPARTMENT_MANAGER_ASSISTANT', label: '经理助理', level: 2 },
  { value: 'SUB_DEPARTMENT_MANAGER', label: '分部经理', level: 3 },
  { value: 'SUB_DEPARTMENT_DEPUTY_MANAGER', label: '分部副经理', level: 3 },
  { value: 'SUPERVISOR', label: '主管', level: 4 },
  { value: 'TEAM_LEADER', label: '班组长', level: 5 },
  { value: 'EMPLOYEE', label: '员工', level: 6 }
])

export const FUNCTIONAL_ROLE_OPTIONS = Object.freeze([
  { value: 'TRANSPORT_REPORTER', label: '运输提报员' },
  { value: 'TRANSPORT_ADMIN', label: '运输管理员' },
  { value: 'ATTENDANCE_REPORTER', label: '考勤提报人' },
  { value: 'ATTENDANCE_OFFICER', label: '考勤员' },
  { value: 'ASSET_ADMIN', label: '设备管理员' }
])

export const ORG_UNIT_TYPE_OPTIONS = Object.freeze([
  { value: 'DEPARTMENT', label: '部门' },
  { value: 'SUB_DEPARTMENT', label: '分部' },
  { value: 'TEAM_GROUP', label: '班组' }
])

export const PERMISSION_GROUPS = Object.freeze([
  {
    key: 'task',
    label: '任务管理',
    options: [
      ['task.view', '查看'],
      ['task.create', '创建'],
      ['task.edit', '编辑/执行'],
      ['task.assign', '分派'],
      ['task.review', '审核'],
      ['task.export', '导出']
    ]
  },
  {
    key: 'equipment',
    label: '设备管理',
    options: [
      ['equipment.view', '查看'],
      ['equipment.create', '新增'],
      ['equipment.edit', '编辑'],
      ['equipment.import', '导入'],
      ['equipment.export', '导出'],
      ['equipment.qrcode', '二维码'],
      ['equipment.inventory', '盘点'],
      ['equipment.inspect', '点检'],
      ['equipment.repair', '维修'],
      ['equipment.maintain', '保养'],
      ['equipment.status.apply', '状态申请'],
      ['equipment.status.approve', '状态审批']
    ]
  },
  {
    key: 'report',
    label: '数据提报',
    options: [
      ['report.view', '查看'],
      ['report.submit', '提报'],
      ['report.transport.master.manage', '运输基础资料维护'],
      ['report.review', '审核'],
      ['report.correct', '纠正'],
      ['report.export', '导出'],
      ['report.schedule.manage', '计划维护'],
      ['report.daily.generate', '生产日报生成'],
      ['report.monthly.generate', '月报生成']
    ]
  },
  {
    key: 'contract',
    label: '合同管理',
    options: [
      ['contract.supplier.view', '供应商合同查看'],
      ['contract.supplier.manage', '供应商合同维护'],
      ['contract.supplier.import', '供应商合同导入'],
      ['contract.supplier.export', '供应商合同导出'],
      ['contract.expiry.view', '合同到期预警查看'],
      ['contract.expiry.export', '合同到期预警导出'],
      ['contract.settlement.view', '供应商结算费用查看'],
      ['contract.settlement.manage', '供应商结算费用维护'],
      ['contract.settlement.import', '供应商结算费用导入'],
      ['contract.settlement.export', '供应商结算费用导出']
    ]
  },
  {
    key: 'team',
    label: '团队管理',
    options: [
      ['member.view', '成员查看'],
      ['member.manage', '成员管理'],
      ['org.manage', '组织管理'],
      ['reporter.assign', '提报人分配']
    ]
  },
  {
    key: 'audit',
    label: '审计',
    options: [['audit.view', '审计查看']]
  }
].map((group) => Object.freeze({
  ...group,
  options: Object.freeze(group.options.map(([value, label]) => Object.freeze({ value, label })))
})))

export const PROJECT_ADMIN_DEFAULT_PERMISSIONS = Object.freeze([
  'member.view',
  'member.manage',
  'org.manage',
  'reporter.assign',
  'audit.view'
])

const membershipFields = Object.freeze([
  'orgUnitId',
  'role',
  'positionKey',
  'functionalRoleKeys',
  'permissionKeys',
  'status',
  'reason'
])

function pickDefined(source, fields) {
  return Object.fromEntries(
    fields
      .filter((field) => source[field] !== undefined)
      .map((field) => [field, Array.isArray(source[field]) ? [...source[field]] : source[field]])
  )
}

export function buildMemberCreatePayload(form) {
  return pickDefined(form, [
    'username',
    'password',
    'name',
    'phone',
    'email',
    ...membershipFields
  ])
}

export function buildMemberUpdatePayload(form) {
  return pickDefined(form, membershipFields)
}

export function buildOrgUnitPayload(form) {
  return pickDefined(form, [
    'parentId',
    'type',
    'code',
    'name',
    'status',
    'sortOrder',
    'reason'
  ])
}

export function buildOrgUnitTree(units = []) {
  const nodes = new Map(
    units.map((unit) => [String(unit._id), { ...unit, children: [] }])
  )
  const roots = []

  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(String(node.parentId)) : null
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }

  const sortNodes = (items) => {
    items.sort((left, right) => (
      (Number(left.sortOrder) || 0) - (Number(right.sortOrder) || 0) ||
      String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN') ||
      String(left._id).localeCompare(String(right._id))
    ))
    for (const item of items) sortNodes(item.children)
  }
  sortNodes(roots)
  return roots
}

export function reconcileExpandedOrgUnitIds(units = [], expandedIds = null) {
  const validIds = new Set(units.map((unit) => String(unit._id)))
  const rootIds = units
    .filter((unit) => Number(unit.level) === 1 || !unit.parentId)
    .map((unit) => String(unit._id))
  const preservedIds = expandedIds === null
    ? rootIds
    : Array.isArray(expandedIds)
    ? expandedIds.map(String).filter((id) => validIds.has(id))
    : []
  return [...new Set(preservedIds)]
}

export function canManageMembership({
  isTeamMode,
  isReadOnly,
  isSuperAdmin,
  membershipRole,
  permissionKeys = []
}, membership) {
  if (!isTeamMode || isReadOnly) return false
  if (!isSuperAdmin && !permissionKeys.includes('member.manage')) return false
  if (!isSuperAdmin && membershipRole !== MEMBERSHIP_ROLES.PROJECT_ADMIN) return false
  return isSuperAdmin || membership?.role !== MEMBERSHIP_ROLES.PROJECT_ADMIN
}

export function isModeAllowed(mode, allowedModes = []) {
  return !allowedModes.length || allowedModes.includes(mode)
}

export function managementErrorMessage(error, fallback = '操作失败') {
  const code = error?.response?.data?.code
  const messages = {
    USERNAME_EXISTS: '该用户名已被使用，用户名在全系统必须唯一',
    CODE_EXISTS: '该编码已被使用，请更换编码',
    MEMBERSHIP_EXISTS: '该用户已经属于当前团队',
    ATTENDANCE_REPORTER_EXISTS: '该分部已有一名有效考勤提报人，请先取消原提报人的职能角色',
    ATTENDANCE_REPORTER_ORG_REQUIRED: '考勤提报人只能指定到分部组织',
    ORG_UNIT_HAS_ACTIVE_DEPENDENCIES: '请先停用该组织下的成员和子组织',
    MANAGEMENT_CONCURRENT_UPDATE: '数据已被其他人修改，请刷新后重试',
    MANAGEMENT_RESOURCE_NOT_FOUND: '记录不存在或不属于当前团队'
  }
  return messages[code] || requestErrorMessage(error, fallback)
}
