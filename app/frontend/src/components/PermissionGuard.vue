<template>
  <slot v-if="allowed" :allowed="true" />
  <slot v-else-if="$slots.fallback" name="fallback" :allowed="false" />
</template>

<script setup>
import { computed } from 'vue'
import { useSessionStore } from '@/stores/session'

const props = defineProps({
  permission: {
    type: [String, Array],
    default: () => []
  },
  match: {
    type: String,
    default: 'all',
    validator: (value) => ['all', 'any'].includes(value)
  },
  write: {
    type: Boolean,
    default: false
  },
  teamRequired: {
    type: Boolean,
    default: false
  },
  superAdminOnly: {
    type: Boolean,
    default: false
  },
  teamAdminOnly: {
    type: Boolean,
    default: false
  },
  modes: {
    type: Array,
    default: () => []
  }
})

const session = useSessionStore()
const allowed = computed(() => {
  if (props.superAdminOnly && !session.isSuperAdmin) return false
  if (
    props.teamAdminOnly &&
    !session.isSuperAdmin &&
    session.context.membership?.role !== 'PROJECT_ADMIN'
  ) return false
  if (props.modes.length && !props.modes.includes(session.mode)) return false
  return session.can(props.permission, {
    match: props.match,
    write: props.write,
    teamRequired: props.teamRequired
  })
})
</script>
