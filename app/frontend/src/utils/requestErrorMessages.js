const chineseCharacterPattern = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u

function groupedEntries(message, codes) {
  const entries = {}
  for (const code of codes) entries[code] = message
  return entries
}

export const REQUEST_ERROR_CODE_MESSAGES = Object.freeze({
  REQUEST_TIMEOUT: '请求超时，请检查网络后重试',
  ...groupedEntries('登录状态已失效，请重新登录', [
    'AUTH_TOKEN_REQUIRED',
    'AUTH_TOKEN_INVALID',
    'AUTH_TOKEN_CLAIMS_INVALID',
    'AUTH_TOKEN_VERSION_MISMATCH',
    'AUTH_SESSION_NOT_FOUND',
    'AUTH_SESSION_REVOKED',
    'AUTH_SESSION_EXPIRED',
    'AUTH_SESSION_MISMATCH'
  ]),
  AUTH_CREDENTIALS_INVALID: '用户名或密码错误',
  AUTH_UNAUTHORIZED: '登录状态已失效，请重新登录',
  AUTH_INPUT_INVALID: '账号或密码信息不符合要求，请检查后重试',
  AUTH_OLD_PASSWORD_INVALID: '原密码错误',
  AUTH_REGISTRATION_MOVED: '账号请由管理员在团队成员管理中创建',
  AUTH_TEAM_ACCESS_REQUIRED: '当前账号无权进入所选团队',
  AUTH_USER_NOT_FOUND: '账号不存在',
  AUTH_USER_DISABLED: '账号已停用，请联系管理员',
  AUTH_SUPER_ADMIN_REQUIRED: '该操作仅限超级管理员',
  AUTH_TEAM_NOT_FOUND: '项目团队不存在',
  AUTH_TEAM_DISABLED: '项目团队已停用',
  AUTH_MEMBERSHIP_REQUIRED: '当前账号尚未加入该项目团队',
  AUTH_MEMBERSHIP_DISABLED: '当前账号在该团队的成员资格已停用',
  AUTH_MEMBERSHIP_INVALID: '当前账号的团队成员配置异常，请联系管理员',
  AUTH_ORG_UNIT_INVALID: '当前账号的组织归属配置异常，请联系管理员',
  AUTH_CONTEXT_REQUIRED: '请先登录后再操作',
  BUSINESS_CONTEXT_REQUIRED: '请先选择项目团队后再操作',
  TEAM_CONTEXT_REQUIRED: '请先进入具体项目团队后再操作',
  GLOBAL_READ_ONLY: '跨团队查看模式为只读，请先进入具体团队后再修改',
  PERMISSION_KEY_UNKNOWN: '权限配置异常，请联系管理员',
  PERMISSION_DENIED: '没有执行该操作的权限',
  DATA_SCOPE_MODULE_UNKNOWN: '模块数据范围配置异常，请联系管理员',
  DATA_SCOPE_INVALID: '当前账号的数据范围配置异常，请联系管理员',
  CONTROL_PLANE_OPERATION_DENIED: '当前状态不允许执行团队管理操作',

  SCOPED_QUERY_INVALID_FILTER: '查询条件格式不正确',
  SCOPED_QUERY_INVALID_ID: '查询的记录编号无效',
  RELATED_RESOURCE_INVALID: '关联数据无效或不属于当前团队',
  INVALID_REQUEST: '提交内容不符合要求，请检查后重试',
  INVALID_DATE_RANGE: '开始日期不能晚于结束日期',
  RESOURCE_NOT_FOUND: '请求的记录不存在或已被删除',
  VALIDATION_FAILED: '提交内容校验失败，请检查后重试',
  CORS_ORIGIN_DENIED: '当前访问地址未获授权，请从系统正式入口访问',
  USER_NOT_FOUND: '用户不存在或已停用',
  TRANSACTIONS_REQUIRED: '当前流程服务暂不可用，请稍后重试',

  ...groupedEntries('数据提报内容不符合要求，请检查后重试', [
    'REPORT_INPUT_INVALID',
    'REPORT_RELATED_RESOURCE_INVALID'
  ]),
  REPORT_RECORD_NOT_FOUND: '提报记录不存在或已被删除',
  REPORT_RELATED_RESOURCE_NOT_FOUND: '提报关联的数据不存在或已被删除',
  REPORT_DATE_INVALID: '提报日期格式不正确',
  REPORT_DATE_RANGE_INVALID: '提报日期范围不正确',
  REPORT_MONTH_INVALID: '提报月份格式不正确',
  REPORT_MONTH_RANGE_INVALID: '提报月份范围不正确',
  REPORT_DUPLICATE: '相同范围的提报记录已存在，请勿重复提交',
  REPORT_LEGACY_FILE_REFERENCE_REJECTED: '请重新选择并上传系统内的有效附件',
  REPORT_PHOTO_COUNT_INVALID: '运输提报需上传 2 至 10 张照片',
  REPORT_TEAM_CONTEXT_REQUIRED: '请先进入具体项目团队后再操作提报数据',
  REPORT_TEAM_ID_IMMUTABLE: '项目团队由登录状态确定，不能手工修改',
  REPORT_TEAM_REQUIRED: '跨团队查看时必须先选择项目团队',
  TRANSPORT_REPORTER_REQUIRED: '只有运输提报员可以新增或修改运输记录',
  TRANSPORT_MASTER_SELECTION_REQUIRED: '当前客户端版本过旧，请更新或刷新后重新选择车次、路线、车牌、车型和司机',
  TRANSPORT_MASTER_SELECTION_INVALID: '所选运输基础资料已停用或不属于当前部门，请刷新后重新选择',
  TRANSPORT_MASTER_INPUT_INVALID: '运输基础资料内容不正确，请检查后重试',
  TRANSPORT_MASTER_KIND_IMMUTABLE: '运输基础资料类型不可修改',
  TRANSPORT_MASTER_DUPLICATE: '同类运输基础资料已存在，请勿重复添加',
  TRANSPORT_MASTER_NOT_FOUND: '运输基础资料不存在或已被删除',
  TRANSPORT_MASTER_DELETE_UNSUPPORTED: '该基础资料只能停用，不能删除',
  TRANSPORT_LOAD_ITEMS_INVALID: '装载明细内容不正确，请刷新后重试',
  TRANSPORT_LOAD_TYPE_INVALID: '所选装载明细类型已停用或删除，请刷新后重新填写',
  TRANSPORT_RECORD_DUPLICATE: '该车次运输记录已存在，请勿重复提交',
  PRODUCTION_DAILY_MONTH_MISMATCH: '生产日报日期与所选月份不一致',
  PRODUCTION_DAILY_SLOT_INVALID: '生产日报日期不在允许维护的时间范围内',
  PRODUCTION_MONTH_MISMATCH: '提交月份与当前维护月份不一致',
  PRODUCTION_SCHEDULE_MONTH_DUPLICATE: '该月份的生产排产已存在',

  ATTENDANCE_SUBMITTER_ROLE_REQUIRED: '只有指定分部提报人或部门考勤员可以提交出勤',
  ATTENDANCE_OFFICER_REQUIRED: '只有部门考勤员可以审核出勤日报',
  ATTENDANCE_TEAM_SCOPE_REQUIRED: '审核出勤日报需要部门级数据权限',
  ATTENDANCE_REPORTER_DATE_LOCKED: '分部提报人只能填报当天出勤',
  ATTENDANCE_REPORTER_DEADLINE_LOCKED: '已超过 09:00，分部提报人不能再修改当天出勤',
  ATTENDANCE_LATE_REASON_REQUIRED: '09:00 后补报或修改出勤时，请填写修正原因',
  ATTENDANCE_SUBMISSION_REVIEWED: '该出勤记录已审核，不能再修改',
  ATTENDANCE_REVIEW_STATE_INVALID: '当前出勤状态不允许审核',
  ATTENDANCE_DAILY_INCOMPLETE: '当日七个分部的出勤尚未全部提交，暂不能审核',
  ATTENDANCE_REPORTING_UNITS_NOT_CONFIGURED: '出勤提报分部尚未配置完整，请联系管理员',
  ATTENDANCE_CONCURRENT_REVIEW_CONFLICT: '出勤数据已发生变化，请刷新后重新审核',
  ATTENDANCE_DAILY_REVIEW_DUPLICATE: '该日期的出勤日报已经审核',
  ATTENDANCE_SUBMISSION_DUPLICATE: '该分部当天的出勤记录已存在',
  ATTENDANCE_ROLE_REQUIRED: '当前账号没有出勤填报或管理权限',
  ATTENDANCE_REPORTER_EXISTS: '该分部已经设置了有效的出勤提报人',
  ATTENDANCE_REPORTER_ORG_REQUIRED: '出勤提报人必须归属具体分部',

  DAILY_REPORT_ATTENDANCE_REVIEW_REQUIRED: '今日或昨日出勤尚未完成审核，暂不能生成生产日报',
  DAILY_REPORT_ATTENDANCE_INCOMPLETE: '出勤审核来源未包含完整七个分部，暂不能生成生产日报',
  DAILY_REPORT_ATTENDANCE_SOURCE_INVALID: '出勤审核来源数据异常，暂不能生成生产日报',
  DAILY_REPORT_ATTENDANCE_SOURCE_MISSING: '已审核出勤来源记录不完整，暂不能生成生产日报',
  DAILY_REPORT_DATE_INVALID: '生产日报日期格式不正确',
  DAILY_REPORT_DATE_RANGE_INVALID: '生产日报日期范围不正确',
  DAILY_REPORT_INPUT_FIXED: '生产日报内容由系统数据生成，不能手工修改',
  DAILY_REPORT_NOT_FOUND: '生产日报不存在或已被删除',
  DAILY_REPORT_PRODUCTION_SCHEDULE_REQUIRED: '今日、昨日或累计口径所需排产尚未维护完整，暂不能生成生产日报',
  DAILY_REPORT_RANGE_INVALID: '生产日报统计范围异常，请联系管理员',
  DAILY_REPORT_RELATED_RESOURCE_INVALID: '生产日报关联的数据无效',
  DAILY_REPORT_SOURCE_INVALID: '生产日报来源数据异常，请检查后重试',
  DAILY_REPORT_SOURCE_SNAPSHOT_TOO_LARGE: '生产日报来源数据过大，暂不能生成',
  DAILY_REPORT_VERSION_INVALID: '生产日报版本号无效',
  DAILY_REPORT_VERSION_LIMIT_REACHED: '该日期已达到 50 个版本，已禁止继续生成',
  DAILY_REPORT_VERSION_NOT_FOUND: '指定的生产日报版本不存在',

  CONTRACT_INPUT_INVALID: '合同资料不符合要求，请检查后重试',
  CONTRACT_FILTER_INVALID: '合同筛选条件格式不正确',
  CONTRACT_PAGINATION_INVALID: '合同列表分页参数不正确',
  CONTRACT_DATE_INVALID: '合同日期格式不正确',
  CONTRACT_DATE_RANGE_INVALID: '合同截止日期不能早于生效日期',
  CONTRACT_CATEGORY_INVALID: '合同类型不正确，请刷新后重试',
  CONTRACT_CATEGORY_IMMUTABLE: '合同类型创建后不能修改',
  CONTRACT_SIGNING_STATUS_INVALID: '合同签订状态不正确',
  CONTRACT_DETAIL_FIELD_INVALID: '当前合同类型包含不支持的明细字段',
  CONTRACT_COMPUTED_FIELD_READ_ONLY: '该合同状态由系统计算，不能手工修改',
  CONTRACT_RECORD_NOT_FOUND: '合同记录不存在或已被删除',
  CONTRACT_SUPPLIER_NOT_FOUND: '供应商不存在或已被删除',
  CONTRACT_SUPPLIER_CODE_DUPLICATE: '当前团队已存在相同供应商编码',
  CONTRACT_SUPPLIER_HAS_DEPENDENCIES: '该供应商已有合同或结算数据，不能删除',
  CONTRACT_SUPPLIER_TERTIARY_RECORD_REQUIRED: '供应商必须先通过三级明细创建，不能从一级总览单独维护',
  CONTRACT_SUPPLIER_LAST_RECORD_HAS_SETTLEMENTS: '该供应商已有结算数据，不能删除最后一条三级明细',
  CONTRACT_ATTACHMENT_INVALID: '合同附件信息不正确或数量超过 10 个',
  CONTRACT_ATTACHMENT_DUPLICATE: '同一附件不能重复绑定',
  CONTRACT_ATTACHMENT_PURPOSE_INVALID: '附件用途不适用于当前合同类型',
  CONTRACT_ATTACHMENT_MIME_INVALID: '附件格式不符合当前合同资料要求',
  CONTRACT_FILE_STORAGE_UNAVAILABLE: '合同附件存储暂不可用，请联系管理员',
  CONTRACT_TEAM_ID_IMMUTABLE: '合同所属团队由登录状态确定，不能手工修改',
  CONTRACT_TRANSACTIONS_REQUIRED: '合同管理服务暂不可用，请稍后重试',
  CONTRACT_EXPORT_SCOPE_INVALID: '供应商合同导出范围不正确，请刷新页面后重试',
  CONTRACT_EXPORT_PARAMETER_INVALID: '当前导出层级包含不支持的筛选条件',
  CONTRACT_EXPORT_SUPPLIER_REQUIRED: '导出二级汇总时必须选择当前供应商',
  CONTRACT_EXPORT_CATEGORY_NOT_ALLOWED: '当前导出层级不能指定合同类型',
  CONTRACT_EXPORT_DETAIL_CONTEXT_INVALID: '导出三级明细时，请同时选择供应商和合同类型',

  CONTRACT_IMPORT_FILE_REQUIRED: '请选择合同管理 Excel 文件',
  CONTRACT_IMPORT_FILE_TOO_LARGE: '合同管理 Excel 文件不能超过 20 MB',
  CONTRACT_IMPORT_FILE_UNSUPPORTED: '仅支持 .xlsx 格式的合同管理 Excel 文件',
  CONTRACT_IMPORT_UPLOAD_INVALID: '合同管理 Excel 上传内容不正确',
  CONTRACT_IMPORT_WORKBOOK_INVALID: '合同工作簿无法读取，请检查文件后重试',
  CONTRACT_IMPORT_TEMPLATE_INVALID: '合同导入模板不正确，请使用客户确认的原始模板',
  CONTRACT_IMPORT_EMPTY: '合同导入模板只有表头，请先填写供应商和合同明细后再导入',
  CONTRACT_IMPORT_SUPPLIER_INVALID: '合同导入文件中的供应商信息不完整',
  CONTRACT_IMPORT_SUPPLIER_CONFLICT: '合同导入文件中同一供应商编码对应了不同信息',
  CONTRACT_IMPORT_SUPPLIER_NOT_IN_MAIN: '合同明细中的供应商未出现在供应商主表',
  CONTRACT_IMPORT_SUPPLIER_MISMATCH: '导入文件中的供应商与当前供应商不一致',
  CONTRACT_IMPORT_TRUSTEE_INVALID: '合同导入文件中的托管属性不正确',
  CONTRACT_IMPORT_SUPPLY_STATUS_INVALID: '合同导入文件中的供货状态不正确',
  CONTRACT_IMPORT_SIGNING_STATUS_INVALID: '合同导入文件中的签订状态不正确',
  CONTRACT_IMPORT_SIGNING_STATUS_REQUIRED: '请填写合同签订状态后再导入',
  CONTRACT_IMPORT_DATE_INVALID: '合同导入文件中存在格式不正确的日期',
  CONTRACT_IMPORT_BOOLEAN_INVALID: '合同导入文件中存在格式不正确的是或否选项',
  CONTRACT_IMPORT_OVERSTORAGE_DAYS_INVALID: '合同导入文件中的超储天数不能超过 200 个字符',
  CONTRACT_IMPORT_DETAIL_INVALID: '合同导入文件中的明细内容不正确',
  CONTRACT_IMPORT_DETAIL_EMPTY: '三级细表存在没有供应商信息或合同内容的空明细行',
  CONTRACT_IMPORT_MEDIA_INVALID: '合同导入文件中包含无效图片，请检查后重试',
  CONTRACT_IMPORT_MEDIA_MISSING: '合同导入文件中的图片引用缺少对应图片',
  CONTRACT_IMPORT_ATTACHMENT_UNRESOLVED: 'Excel 的 W、BF、BG 附件列不能填写文件名、路径或 URL；请清空后重新导入，再按合同 PDF或打款凭证的入口单独上传',
  CONTRACT_PDF_ZIP_REQUIRED: '请选择包含合同 PDF 的 ZIP 压缩包',
  CONTRACT_PDF_ZIP_TOO_LARGE: '合同 PDF 压缩包大小超过系统限制',
  CONTRACT_PDF_ZIP_UNSUPPORTED: '仅支持包含 PDF 的普通 ZIP 压缩包',
  CONTRACT_PDF_ZIP_UPLOAD_INVALID: '合同 PDF 压缩包上传内容不正确',
  CONTRACT_PDF_ZIP_INVALID: '合同 PDF 压缩包无效或已损坏',
  CONTRACT_PDF_ZIP_PATH_INVALID: '压缩包内包含不安全的文件路径',
  CONTRACT_PDF_ZIP_TOO_MANY_FILES: '压缩包内文件数量超过系统限制',
  CONTRACT_PDF_ZIP_EMPTY: '压缩包内没有 PDF 文件',
  CONTRACT_PDF_FILE_TOO_LARGE: '单个合同 PDF 不能超过 20 MB',
  CONTRACT_PDF_FILE_INVALID: '压缩包内包含无效的 PDF 文件',
  CONTRACT_PDF_MATCH_FAILED: '部分 PDF 无法唯一匹配合同，请按供应商编码和合同编号重命名',
  CONTRACT_PDF_RECORD_CHANGED: '合同记录已发生变化，请刷新后重试',
  CONTRACT_PAYMENT_ZIP_REQUIRED: '请选择包含打款凭证的 ZIP 压缩包',
  CONTRACT_PAYMENT_ZIP_TOO_LARGE: '打款凭证压缩包大小超过系统限制',
  CONTRACT_PAYMENT_ZIP_UNSUPPORTED: '仅支持包含 PDF 或图片的普通 ZIP 压缩包',
  CONTRACT_PAYMENT_ZIP_UPLOAD_INVALID: '打款凭证压缩包上传内容不正确',
  CONTRACT_PAYMENT_ZIP_EMPTY: '压缩包内没有 PDF 或图片文件',
  CONTRACT_PAYMENT_FILE_TOO_LARGE: '单个打款凭证不能超过 20 MB',
  CONTRACT_PAYMENT_FILE_INVALID: '压缩包内包含无效的打款凭证文件',
  CONTRACT_PAYMENT_MATCH_FAILED: '部分打款凭证无法唯一匹配器具租赁记录，请按供应商编码和合同编号重命名',
  CONTRACT_PAYMENT_RECORD_CHANGED: '器具租赁记录已发生变化，请刷新后重试',
  CONTRACT_ATTACHMENT_LIMIT: '单条合同记录的附件不能超过 10 个',

  CONTRACT_SETTLEMENT_AMOUNT_INVALID: '结算金额必须是大于或等于 0 的数字',
  CONTRACT_SETTLEMENT_MONTH_INVALID: '结算月份格式必须是 YYYY-MM',
  CONTRACT_SETTLEMENT_MONTH_RANGE_INVALID: '开始月份不能晚于结束月份',
  CONTRACT_SETTLEMENT_MONTH_FILTER_CONFLICT: '单月筛选不能与月份区间同时使用',
  CONTRACT_SETTLEMENT_NOT_FOUND: '供应商结算记录不存在或已被删除',
  CONTRACT_SETTLEMENT_DUPLICATE: '该供应商当月的结算费用已存在',
  CONTRACT_SETTLEMENT_DUPLICATE_IN_FILE: '结算导入文件中存在重复的月份和供应商编码',
  CONTRACT_SETTLEMENT_SUPPLIER_REQUIRED: '请选择供应商',
  CONTRACT_SETTLEMENT_SUPPLIER_IMMUTABLE: '结算记录创建后不能更换供应商',
  CONTRACT_SETTLEMENT_SUPPLIER_NOT_FOUND: '结算表中的供应商编码不存在',
  CONTRACT_SETTLEMENT_SUPPLIER_MISMATCH: '结算表中的供应商名称与编码不匹配',
  CONTRACT_SETTLEMENT_WORKBOOK_INVALID: '结算费用工作簿无法读取，请检查文件后重试',
  CONTRACT_SETTLEMENT_TEMPLATE_INVALID: '结算费用导入模板不正确，请使用客户确认的原始模板',
  CONTRACT_SETTLEMENT_IMPORT_EMPTY: '结算费用导入文件中没有可导入的数据',
  CONTRACT_SETTLEMENT_ROW_INVALID: '结算费用导入行内容不完整',

  EQUIPMENT_INPUT_INVALID: '设备信息不符合要求，请检查后重试',
  EQUIPMENT_NOT_FOUND: '设备不存在或已被删除',
  EQUIPMENT_RELATED_RESOURCE_INVALID: '设备关联的分类、组织或保管人无效',
  EQUIPMENT_TEAM_CONTEXT_REQUIRED: '请先进入具体项目团队后再操作设备数据',
  EQUIPMENT_TEAM_ID_IMMUTABLE: '设备所属团队由登录状态确定，不能手工修改',
  EQUIPMENT_TEAM_REQUIRED: '跨团队查看时必须先选择设备所属团队',
  EQUIPMENT_ASSET_CODE_DUPLICATE: '设备编号已存在，请更换后重试',
  EQUIPMENT_CATEGORY_DUPLICATE: '同一上级分类下已存在同名分类',
  EQUIPMENT_CATEGORY_CYCLE: '设备分类不能形成循环层级',
  EQUIPMENT_CATEGORY_ACTIVE_RULE_DEPTH_CONFLICT: '请先停用关联点检/保养规则，或保持设备一级名称层级',
  EQUIPMENT_CATEGORY_STRUCTURE_CONFLICT: '设备分类结构已发生变化，请刷新后重试',
  EQUIPMENT_CATEGORY_IN_USE: '该设备分类正在使用，不能删除',
  EQUIPMENT_CATEGORY_DELETE_INPUT_INVALID: '设备分类删除参数不正确',
  EQUIPMENT_CATEGORY_DELETE_REQUIRES_DISABLED: '请先停用该设备分类，再执行删除',
  EQUIPMENT_CATEGORY_DELETE_HAS_CHILDREN: '该分类还有下级分类，请从最下级开始删除',
  EQUIPMENT_CATEGORY_DELETE_HAS_EQUIPMENT: '该分类仍有设备使用，不能删除',
  EQUIPMENT_CATEGORY_DELETE_HAS_RULES: '该分类仍有点检或保养规则使用，不能删除',
  EQUIPMENT_CATEGORY_TEAM_SCOPE_REQUIRED: '设备分类必须属于当前项目团队',
  EQUIPMENT_STATUS_APPROVAL_REQUIRED: '设备状态变更必须通过状态申请审批',
  EQUIPMENT_RUNTIME_HOURS_DECREASED: '本次运行小时不能小于上一条读数',

  EQUIPMENT_IMPORT_INPUT_INVALID: '设备导入参数不正确，请检查后重试',
  EQUIPMENT_IMPORT_FILE_REQUIRED: '请选择需要导入的 Excel 文件',
  EQUIPMENT_IMPORT_FILE_INVALID: '导入文件无效，请重新选择',
  EQUIPMENT_IMPORT_FILE_TOO_LARGE: '导入文件过大，请压缩或拆分后重试',
  EQUIPMENT_IMPORT_FILE_UNSUPPORTED: '仅支持符合模板的 .xlsx 文件',
  EQUIPMENT_IMPORT_UPLOAD_INVALID: '设备导入文件上传失败，请重新选择文件',
  EQUIPMENT_IMPORT_WORKBOOK_INVALID: 'Excel 内容或表头不符合设备导入模板',
  EQUIPMENT_IMPORT_ROW_LIMIT: '导入数据行数超过系统限制，请拆分文件',
  EQUIPMENT_IMPORT_MEDIA_INVALID: 'Excel 内的图片数据无效，请检查文件',
  EQUIPMENT_IMPORT_MEDIA_LIMIT: 'Excel 内的图片数量或大小超过系统限制',
  EQUIPMENT_IMPORT_STORAGE_UNAVAILABLE: '设备导入暂存空间不可用，请稍后重试',
  EQUIPMENT_IMPORT_STORAGE_WRITE_FAILED: '设备导入文件暂存失败，请稍后重试',
  EQUIPMENT_IMPORT_NOT_FOUND: '设备导入任务不存在或已过期',
  EQUIPMENT_IMPORT_CONFIRMATION_INVALID: '异常清单尚未确认完整，请检查后重试',
  EQUIPMENT_IMPORT_ALREADY_PUBLISHED: '该设备导入任务已经发布',
  EQUIPMENT_IMPORT_ALREADY_CANCELLED: '该设备导入任务已经取消',
  EQUIPMENT_IMPORT_CANCELLED: '该设备导入任务已取消，不能继续操作',
  EQUIPMENT_IMPORT_NOT_CLEANABLE: '请先取消设备导入预览，再清理暂存文件',
  EQUIPMENT_IMPORT_VERSION_CONFLICT: '导入预览已发生变化，请刷新后重试',
  EQUIPMENT_IMPORT_TEAM_ID_IMMUTABLE: '导入数据所属团队由登录状态确定，不能手工修改',

  EQUIPMENT_INVENTORY_INPUT_INVALID: '盘点内容不符合要求，请检查后重试',
  EQUIPMENT_INVENTORY_NOT_FOUND: '盘点批次或盘点记录不存在',
  EQUIPMENT_INVENTORY_STATE_CONFLICT: '当前盘点状态不允许执行该操作',
  EQUIPMENT_INVENTORY_APPROVAL_FORBIDDEN: '当前岗位无权处理该盘点审批',
  EQUIPMENT_INVENTORY_TRANSACTIONS_REQUIRED: '盘点流程服务暂不可用，请稍后重试',

  EQUIPMENT_REPAIR_INPUT_INVALID: '维修单内容不符合要求，请检查后重试',
  EQUIPMENT_REPAIR_NOT_FOUND: '维修单不存在或已被删除',
  EQUIPMENT_REPAIR_TEAM_CONTEXT_REQUIRED: '请先进入具体项目团队后再操作维修单',
  EQUIPMENT_REPAIR_ACTION_FORBIDDEN: '当前岗位无权执行该维修操作',
  EQUIPMENT_REPAIR_CONFLICT: '维修单已发生变化，请刷新后重试',
  EQUIPMENT_REPAIR_TRANSITION_INVALID: '当前维修状态不允许执行该操作',
  EQUIPMENT_REPAIR_TRANSACTIONS_REQUIRED: '维修流程服务暂不可用，请稍后重试',

  EQUIPMENT_ROUTINE_INPUT_INVALID: '点检或保养内容不符合要求，请检查后重试',
  EQUIPMENT_ROUTINE_WORKFLOW_INPUT_INVALID: '点检或保养处理内容不符合要求',
  EQUIPMENT_ROUTINE_NOT_FOUND: '点检、保养规则或记录不存在',
  EQUIPMENT_ROUTINE_WORKFLOW_NOT_FOUND: '点检或保养流程记录不存在',
  EQUIPMENT_ROUTINE_TEAM_SCOPE_REQUIRED: '点检或保养数据必须属于当前团队',
  EQUIPMENT_ROUTINE_MANAGER_REQUIRED: '当前操作需要设备管理员权限',
  EQUIPMENT_ROUTINE_PRIMARY_CATEGORY_REQUIRED: '点检或保养规则只能选择设备一级名称',
  EQUIPMENT_ROUTINE_PLAN_NOT_OPEN: '该点检或保养计划已关闭，不能继续执行',
  EQUIPMENT_ROUTINE_PERIOD_COMPLETED: '本周期已完成点检或保养，请勿重复提交',
  EQUIPMENT_ROUTINE_RULE_DELETE_REQUIRES_DISABLED: '请先停用该规则，再执行删除',
  EQUIPMENT_ROUTINE_RULE_DELETE_HAS_HISTORY: '该规则已有执行历史，不能删除',
  EQUIPMENT_ROUTINE_NOT_DUE: '当前未到点检或保养执行周期',
  EQUIPMENT_ROUTINE_READ_ONLY: '当前点检或保养记录为只读状态',
  EQUIPMENT_ROUTINE_RULE_DUPLICATE: '相同范围的点检或保养规则已存在',
  EQUIPMENT_ROUTINE_IDEMPOTENCY_CONFLICT: '该操作已提交，请勿重复处理',
  EQUIPMENT_ROUTINE_REVISION_CONFLICT: '点检或保养记录已发生变化，请刷新后重试',
  EQUIPMENT_ROUTINE_STAGE_FORBIDDEN: '当前岗位无权处理该点检或保养环节',
  EQUIPMENT_ROUTINE_TRANSACTIONS_REQUIRED: '点检或保养流程服务暂不可用，请稍后重试',
  EQUIPMENT_DELETE_INPUT_INVALID: '删除设备的请求内容不符合要求',
  EQUIPMENT_DELETE_HAS_HISTORY: '该设备已有业务记录，不能删除，请按报废流程处理',

  EQUIPMENT_STATUS_APPLICATION_INVALID: '设备状态申请内容不符合要求',
  EQUIPMENT_STATUS_APPLICATION_NOT_FOUND: '设备状态申请不存在或已被删除',
  EQUIPMENT_STATUS_APPLICATION_CONFLICT: '设备状态申请已发生变化，请刷新后重试',
  EQUIPMENT_STATUS_APPLICANT_FORBIDDEN: '只有设备管理员可以发起设备状态申请',
  EQUIPMENT_STATUS_ACTION_FORBIDDEN: '当前岗位无权处理该设备状态申请',
  EQUIPMENT_STATUS_TRANSACTION_REQUIRED: '设备状态审批服务暂不可用，请稍后重试',

  TASK_EXECUTOR_REQUIRED: '只有任务执行人可以提交完成结果',
  TASK_REVIEWER_REQUIRED: '只有任务审核人可以执行审核',
  TASK_COMPLETION_ALREADY_SUBMITTED: '任务完成结果已经提交，请勿重复操作',
  TASK_SUBTASKS_UNFINISHED: '仍有子任务未完成，暂不能提交完成',
  TASK_EXTENSION_PENDING: '该任务已有待审批的延期申请',
  TASK_FLOW_INVALID: '当前任务状态不允许执行该操作',
  TASK_FLOW_CONFLICT: '任务已发生变化，请刷新后重试',
  TASK_REVIEW_DUPLICATE: '该审核操作已经提交，请勿重复处理',
  TASK_CONFIRMATION_DENIED: '只有任务创建人或项目管理员可以确认任务完成',
  TASK_LEADERSHIP_REQUIRED: '当前负责人已接管，主管不再具有主持权限，请刷新后重试',
  TASK_LEADERSHIP_TRANSACTIONS_REQUIRED: '任务主持服务暂不可用，请稍后重试',
  TASK_FILE_UPLOAD_DENIED: '当前任务或组织不允许上传附件，请刷新权限后重试',
  TASK_FILE_SCOPE_REQUIRED: '上传任务附件时必须且只能指定任务或所属组织',
  SUB_DEPARTMENT_LEADERSHIP_UNAVAILABLE: '分部负责人状态暂不可用，请稍后重试',
  TASK_FLOW_TRANSACTIONS_REQUIRED: '任务流程服务暂不可用，请稍后重试',
  TASK_ORG_UNIT_IMMUTABLE: '任务所属组织不能在当前操作中修改',
  EXTENSION_INVALID: '延期申请内容不符合要求',
  EXTENSION_TASK_STATE_INVALID: '当前任务状态不能申请延期',
  EXTENSION_ALREADY_REQUESTED: '该任务已有延期申请，请勿重复提交',
  EXTENSION_APPLICANT_DENIED: '只有任务负责人可以申请延期',
  EXTENSION_APPROVAL_DENIED: '只有任务创建人或项目管理员可以审批延期申请',
  EXTENSION_CONFLICT: '延期申请已发生变化，请刷新后重试',
  EXTENSION_TRANSACTIONS_REQUIRED: '延期审批服务暂不可用，请稍后重试',

  MANAGEMENT_INPUT_INVALID: '管理信息不符合要求，请检查后重试',
  MANAGEMENT_VALIDATION_FAILED: '管理信息校验失败，请检查后重试',
  MANAGEMENT_RESOURCE_NOT_FOUND: '团队、组织或成员记录不存在',
  MANAGEMENT_CONFLICT: '相同记录已存在，不能重复创建',
  MANAGEMENT_CONCURRENT_UPDATE: '记录已被他人修改，请刷新后重试',
  USERNAME_EXISTS: '用户名已存在，请更换后重试',
  CODE_EXISTS: '编号已存在，请更换后重试',
  MEMBERSHIP_EXISTS: '该用户已经属于当前项目团队',
  TEAM_ALREADY_ACTIVE: '项目团队已经启用',
  TEAM_ALREADY_DISABLED: '项目团队已经停用',
  ORG_UNIT_HAS_ACTIVE_DEPENDENCIES: '该组织仍有关联成员或业务数据，不能停用',
  ORG_UNIT_DELETE_HAS_CHILDREN: '该组织仍有下级组织，请先删除下级组织',
  ORG_UNIT_DELETE_HAS_REFERENCES: '该组织仍有关联成员或业务数据，不能删除',

  AUDIT_QUERY_INVALID: '审计日志查询条件不正确',
  AUDIT_LOG_NOT_FOUND: '审计日志不存在',
  STATISTICS_INVALID_FILTER: '统计查询条件不正确',

  FILE_REQUIRED: '请选择需要上传的文件',
  FILE_UPLOAD_INVALID: '文件上传失败，请重新选择',
  FILE_TOO_LARGE: '文件大小超过系统限制',
  FILE_TYPE_UNSUPPORTED: '不支持该文件类型',
  FILE_MIME_TYPE_NOT_ALLOWED: '不允许上传该类型的文件',
  FILE_CONTENT_INVALID: '文件内容无效或已损坏',
  FILE_NOT_FOUND: '文件不存在或已被删除',
  FILE_OWNER_TYPE_UNSUPPORTED: '该业务类型不支持上传附件',
  FILE_ATTACHMENT_INVALID: '附件无效或不属于当前业务记录',
  FILE_TEAM_REQUIRED: '上传文件前请先进入具体项目团队',
  FILE_WORKFLOW_OWNER_MANAGED: '流程附件由系统管理，不能直接修改',
  TEMPORARY_FILE_USER_COUNT_LIMIT: '个人临时文件数量已达上限，请清理后重试',
  TEMPORARY_FILE_USER_BYTES_LIMIT: '个人临时文件空间已满，请清理后重试',
  TEMPORARY_FILE_TEAM_COUNT_LIMIT: '团队临时文件数量已达上限，请清理后重试',
  TEMPORARY_FILE_TEAM_BYTES_LIMIT: '团队临时文件空间已满，请清理后重试',

  LEGACY_UPLOAD_DISABLED: '旧版上传入口已停用，请使用新版附件功能',
  LEGACY_MULTIPART_DISABLED: '旧版提交入口已停用，请使用新版功能',
  LEGACY_USER_WRITE_DISABLED: '旧版用户维护入口已停用，请使用团队成员管理',
  LEGACY_USERS_INVALID_FILTER: '用户查询条件不正确'
})

