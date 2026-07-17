import { defineStore } from 'pinia'
import {
  enterGlobalReadOnly as enterGlobalReadOnlyRequest,
  getAccessibleTeams,
  getCurrentUser,
  getLoginTeams as getLoginTeamsRequest,
  login as loginRequest,
  logout as logoutRequest,
  switchTeam as switchTeamRequest
} from '@/api/index.js'
import { useMessageStore } from '@/stores/message.js'
import {
  advanceRequestContextEpoch,
  getRequestContextEpoch,
  isStaleContextResponseError
} from '@/utils/request.js'
import {
  clearAuthToken,
  clearLegacyCredentialCaches,
  clearScopedCaches,
  clearSessionSnapshot,
  readAuthToken,
  readSessionSnapshot,
  replaceAuthToken,
  toCacheIdentity,
  writeSessionSnapshot
} from '@/utils/sessionRuntime.js'
import {
  SESSION_MODES,
  canUsePermission,
  createEmptyContext,
  hasPermission,
  normalizeSessionContext,
  normalizeSessionMode
} from '@/utils/sessionPolicy.js'
import { normalizeLoginTeams } from '@/utils/loginTeams.js'

let bootstrapPromise = null

function restoredState() {
  const snapshot = readSessionSnapshot() || {}
  return {
    token: readAuthToken(),
    userInfo: snapshot.user || null,
    teams: Array.isArray(snapshot.teams) ? snapshot.teams : [],
    mode: normalizeSessionMode(snapshot.mode),
    activeTeamId: snapshot.activeTeamId || null,
    context: normalizeSessionContext(snapshot.context, snapshot),
    contextEpoch: getRequestContextEpoch()
  }
}

