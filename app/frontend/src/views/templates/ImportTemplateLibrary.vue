<template>
  <div class="template-library-page">
    <header class="page-heading">
      <div>
        <h1>模板下载</h1>
        <p>集中下载各模块当前使用的标准导入模板</p>
      </div>
      <el-tooltip content="刷新" placement="top">
        <el-button circle :loading="loading" aria-label="刷新模板清单" @click="loadTemplates">
          <el-icon><Refresh /></el-icon>
        </el-button>
      </el-tooltip>
    </header>

    <section class="toolbar template-toolbar" aria-label="模板筛选">
      <el-input
        v-model="keyword"
        clearable
        class="keyword-input"
        placeholder="搜索模板名称、用途或导入入口"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-select v-model="moduleFilter" clearable class="module-select" placeholder="全部模块">
        <el-option v-for="moduleName in moduleOptions" :key="moduleName" :label="moduleName" :value="moduleName" />
      </el-select>
      <span class="result-count">{{ filteredTemplates.length }} 个模板</span>
    </section>

    <el-alert
      v-if="loadError"
      :title="loadError"
      type="error"
      :closable="false"
      show-icon
      class="state-alert"
    >
      <template #default>
        <el-button text type="primary" @click="loadTemplates">重新加载</el-button>
      </template>
    </el-alert>

    <section v-else class="table-shell desktop-template-list">
      <el-table
        v-loading="loading"
        :data="filteredTemplates"
        row-key="id"
        stripe
        :empty-text="loading ? '正在加载模板' : emptyText"
      >
        <el-table-column label="模板名称" min-width="210">
          <template #default="{ row }">
            <div class="template-name">
              <el-icon><Document /></el-icon>
              <div>
                <strong>{{ row.name }}</strong>
                <span>{{ row.fileName }}</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="module" label="所属模块" min-width="130" />
        <el-table-column prop="description" label="用途" min-width="260" />
        <el-table-column prop="importEntry" label="适用导入入口" min-width="210" />
        <el-table-column label="格式" width="86" align="center">
          <template #default="{ row }">
            <el-tag effect="plain" type="success">{{ formatLabel(row.format) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="112" align="right">
          <template #default="{ row }">
            <el-button
              type="primary"
              :icon="Download"
              :loading="downloadingIds.has(row.id)"
              @click="handleDownload(row)"
            >
              下载
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section v-if="!loadError" v-loading="loading" class="mobile-template-list">
      <el-empty v-if="!loading && !filteredTemplates.length" :description="emptyText" />
      <article v-for="item in filteredTemplates" :key="item.id" class="mobile-template-item">
        <div class="mobile-template-heading">
          <div>
            <strong>{{ item.name }}</strong>
            <span>{{ item.module }}</span>
          </div>
          <el-tag effect="plain" type="success" size="small">{{ formatLabel(item.format) }}</el-tag>
        </div>
        <p>{{ item.description }}</p>
        <dl>
          <div><dt>导入入口</dt><dd>{{ item.importEntry }}</dd></div>
          <div><dt>文件名称</dt><dd>{{ item.fileName }}</dd></div>
        </dl>
        <el-button
          type="primary"
          :icon="Download"
          :loading="downloadingIds.has(item.id)"
          @click="handleDownload(item)"
        >
          下载模板
        </el-button>
      </article>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { Download } from '@element-plus/icons-vue'
import { downloadImportTemplate, getImportTemplates } from '@/api/importTemplate'
import { isStaleContextResponseError, requestErrorMessage } from '@/utils/request'

const templates = ref([])
const loading = ref(false)
const loadError = ref('')
const keyword = ref('')
const moduleFilter = ref('')
const downloadingIds = ref(new Set())
let loadRequestId = 0

const moduleOptions = computed(() => (
  [...new Set(templates.value.map((item) => item.module).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
))

const filteredTemplates = computed(() => {
  const needle = keyword.value.trim().toLocaleLowerCase('zh-CN')
  return templates.value.filter((item) => {
    if (moduleFilter.value && item.module !== moduleFilter.value) return false
    if (!needle) return true
    return [item.name, item.module, item.description, item.importEntry, item.fileName]
      .some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(needle))
  })
})

const emptyText = computed(() => (
  templates.value.length && (keyword.value.trim() || moduleFilter.value)
    ? '没有符合筛选条件的模板'
    : '当前账号没有可下载的导入模板'
))

const formatLabel = (format) => String(format || 'xlsx').replace(/^\./, '').toUpperCase()

const safeDownloadFileName = (fileName, fallback) => {
  const normalized = String(fileName || '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
  return normalized || `${fallback || '导入模板'}.xlsx`
}

const saveBlob = (blob, fileName) => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

const loadTemplates = async () => {
  const requestId = ++loadRequestId
  loading.value = true
  loadError.value = ''
  try {
    const response = await getImportTemplates()
    if (requestId !== loadRequestId) return
    templates.value = Array.isArray(response?.templates) ? response.templates : []
  } catch (error) {
    if (requestId !== loadRequestId || isStaleContextResponseError(error)) return
    templates.value = []
    loadError.value = requestErrorMessage(error, '模板清单加载失败，请稍后重试')
  } finally {
    if (requestId === loadRequestId) loading.value = false
  }
}

const handleDownload = async (template) => {
  if (!template?.id || downloadingIds.value.has(template.id)) return
  downloadingIds.value = new Set([...downloadingIds.value, template.id])
  try {
    const blob = await downloadImportTemplate(template.id)
    saveBlob(blob, safeDownloadFileName(template.fileName, template.name))
  } catch {
    // The request layer displays the localized failure once.
  } finally {
    const next = new Set(downloadingIds.value)
    next.delete(template.id)
    downloadingIds.value = next
  }
}

onMounted(loadTemplates)
</script>

<style scoped lang="scss">
.template-library-page {
  min-width: 0;
}

.page-heading p {
  margin-top: 5px;
  color: var(--zl-muted);
  font-size: 14px;
}

.template-toolbar {
  margin-bottom: 16px;
}

.keyword-input {
  width: min(420px, 100%);
}

.module-select {
  width: 180px;
}

.result-count {
  margin-left: auto;
  color: var(--zl-muted);
  font-size: 13px;
  white-space: nowrap;
}

.state-alert {
  margin-bottom: 16px;
}

.template-name {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.template-name > .el-icon {
  flex: 0 0 auto;
  color: #245d3f;
  font-size: 22px;
}

.template-name div,
.template-name strong,
.template-name span {
  display: block;
  min-width: 0;
}

.template-name strong {
  overflow-wrap: anywhere;
}

.template-name span {
  margin-top: 3px;
  overflow: hidden;
  color: var(--zl-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-template-list {
  display: none;
}

@media (max-width: 768px) {
  .page-heading {
    align-items: flex-start;
  }

  .template-toolbar {
    align-items: stretch;
  }

  .keyword-input,
  .module-select {
    width: 100%;
  }

  .result-count {
    width: 100%;
    margin-left: 0;
  }

  .desktop-template-list {
    display: none;
  }

  .mobile-template-list {
    display: grid;
    gap: 12px;
  }

  .mobile-template-item {
    min-width: 0;
    padding: 16px;
    background: var(--zl-surface-solid);
    border: 1px solid var(--zl-border-soft);
    border-radius: 8px;
  }

  .mobile-template-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .mobile-template-heading strong,
  .mobile-template-heading span {
    display: block;
    overflow-wrap: anywhere;
  }

  .mobile-template-heading span {
    margin-top: 4px;
    color: var(--zl-muted);
    font-size: 12px;
  }

  .mobile-template-item > p {
    margin-top: 12px;
    color: #475569;
    font-size: 14px;
    line-height: 1.6;
  }

  .mobile-template-item dl {
    margin: 12px 0;
    padding-block: 8px;
    border-block: 1px solid var(--zl-border-soft);
  }

  .mobile-template-item dl > div {
    display: grid;
    grid-template-columns: 76px minmax(0, 1fr);
    gap: 8px;
    padding: 4px 0;
  }

  .mobile-template-item dt {
    color: var(--zl-muted);
    font-size: 12px;
  }

  .mobile-template-item dd {
    min-width: 0;
    color: var(--zl-text);
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  .mobile-template-item > .el-button {
    width: 100%;
  }
}
</style>