const REQUEST_ERROR_CODE_PREFIX_MESSAGES = Object.freeze([
  ['AUTH_', '账号、登录状态或团队权限异常，请重新登录后再试'],
  ['ATTENDANCE_', '出勤操作未完成，请检查填写内容和当前状态'],
  ['DAILY_REPORT_', '生产日报操作未完成，请检查前置数据'],
  ['REPORT_', '数据提报操作失败，请检查填写内容'],
  ['PRODUCTION_', '生产排产操作失败，请检查填写内容'],
  ['TRANSPORT_', '运输提报操作失败，请检查填写内容'],
  ['EQUIPMENT_IMPORT_', '设备导入操作失败，请检查文件和确认状态'],
  ['EQUIPMENT_INVENTORY_', '设备盘点操作失败，请检查当前流程状态'],
  ['EQUIPMENT_REPAIR_', '设备维修操作失败，请检查当前流程状态'],
  ['EQUIPMENT_ROUTINE_', '点检或保养操作失败，请检查当前流程状态'],
  ['EQUIPMENT_STATUS_', '设备状态申请操作失败，请检查当前流程状态'],
  ['EQUIPMENT_', '设备操作失败，请检查填写内容和当前状态'],
  ['TASK_', '任务操作失败，请检查当前任务状态'],
  ['EXTENSION_', '延期申请操作失败，请检查当前任务状态'],
  ['MANAGEMENT_', '团队管理操作失败，请检查填写内容'],
  ['MEMBERSHIP_', '团队成员操作失败，请检查成员配置'],
  ['TEAM_', '项目团队操作失败，请检查当前团队状态'],
  ['ORG_UNIT_', '组织操作失败，请检查组织配置'],
  ['FILE_', '文件操作失败，请检查文件后重试'],
  ['TEMPORARY_FILE_', '临时文件操作失败，请清理后重试'],
  ['AUDIT_', '审计日志操作失败，请检查查询条件'],
  ['SCOPED_QUERY_', '查询条件不正确，请检查后重试'],
  ['RELATED_RESOURCE_', '关联数据无效或不属于当前团队'],
  ['LEGACY_', '当前入口已停用，请使用新版功能']
])

