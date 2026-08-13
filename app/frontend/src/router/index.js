import { createRouter, createWebHistory } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useSessionStore, SESSION_MODES } from '@/stores/session'
import { isStaleContextResponseError, readAuthToken } from '@/utils/request'
import { isModeAllowed } from '@/utils/teamManagement'
import { isTaskLeadershipCandidateContext } from '@/utils/taskPolicy'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'Login',
      component: () => import('@/views/Login.vue'),
      meta: { requiresAuth: false }
    },
    {
      path: '/team-select',
      name: 'TeamSelect',
      component: () => import('@/views/TeamSelect.vue'),
      meta: { requiresAuth: true, teamRequired: false, readOnlyAllowed: true }
    },
    {
      path: '/',
      component: () => import('@/layouts/MainLayout.vue'),
      meta: { requiresAuth: true },
      children: [
        { path: '', redirect: '/dashboard' },
        {
          path: 'dashboard',
          name: 'Dashboard',
          component: () => import('@/views/Dashboard.vue'),
          meta: { title: '统计看板', teamRequired: true, readOnlyAllowed: true }
        },
        {
          path: 'users',
          name: 'Users',
          component: () => import('@/views/users/UserList.vue'),
          meta: {
            title: '团队成员',
            permission: 'member.view',
            teamRequired: true,
            readOnlyAllowed: false,
            allowedModes: [SESSION_MODES.TEAM]
          }
        },
        {
          path: 'organization',
          name: 'Organization',
          component: () => import('@/views/organization/OrgUnitManagement.vue'),
          meta: {
            title: '组织架构',
            permission: 'org.manage',
            teamAdminRequired: true,
            teamRequired: true,
            readOnlyAllowed: false,
            allowedModes: [SESSION_MODES.TEAM]
          }
        },
        {
          path: 'team-control',
          name: 'TeamControl',
          component: () => import('@/views/teams/TeamControl.vue'),
          meta: {
            title: '项目团队控制',
            superAdminRequired: true,
            teamRequired: false,
            readOnlyAllowed: true,
            allowedModes: [SESSION_MODES.GLOBAL_READ_ONLY, SESSION_MODES.TEAM]
          }
        },
        {
          path: 'equipment',
          name: 'Equipment',
          component: () => import('@/views/equipment/EquipmentList.vue'),
          meta: {
            title: '设备台账',
            permission: 'equipment.view',
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'equipment/categories',
          name: 'EquipmentCategories',
          component: () => import('@/views/equipment/EquipmentCategories.vue'),
          meta: {
            title: '设备分类',
            permission: 'equipment.view',
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'equipment/rules',
          name: 'EquipmentRules',
          component: () => import('@/views/equipment/EquipmentRules.vue'),
          meta: {
            title: '点检与保养规则',
            permission: 'equipment.view',
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'equipment/routines',
          name: 'EquipmentRoutineWorkbench',
          component: () => import('@/views/equipment/EquipmentRoutineWorkbench.vue'),
          meta: {
            title: '点检保养工作台',
            permission: 'equipment.view',
            teamRequired: true,
            readOnlyAllowed: true,
            reuseQueryKeys: ['tab', 'planId', 'exceptionId']
          }
        },
        {
          path: 'equipment/inventories',
          name: 'EquipmentInventories',
          component: () => import('@/views/equipment/EquipmentInventoryList.vue'),
          meta: {
            title: '设备盘点',
            permission: 'equipment.inventory',
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'equipment/inventories/:inventorySessionId',
          name: 'EquipmentInventoryDetail',
          component: () => import('@/views/equipment/EquipmentInventoryDetail.vue'),
          meta: {
            title: '盘点批次详情',
            activeMenu: '/equipment/inventories',
            permission: 'equipment.inventory',
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'equipment/repairs',
          name: 'EquipmentRepairs',
          component: () => import('@/views/equipment/EquipmentRepairs.vue'),
          meta: {
            title: '设备维修',
            permission: 'equipment.view',
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'equipment/repairs/:repairId',
          name: 'EquipmentRepairDetail',
          component: () => import('@/views/equipment/EquipmentRepairDetail.vue'),
          meta: {
            title: '维修单详情',
            activeMenu: '/equipment/repairs',
            permission: 'equipment.view',
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'equipment/status-applications',
          name: 'EquipmentStatusApplications',
          component: () => import('@/views/equipment/EquipmentStatusApplications.vue'),
          meta: {
            title: '设备状态申请',
            permission: 'equipment.view',
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'equipment/status-applications/:applicationId',
          name: 'EquipmentStatusApplicationDetail',
          component: () => import('@/views/equipment/EquipmentStatusApplicationDetail.vue'),
          meta: {
            title: '设备状态申请详情',
            activeMenu: '/equipment/status-applications',
            permission: 'equipment.view',
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'equipment/:id',
          name: 'EquipmentDetail',
          component: () => import('@/views/equipment/EquipmentDetail.vue'),
          meta: {
            title: '设备详情',
            permission: 'equipment.view',
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'reporting/transport',
          name: 'TransportRecords',
          component: () => import('@/views/reporting/TransportRecords.vue'),
          meta: {
            title: '运输提报',
            permission: 'report.view',
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'contracts/suppliers',
          name: 'SupplierContracts',
          component: () => import('@/views/contracts/SupplierContracts.vue'),
          meta: {
            title: '供应商合同管理',
            permission: 'contract.supplier.view',
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'contracts/suppliers/:supplierId',
          name: 'SupplierContractDetail',
          component: () => import('@/views/contracts/SupplierContractDetail.vue'),
          meta: {
            title: '供应商合同详情',
            activeMenu: '/contracts/suppliers',
            permission: 'contract.supplier.view',
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'contracts/expiry-alerts',
          name: 'ContractExpiryAlerts',
          component: () => import('@/views/contracts/ContractExpiryAlerts.vue'),
          meta: {
            title: '供应商合同到期预警',
            permission: 'contract.expiry.view',
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'contracts/settlements',
          name: 'SupplierSettlementFees',
          component: () => import('@/views/contracts/SupplierSettlementFees.vue'),
          meta: {
            title: '供应商结算费用',
            permission: 'contract.settlement.view',
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'reporting/transport/:id',
          name: 'TransportRecordDetail',
          component: () => import('@/views/reporting/TransportRecordDetail.vue'),
          meta: {
            title: '运输提报详情',
            activeMenu: '/reporting/transport',
            permission: 'report.view',
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'reporting/production',
          name: 'ProductionSchedules',
          component: () => import('@/views/reporting/ProductionSchedules.vue'),
          meta: {
            title: '生产排产',
            permission: 'report.view',
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'reporting/attendance',
          name: 'AttendanceReports',
          component: () => import('@/views/reporting/AttendanceReports.vue'),
          meta: {
            title: '出勤日报',
            permission: 'report.view',
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'reporting/daily-report',
          name: 'GeneratedDailyReports',
          component: () => import('@/views/reporting/GeneratedDailyReports.vue'),
          meta: {
            title: '生产日报',
            permission: 'report.view',
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'import-templates',
          name: 'ImportTemplateLibrary',
          component: () => import('@/views/templates/ImportTemplateLibrary.vue'),
          meta: {
            title: '模板下载',
            permission: [
              'equipment.view',
              'equipment.import',
              'contract.supplier.view',
              'contract.supplier.import',
              'contract.settlement.view',
              'contract.settlement.import'
            ],
            permissionMatch: 'any',
            teamRequired: true,
            readOnlyAllowed: false,
            allowedModes: [SESSION_MODES.TEAM]
          }
        },
        {
          path: 'tasks',
          name: 'Tasks',
          component: () => import('@/views/tasks/TaskList.vue'),
          meta: {
            title: '全部任务',
            permission: 'task.view',
            taskLeadershipCandidateAllowed: true,
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'tasks/my',
          name: 'MyTasks',
          component: () => import('@/views/tasks/MyTasks.vue'),
          meta: { title: '我的任务', permission: 'task.view', teamRequired: true, readOnlyAllowed: true }
        },
        {
          path: 'tasks/board',
          name: 'TaskBoard',
          component: () => import('@/views/tasks/TaskBoard.vue'),
          meta: { title: '任务看板', permission: 'task.view', teamRequired: true, readOnlyAllowed: true }
        },
        {
          path: 'tasks/create',
          name: 'CreateTask',
          component: () => import('@/views/tasks/TaskForm.vue'),
          meta: {
            title: '创建任务',
            permission: 'task.create',
            taskLeadershipCandidateAllowed: true,
            teamRequired: true,
            readOnlyAllowed: false
          }
        },
        {
          path: 'tasks/:id/edit',
          name: 'EditTask',
          component: () => import('@/views/tasks/TaskForm.vue'),
          meta: {
            title: '编辑任务',
            permission: 'task.edit',
            taskLeadershipCandidateAllowed: true,
            teamRequired: true,
            readOnlyAllowed: false
          }
        },
        {
          path: 'tasks/:id',
          name: 'TaskDetail',
          component: () => import('@/views/tasks/TaskDetail.vue'),
          meta: {
            title: '任务详情',
            permission: 'task.view',
            taskLeadershipCandidateAllowed: true,
            teamRequired: true,
            readOnlyAllowed: true
          }
        },
        {
          path: 'extensions',
          name: 'Extensions',
          component: () => import('@/views/extensions/ExtensionList.vue'),
          meta: {
            title: '延期管理',
            permission: 'task.review',
            taskLeadershipCandidateAllowed: true,
            teamRequired: true,
            readOnlyAllowed: false
          }
        },
        {
          path: 'audit-logs',
          name: 'AuditLogs',
          component: () => import('@/views/audit/AuditLogs.vue'),
          meta: {
            title: '审计日志',
            permission: 'audit.view',
            teamAdminRequired: true,
            teamRequired: true,
            readOnlyAllowed: true,
            allowedModes: [SESSION_MODES.GLOBAL_READ_ONLY, SESSION_MODES.TEAM]
          }
        },
        {
          path: 'messages',
          name: 'Messages',
          component: () => import('@/views/messages/MessageList.vue'),
          meta: { title: '消息中心', teamRequired: true, readOnlyAllowed: true }
        },
        {
          path: 'profile',
          name: 'Profile',
          component: () => import('@/views/profile/ProfileView.vue'),
          meta: { title: '个人中心', teamRequired: false, readOnlyAllowed: true }
        }
      ]
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'NotFound',
      component: () => import('@/views/NotFound.vue'),
      meta: { requiresAuth: true, readOnlyAllowed: true }
    }
  ]
})

router.beforeEach(async (to) => {
  const session = useSessionStore()
  const token = readAuthToken()

  if (!token) {
    if (session.token) session.clearLocalSession('missing-token')
    if (to.meta.requiresAuth === false) return true
    return { name: 'Login', query: { redirect: to.fullPath } }
  }

  try {
    await session.bootstrap()
  } catch (error) {
    if (isStaleContextResponseError(error) && readAuthToken()) {
      try {
        await session.bootstrap({ force: true })
      } catch {
        return false
      }
    } else if (readAuthToken()) {
      ElMessage.error('暂时无法验证登录状态，请稍后重试')
      return false
    } else {
      return { name: 'Login', query: { redirect: to.fullPath } }
    }
  }

  if (to.name === 'Login') {
    return session.isTeamSelection ? { name: 'TeamSelect' } : { name: 'Dashboard' }
  }

  if (session.mode === SESSION_MODES.TEAM_SELECTION && to.name !== 'TeamSelect') {
    return { name: 'TeamSelect' }
  }

  if (to.meta.superAdminRequired && !session.isSuperAdmin) {
    ElMessage.error('该功能仅限超级管理员访问')
    return { name: 'Dashboard' }
  }

  if (
    to.meta.teamAdminRequired &&
    !session.isSuperAdmin &&
    session.context.membership?.role !== 'PROJECT_ADMIN'
  ) {
    ElMessage.error('该功能仅限项目管理员访问')
    return { name: 'Dashboard' }
  }

  if (to.meta.readOnlyAllowed === false && session.isReadOnly) {
    ElMessage.warning('当前为只读模式，请先进入具体团队')
    return { name: 'Dashboard' }
  }

  if (
    to.meta.teamRequired &&
    session.mode !== SESSION_MODES.TEAM &&
    !(session.isGlobalReadOnly && to.meta.readOnlyAllowed === true)
  ) {
    return { name: 'TeamSelect' }
  }

  if (!isModeAllowed(session.mode, to.meta.allowedModes)) {
    ElMessage.warning('当前登录模式不能访问该功能')
    return session.isTeamSelection ? { name: 'TeamSelect' } : { name: 'Dashboard' }
  }

  const taskLeadershipCandidateAllowed = (
    to.meta.taskLeadershipCandidateAllowed === true &&
    isTaskLeadershipCandidateContext(session.context)
  )
  if (
    to.meta.permission &&
    !session.hasPermission(to.meta.permission, to.meta.permissionMatch) &&
    !taskLeadershipCandidateAllowed
  ) {
    ElMessage.error('没有访问该功能的权限')
    return { name: 'Dashboard' }
  }

  return true
})

export default router