export const useUserStore = defineStore('user', {
  state: () => ({
    ...restoredState(),
    bootstrapStatus: 'idle',
    bootstrappedToken: ''
  }),

  getters: {
    isLogin: (state) => Boolean(state.token),
    isReady: (state) => state.bootstrapStatus === 'ready',
    isSuperAdmin: (state) => state.context.isSuperAdmin === true || state.userInfo?.isSuperAdmin === true,
    isTeamSelection: (state) => state.mode === SESSION_MODES.TEAM_SELECTION,
    isTeamMode: (state) => state.mode === SESSION_MODES.TEAM,
    isGlobalReadOnly: (state) => state.mode === SESSION_MODES.GLOBAL_READ_ONLY,
    isReadOnly: (state) => state.context.readOnly === true,
    canAccessBusiness: (state) => state.context.canAccessBusiness === true,
    permissionKeys: (state) => state.context.permissionKeys || [],
    moduleDataScopes: (state) => state.context.moduleDataScopes || {},
    activeTeam: (state) => (
      state.teams.find((team) => team._id === state.activeTeamId) || state.context.team || null
    ),
    cacheIdentity: (state) => toCacheIdentity(
      state.userInfo?._id,
      state.activeTeamId,
      state.mode
    ),
    isAdmin: (state) => (
      state.userInfo?.isSuperAdmin === true ||
      state.context.membership?.role === 'PROJECT_ADMIN'
    )
  },

  actions: {
    persistSnapshot() {
      writeSessionSnapshot({
        user: this.userInfo,
        teams: this.teams,
        mode: this.mode,
        activeTeamId: this.activeTeamId,
        context: this.context
      })
    },

    hasPermission(permission, match = 'all') {
      return hasPermission(this.permissionKeys, permission, match)
    },

    can(permission, options = {}) {
      return canUsePermission(this.context, permission, options)
    },

    resetContextCaches(reason, identity) {
      if (identity) clearScopedCaches(identity)
      const messageStore = useMessageStore()
      messageStore.resetContext()
      uni.$emit('auth-context-changed', {
        epoch: this.contextEpoch,
        reason
      })
    },

    beginContextTransition(reason) {
      const previousIdentity = this.cacheIdentity
      bootstrapPromise = null
      this.contextEpoch = advanceRequestContextEpoch()
      this.resetContextCaches(reason, previousIdentity)
    },

    applyContext(context, fallback = {}) {
      this.context = normalizeSessionContext(context, fallback)
      this.mode = this.context.mode
      this.activeTeamId = this.context.activeTeamId
      this.persistSnapshot()
    },

    commitRotatedSession(payload, reason, { replaceTeams = false } = {}) {
      if (!payload?.token) throw new TypeError('认证响应未返回 token')

      this.beginContextTransition(reason)
      replaceAuthToken(payload.token)
      this.token = payload.token
      this.userInfo = payload.user || this.userInfo
      if (replaceTeams || Array.isArray(payload.teams)) this.teams = payload.teams || []
      this.mode = normalizeSessionMode(payload.mode)
      this.activeTeamId = payload.activeTeamId || null
      this.context = createEmptyContext(this.mode, this.activeTeamId)
      this.bootstrapStatus = 'idle'
      this.bootstrappedToken = ''
      this.persistSnapshot()
    },

    async login(credentials) {
      clearLegacyCredentialCaches()
      const payload = await loginRequest(credentials)
      this.commitRotatedSession(payload, 'login', { replaceTeams: true })
      await this.bootstrap({ force: true })
      return payload
    },

    async loadLoginTeams() {
      const payload = await getLoginTeamsRequest()
      return normalizeLoginTeams(payload?.teams)
    },

    async refreshTeams() {
      const payload = await getAccessibleTeams()
      this.teams = Array.isArray(payload?.teams) ? payload.teams : []
      this.persistSnapshot()
      return this.teams
    },

    async bootstrap({ force = false } = {}) {
      this.token = readAuthToken()
      if (!this.token) {
        this.clearLocalSession('missing-token')
        throw new Error('Authentication token is missing')
      }

      if (!force && this.bootstrapStatus === 'ready' && this.bootstrappedToken === this.token) {
        return { user: this.userInfo, context: this.context }
      }
      if (!force && bootstrapPromise) return bootstrapPromise

      const tokenAtStart = this.token
      const work = (async () => {
        this.bootstrapStatus = 'loading'
        try {
          const payload = await getCurrentUser()
          if (this.token !== tokenAtStart) throw new Error('Authentication context changed while loading')

          this.userInfo = payload.user
          this.applyContext(payload.context, {
            mode: this.mode,
            activeTeamId: this.activeTeamId
          })
          this.bootstrappedToken = tokenAtStart
          this.bootstrapStatus = 'ready'
          try {
            await this.refreshTeams()
          } catch (error) {
            if (isStaleContextResponseError(error)) throw error
            console.error('刷新可访问团队失败:', error)
          }
          return payload
        } catch (error) {
          if (!isStaleContextResponseError(error) && this.token === tokenAtStart) {
            this.bootstrapStatus = 'error'
          }
          throw error
        }
      })()

      bootstrapPromise = work
      try {
        return await work
      } finally {
        if (bootstrapPromise === work) bootstrapPromise = null
      }
    },

    async fetchUserInfo() {
      const payload = await this.bootstrap({ force: true })
      return payload.user
    },

    async switchTeam(teamId) {
      if (!teamId || (this.isTeamMode && teamId === this.activeTeamId)) return
      const payload = await switchTeamRequest(teamId)
      this.commitRotatedSession(payload, 'team-switch')
      await this.bootstrap({ force: true })
    },

    async enterGlobalReadOnly() {
      if (this.isGlobalReadOnly) return
      const payload = await enterGlobalReadOnlyRequest()
      this.commitRotatedSession(payload, 'global-readonly')
      await this.bootstrap({ force: true })
    },

    clearLocalSession(reason = 'logout') {
      this.beginContextTransition(reason)
      clearScopedCaches()
      clearAuthToken()
      clearSessionSnapshot()
      clearLegacyCredentialCaches()
      this.token = ''
      this.userInfo = null
      this.teams = []
      this.mode = null
      this.activeTeamId = null
      this.context = createEmptyContext()
      this.bootstrapStatus = 'idle'
      this.bootstrappedToken = ''
    },

    handleUnauthorized() {
      if (!this.token && !readAuthToken()) return
      this.clearLocalSession('unauthorized')
      uni.showToast({ title: '登录已过期，请重新登录', icon: 'none', duration: 1500 })
      setTimeout(() => uni.reLaunch({ url: '/pages/login/index' }), 300)
    },

    async logout() {
      try {
        if (this.token) await logoutRequest()
      } finally {
        this.clearLocalSession('logout')
        uni.reLaunch({ url: '/pages/login/index' })
      }
    }
  }
})

export { SESSION_MODES }
