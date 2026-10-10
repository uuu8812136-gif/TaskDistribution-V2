export function membershipOrgUnitId(user) {
	const value = user?.membership?.orgUnitId
	if (typeof value === 'string') return value
	return value && typeof value._id === 'string' ? value._id : ''
}

export function buildTaskOrgUnitOptions(users = []) {
	const options = new Map()
	for (const user of users) {
		const orgUnitId = membershipOrgUnitId(user)
		if (!orgUnitId || options.has(orgUnitId)) continue
		options.set(orgUnitId, {
			value: orgUnitId,
			label: user.department || `组织 ${orgUnitId.slice(-6)}`
		})
	}
	return [...options.values()].sort((left, right) => (
		left.label.localeCompare(right.label, 'zh-CN')
	))
}

export function filterTaskParticipants(users = [], orgUnitId, teamScope) {
	// Assignment candidates are resolved by the backend assignable-users API,
	// which already restricts members to the task organization subtree.
	return users
}
