'use strict';

const {
  createEquipmentImportTemplateWorkbook
} = require('./equipmentImportParser');
const {
  createSettlementImportTemplateWorkbook,
  createSupplierImportTemplateWorkbook
} = require('./contractWorkbookService');
const {
  assertPermission,
  assertTeamContext
} = require('./teamContextService');

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

class ImportTemplateError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ImportTemplateError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

const TEMPLATE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'equipment-ledger',
    name: '设备台账导入模板',
    module: '设备管理',
    description: '批量维护设备基础资料、分类、编号、使用部门和存放位置。',
    importEntry: '设备管理 > 设备台账 > 导入 Excel',
    importEndpoint: '/api/equipment/imports',
    fileName: '设备台账导入模板.xlsx',
    format: 'xlsx',
    updatedAt: '2026-08-12',
    permission: 'equipment.view',
    importPermission: 'equipment.import',
    createWorkbook: createEquipmentImportTemplateWorkbook
  }),
  Object.freeze({
    id: 'supplier-contract-detail',
    name: '供应商合同三级明细导入模板',
    module: '合同管理',
    description: '批量维护供应商及57列合同三级明细，主表和二级汇总由系统生成。',
    importEntry: '合同管理 > 供应商合同管理 > 导入三级细表',
    importEndpoint: '/api/contracts/suppliers/import',
    fileName: '供应商合同三级明细导入模板.xlsx',
    format: 'xlsx',
    updatedAt: '2026-08-12',
    permission: 'contract.supplier.view',
    importPermission: 'contract.supplier.import',
    createWorkbook: createSupplierImportTemplateWorkbook
  }),
  Object.freeze({
    id: 'supplier-settlement-fee',
    name: '供应商结算费用导入模板',
    module: '合同管理',
    description: '按月份批量维护供应商上线金额、仓储物流费和超储费用。',
    importEntry: '合同管理 > 供应商结算费用 > 导入月度费用',
    importEndpoint: '/api/contracts/settlements/import',
    fileName: '供应商结算费用导入模板.xlsx',
    format: 'xlsx',
    updatedAt: '2026-08-12',
    permission: 'contract.settlement.view',
    importPermission: 'contract.settlement.import',
    createWorkbook: createSettlementImportTemplateWorkbook
  })
]);

const TEMPLATE_BY_ID = new Map(TEMPLATE_DEFINITIONS.map((template) => [template.id, template]));

function publicTemplate(template) {
  const { createWorkbook, ...metadata } = template;
  return metadata;
}

function canAccessTemplate(authContext, template) {
  const granted = new Set(authContext.permissionKeys || []);
  return [template.permission, template.importPermission]
    .some((permissionKey) => granted.has(permissionKey));
}

function assertTemplateAccess(authContext, template) {
  if (canAccessTemplate(authContext, template)) return;
  assertPermission(authContext, template.permission);
}

function assertNoClientTeamId(requestedTeamId) {
  if (requestedTeamId !== undefined) {
    throw new ImportTemplateError(
      400,
      'IMPORT_TEMPLATE_TEAM_ID_IMMUTABLE',
      '模板所属团队由当前登录状态确定，不能手工指定'
    );
  }
}

function createImportTemplateService() {
  return Object.freeze({
    list({ authContext, requestedTeamId }) {
      assertTeamContext(authContext);
      assertNoClientTeamId(requestedTeamId);
      return {
        templates: TEMPLATE_DEFINITIONS
          .filter((template) => canAccessTemplate(authContext, template))
          .map(publicTemplate)
      };
    },

    async download({ authContext, requestedTeamId, templateId }) {
      assertTeamContext(authContext);
      assertNoClientTeamId(requestedTeamId);
      const template = TEMPLATE_BY_ID.get(String(templateId || ''));
      if (!template) {
        throw new ImportTemplateError(
          404,
          'IMPORT_TEMPLATE_NOT_FOUND',
          '导入模板不存在或已停用'
        );
      }
      assertTemplateAccess(authContext, template);
      const buffer = await template.createWorkbook();
      return {
        ...publicTemplate(template),
        contentType: XLSX_CONTENT_TYPE,
        buffer: Buffer.from(buffer)
      };
    }
  });
}

module.exports = {
  ImportTemplateError,
  TEMPLATE_DEFINITIONS,
  XLSX_CONTENT_TYPE,
  createImportTemplateService
};
