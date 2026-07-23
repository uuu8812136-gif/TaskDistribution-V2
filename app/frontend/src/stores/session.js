import { defineStore } from 'pinia'
import {
  enterGlobalReadOnly as enterGlobalReadOnlyRequest,
  getAccessibleTeams,
  getCurrentUser,
  login as loginRequest,
  logout as logoutRequest,
  switchTeam as switchTeamRequest
} from '@/api/auth'
import { useMessageStore } from '@/stores/message'
import {
  advanceRequestContextEpoch,
  clearAuthToken,
  getRequestContextEpoch,
  isStaleContextResponseError,
  readAuthToken,
  replaceAuthToken
} from '@/utils/request'
import {
  SESSION_MODES,
  canUsePermission,
  createEmptyContext,
  hasPermission,
  normalizeSessionContext,
  normalizeSessionMode
} from '@/utils/sessionPolicy'

let bootstrapPromise = null

function notifyContextChanged(epoch, reason) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent('auth-context-changed', { detail: { epoch, reason } })
  )
}

export const useSessionStore = defineStore('session', {
  state: () => ({
    token: readAuthToken(),
    user: null,
    teams: [],
    mode: null,
    activeTeamId: null,
    context: createEmptyContext(),
    contextEpoch: getRequestContextEpoch(),
    bootstrapStatus: 'idle',
    bootstrappedToken: ''
  }),

  getters: {
    isLoggedIn: (state) => Boolean(state.token),
    isReady: (state) => state.bootstrapStatus === 'ready',
    isSuperAdmin: (state) => state.context.isSuperAdmin === true || state.user?.isSuperAdmin === true,
    isTeamSelection: (state) => state.mode === SESSION_MODES.TEAM_SELECTION,
    isTeamMode: (state) => state.mode === SESSION_MODES.TEAM,
    isGlobalReadOnly: (state) => state.mode === SESSION_MODES.GLOBAL_READ_ONLY,
    isReadOnly: (state) => state.context.readOnly === true,
    canAccessBusiness: (state) => state.context.canAccessBusiness === true,
    permissionKeys: (state) => state.context.permissionKeys || [],
    moduleDataScopes: (state) => state.context.moduleDataScopes || {},
    activeTeam: (state) => state.teams.find((team) => team._id === state.activeTeamId) || state.context.team || null
  },

  actions: {
    hasPermission(permission, match = 'all') {
      return hasPermission(this.permissionKeys, permission, match)
    },

    can(permission, options = {}) {
      return canUsePermission(this.context, permission, options)
    },

    clearContextCaches(reason) {
      const messageStore = useMessageStore()
      messageStore.$reset()
      notifyContextChanged(this.contextEpoch, reason)
    },

    advanceContext(reason) {
      bootstrapPromise = null
      this.contextEpoch = advanceRequestContextEpoch()
      this.clearContextCaches(reason)
    },

    applyContext(context, fallback = {}) {
      const normalized = normalizeSessionContext(context, fallback)
      this.context = normalized
      this.mode = normalized.mode
      this.activeTeamId = normalized.activeTeamId
    },

    commitRotatedSession(payload, reason, { keepTeams = true } = {}) {
      if (!payload?.token) throw new TypeError('登录响应缺少身份凭证')

      replaceAuthToken(payload.token)
      this.token = payload.token
      this.user = payload.user || this.user
      if (!keepTeams || Array.isArray(payload.teams)) this.teams = payload.teams || []
      this.mode = normalizeSessionMode(payload.mode)
      this.activeTeamId = payload.activeTeamId || null
      this.context = createEmptyContext(this.mode, this.activeTeamId)
      this.bootstrapStatus = 'idle'
      this.bootstrappedToken = ''
      this.advanceContext(reason)
    },

    async login(credentials) {
      const payload = await loginRequest(credentials)
      this.commitRotatedSession(payload, 'login', { keepTeams: false })
      await this.bootstrap({ force: true })
      return payload
    },

    async refreshTeams() {
      const payload = await getAccessibleTeams()
      this.teams = Array.isArray(payload?.teams) ? payload.teams : []
      return this.teams
    },

    async bootstrap({ force = false } = {}) {
      this.token = readAuthToken()
      if (!this.token) {
        this.clearLocalSession('missing-token')
        throw new Error('登录凭证不存在，请重新登录')
      }

      if (
        !force &&
        this.bootstrapStatus === 'ready' &&
        this.bootstrappedToken === this.token
      ) {
        return { user: this.user, context: this.context }
      }
      if (!force && bootstrapPromise) return bootstrapPromise

      const tokenAtStart = this.token
      const work = (async () => {
        this.bootstrapStatus = 'loading'
        try {
          const payload = await getCurrentUser()
          if (this.token !== tokenAtStart) throw new Error('登录状态已变化，请重新加载')

          this.user = payload.user
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
          }
          return payload
        } catch (error) {
          if (
            !isStaleContextResponseError(error) &&
            this.token &&
            this.token === tokenAtStart
          ) {
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

    async switchTeam(teamId) {
      if (!teamId || teamId === this.activeTeamId && this.isTeamMode) return
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
      clearAuthToken()
      this.token = ''
      this.user = null
      this.teams = []
      this.mode = null
      this.activeTeamId = null
      this.context = createEmptyContext()
      this.bootstrapStatus = 'idle'
      this.bootstrappedToken = ''
      this.advanceContext(reason)
    },

    handleUnauthorized() {
      this.clearLocalSession('unauthorized')
    },

    async logout() {
      try {
        if (this.token) await logoutRequest()
      } finally {
        this.clearLocalSession('logout')
      }
    }
  }
})

export { SESSION_MODES }
