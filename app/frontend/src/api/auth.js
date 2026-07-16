import request from '@/utils/request'

/**
 * 用户登录
 */
export function login(data) {
  return request({
    url: '/auth/login',
    method: 'post',
    data,
    contextScoped: false
  })
}

/**
 * 获取当前用户可进入的项目团队
 */
export function getAccessibleTeams() {
  return request({
    url: '/auth/teams',
    method: 'get'
  })
}

/**
 * 切换到指定团队。后端会撤销旧会话并返回新 token。
 */
export function switchTeam(teamId) {
  return request({
    url: '/auth/switch-team',
    method: 'post',
    data: { teamId }
  })
}

/**
 * 超级管理员返回跨团队只读上下文。
 */
export function enterGlobalReadOnly() {
  return request({
    url: '/auth/global-readonly',
    method: 'post'
  })
}

/**
 * 撤销当前服务端会话。
 */
export function logout() {
  return request({
    url: '/auth/logout',
    method: 'post'
  })
}

/**
 * 用户注册
 */
export function register(data) {
  return request({
    url: '/auth/register',
    method: 'post',
    data
  })
}

/**
 * 获取当前用户信息
 */
export function getCurrentUser() {
  return request({
    url: '/auth/me',
    method: 'get'
  })
}

/**
 * 修改密码
 */
export function changePassword(data) {
  return request({
    url: '/auth/change-password',
    method: 'post',
    data
  })
}

