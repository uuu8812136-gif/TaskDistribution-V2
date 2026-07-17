const DEFAULT_TEAM_CODE = 'GEARBOX_LOGISTICS'

export function normalizeLoginTeams(teams) {
  if (!Array.isArray(teams)) return []

  const seenIds = new Set()
  return teams.reduce((result, team) => {
    const id = typeof team?._id === 'string' ? team._id.trim() : ''
    const name = typeof team?.name === 'string' ? team.name.trim() : ''
    if (!id || !name || seenIds.has(id)) return result

    seenIds.add(id)
    result.push({
      _id: id,
      code: typeof team.code === 'string' ? team.code.trim() : '',
      name
    })
    return result
  }, [])
}

export function defaultLoginTeamId(teams) {
  if (!Array.isArray(teams) || teams.length === 0) return ''
  return teams.find((team) => team.code === DEFAULT_TEAM_CODE)?._id || teams[0]._id
}
