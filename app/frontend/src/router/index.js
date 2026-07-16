import { createRouter, createWebHistory } from 'vue-router'
import { useUserStore } from '@/stores/user'

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
      path: '/',
      component: () => import('@/layouts/MainLayout.vue'),
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          redirect: '/dashboard'
        },
        {
          path: 'dashboard',
          name: 'Dashboard',
          component: () => import('@/views/Dashboard.vue'),
          meta: { title: '统计看板' }
        },
        {
          path: 'users',
          name: 'Users',
          component: () => import('@/views/users/UserList.vue'),
          meta: { title: '用户管理', requiresAdmin: true }
        },
        {
          path: 'tasks',
          name: 'Tasks',
          component: () => import('@/views/tasks/TaskList.vue'),
          meta: { title: '全部任务' }
        },
        {
          path: 'tasks/my',
          name: 'MyTasks',
          component: () => import('@/views/tasks/MyTasks.vue'),
          meta: { title: '我的任务' }
        },
        {
          path: 'tasks/board',
          name: 'TaskBoard',
          component: () => import('@/views/tasks/TaskBoard.vue'),
          meta: { title: '任务看板' }
        },
        {
          path: 'tasks/create',
          name: 'CreateTask',
          component: () => import('@/views/tasks/TaskForm.vue'),
          meta: { title: '创建任务', requiresAdmin: true }
        },
        {
          path: 'tasks/:id/edit',
          name: 'EditTask',
          component: () => import('@/views/tasks/TaskForm.vue'),
          meta: { title: '编辑任务', requiresAdmin: true }
        },
        {
          path: 'tasks/:id',
          name: 'TaskDetail',
          component: () => import('@/views/tasks/TaskDetail.vue'),
          meta: { title: '任务详情' }
        },
        {
          path: 'extensions',
          name: 'Extensions',
          component: () => import('@/views/extensions/ExtensionList.vue'),
          meta: { title: '延期管理', requiresAdmin: true }
        },
        {
          path: 'messages',
          name: 'Messages',
          component: () => import('@/views/messages/MessageList.vue'),
          meta: { title: '消息中心' }
        },
        {
          path: 'profile',
          name: 'Profile',
          component: () => import('@/views/profile/ProfileView.vue'),
          meta: { title: '个人中心' }
        }
      ]
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'NotFound',
      component: () => import('@/views/NotFound.vue')
    }
  ]
})

// 路由守卫
router.beforeEach((to, from, next) => {
  const userStore = useUserStore()
  const token = localStorage.getItem('token')

  // 需要登录的页面
  if (to.meta.requiresAuth !== false) {
    if (!token) {
      next('/login')
      return
    }

    // 需要管理员权限
    if (to.meta.requiresAdmin && !userStore.isAdmin) {
      ElMessage.error('需要管理员权限')
      next(from.path || '/')
      return
    }
  }

  // 已登录访问登录页，跳转到首页
  if (to.path === '/login' && token) {
    next('/')
    return
  }

  next()
})

export default router

