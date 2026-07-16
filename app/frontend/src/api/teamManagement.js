import request from '@/utils/request'

export function getTeamMembers(params) {
  return request({
    url: '/team-members',
    method: 'get',
    params
  })
}

export function createTeamMember(data) {
  return request({
    url: '/team-members',
    method: 'post',
    data
  })
}

export function updateTeamMember(membershipId, data) {
  return request({
    url: `/team-members/${membershipId}`,
    method: 'patch',
    data
  })
}

export function disableTeamMember(membershipId, reason) {
  return request({
    url: `/team-members/${membershipId}`,
    method: 'delete',
    data: { reason: reason || null }
  })
}

export function getOrgUnits(params) {
  return request({
    url: '/org-units',
    method: 'get',
    params
  })
}

export function createOrgUnit(data) {
  return request({
    url: '/org-units',
    method: 'post',
    data
  })
}

export function updateOrgUnit(orgUnitId, data) {
  return request({
    url: `/org-units/${orgUnitId}`,
    method: 'patch',
    data
  })
}

export function getTeams(params) {
  return request({
    url: '/teams',
    method: 'get',
    params
  })
}

export function createTeam(data) {
  return request({
    url: '/teams',
    method: 'post',
    data
  })
}

export function enableTeam(teamId, data = {}) {
  return request({
    url: `/teams/${teamId}/enable`,
    method: 'post',
    data
  })
}

export function disableTeam(teamId, data = {}) {
  return request({
    url: `/teams/${teamId}/status`,
    method: 'patch',
    data: { ...data, status: 'DISABLED' }
  })
}
