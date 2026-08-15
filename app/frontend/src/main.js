import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

import App from './App.vue'
import router from './router'
import { useSessionStore } from './stores/session'
import { safeInternalRedirect } from './utils/internalRedirect'
import { setUnauthorizedHandler } from './utils/request'
import './assets/styles/main.scss'

const app = createApp(App)
const pinia = createPinia()

// 注册所有 Element Plus 图标
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(pinia)

const sessionStore = useSessionStore(pinia)
setUnauthorizedHandler(() => {
  const currentRoute = router.currentRoute.value
  const redirect = safeInternalRedirect(
    currentRoute.name === 'TeamSelect'
      ? currentRoute.query.redirect
      : currentRoute.fullPath
  )
  sessionStore.handleUnauthorized()
  if (currentRoute.path !== '/login') {
    router.replace({
      name: 'Login',
      ...(redirect ? { query: { redirect } } : {})
    })
  }
})

app.use(router)
app.use(ElementPlus, { locale: zhCn })

app.mount('#app')