export function containsChineseText(value) {
  return typeof value === 'string' && chineseCharacterPattern.test(value)
}

function safeChineseFallback(fallback) {
  return containsChineseText(fallback) ? fallback.trim() : '请求失败，请稍后重试'
}

function prefixMessage(code) {
  if (typeof code !== 'string') return ''
  return REQUEST_ERROR_CODE_PREFIX_MESSAGES.find(([prefix]) => code.startsWith(prefix))?.[1] || ''
}

export function resolveRequestErrorMessage({ code, message, statusCode } = {}, fallback = '请求失败') {
  if (containsChineseText(message)) return message.trim()
  if (REQUEST_ERROR_CODE_MESSAGES[code]) return REQUEST_ERROR_CODE_MESSAGES[code]

  const familyMessage = prefixMessage(code)
  if (familyMessage) return familyMessage
  if (statusCode === 413) return '上传文件超过服务器限制，请压缩文件或联系管理员调整上传限制'
  if (containsChineseText(fallback)) return fallback.trim()
  if (statusCode === 401) return '登录状态已失效，请重新登录'
  if (statusCode === 403) return '没有执行该操作的权限'
  if (statusCode === 404) return '请求的记录不存在或已被删除'
  if (statusCode >= 500) return '服务器暂时无法处理请求，请稍后重试'
  return safeChineseFallback(fallback)
}

