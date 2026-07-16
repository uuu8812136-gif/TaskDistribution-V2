<template>
  <div v-if="session.isGlobalReadOnly" class="readonly-banner" role="status">
    <div class="banner-message">
      <el-icon><View /></el-icon>
      <strong>全局只读</strong>
      <span>当前可跨团队查看数据，进入具体团队后方可修改。</span>
    </div>
    <el-button type="warning" plain size="small" @click="router.push({ name: 'TeamSelect' })">
      选择团队
      <el-icon class="el-icon--right"><ArrowRight /></el-icon>
    </el-button>
  </div>
</template>

<script setup>
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'

const router = useRouter()
const session = useSessionStore()
</script>

<style scoped lang="scss">
.readonly-banner {
  min-height: 40px;
  padding: 6px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  color: #7a4b00;
  background: #fff7e6;
  border-bottom: 1px solid #f3d19e;
}

.banner-message {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.el-button {
  flex: 0 0 auto;
}

@media (max-width: 720px) {
  .readonly-banner {
    align-items: flex-start;
    padding-inline: 12px;
  }

  .banner-message {
    flex-wrap: wrap;
  }
}
</style>