export function requestErrorMessage(error, fallback = '请求失败') {
  const response = error?.response
  const data = response?.data || error?.data || error || {}
  const originalResponseMessage = Object.prototype.hasOwnProperty.call(error || {}, 'technicalResponseMessage')
    ? error.technicalResponseMessage
    : data?.message
  return resolveRequestErrorMessage({
    code: data?.code || error?.code,
    message: originalResponseMessage || (response ? '' : error?.message),
    statusCode: response?.status || error?.statusCode || error?.status
  }, fallback)
}

export function localizeRequestError(error, fallback = '请求失败') {
  if (!error || typeof error !== 'object') return error
  const message = requestErrorMessage(error, fallback)

  if (!Object.prototype.hasOwnProperty.call(error, 'technicalMessage')) {
    Object.defineProperty(error, 'technicalMessage', {
      configurable: true,
      value: error.message || '',
      writable: false
    })
  }
  if (!Object.prototype.hasOwnProperty.call(error, 'technicalResponseMessage')) {
    Object.defineProperty(error, 'technicalResponseMessage', {
      configurable: true,
      value: error.response?.data?.message || error.data?.message || '',
      writable: false
    })
  }
  error.message = message
  error.userMessage = message

  if (error.response?.data && typeof error.response.data === 'object') {
    error.response.data.message = message
  }
  if (error.data && typeof error.data === 'object') {
    error.data.message = message
  }
  return error
}
