'use strict';

const MASK = '********';

const PHONE_KEYS = new Set([
  'phone',
  'mobile',
  'mobilenumber',
  'mobilephone',
  'telephone',
  'contactphone',
  'phonenumber'
]);

const EMAIL_KEYS = new Set(['email', 'contactemail', 'reconciliationemail']);

const IDENTIFIER_KEYS = new Set([
  'accountnumber',
  'assetcode',
  'bankaccount',
  'contractnumber',
  'fixedassetnumber',
  'idcard',
  'idcardnumber',
  'idnumber',
  'licenseplate',
  'platenumber',
  'suppliercode',
  'taxnumber',
  'vehiclenumber'
]);

const PERSON_NAME_KEYS = new Set([
  'applicantname',
  'approvername',
  'contactname',
  'creatorname',
  'drivername',
  'executorname',
  'fullname',
  'mainexecutorname',
  'operatorname',
  'ownername',
  'realname',
  'reviewername',
  'username'
]);

const PERSON_PARENT_KEYS = new Set([
  'applicant',
  'approver',
  'contact',
  'creator',
  'driver',
  'executor',
  'mainexecutor',
  'operator',
  'owner',
  'reviewer',
  'user'
]);

const SENSITIVE_NAME_PARENT_KEYS = new Set([
  ...PERSON_PARENT_KEYS,
  'asset',
  'company',
  'contract',
  'department',
  'equipment',
  'orgunit',
  'organization',
  'project',
  'supplier',
  'team',
  'vehicle',
  'vendor'
]);

const BUSINESS_NAME_KEYS = new Set([
  'companyname',
  'department',
  'departmentname',
  'equipmentname',
  'orgunitname',
  'organizationname',
  'projectname',
  'suppliername',
  'vendorname',
  'vehiclename'
]);

const SENSITIVE_CODE_PARENT_KEYS = new Set([
  'asset',
  'company',
  'contract',
  'department',
  'equipment',
  'orgunit',
  'organization',
  'project',
  'supplier',
  'team',
  'vehicle',
  'vendor'
]);

const FREE_TEXT_KEYS = new Set([
  'address',
  'comment',
  'content',
  'description',
  'detail',
  'error',
  'location',
  'message',
  'notes',
  'reason',
  'remark',
  'remarks',
  'stack',
  'title',
  'telephoneaddress'
]);

const ATTACHMENT_KEYS = new Set([
  'avatar',
  'downloadurl',
  'filename',
  'fileurl',
  'imageurl',
  'originalname',
  'path',
  'photo',
  'photourl',
  'storagekey',
  'url'
]);

const AMOUNT_KEYS = new Set([
  'amount',
  'cost',
  'fee',
  'price',
  'subtotal',
  'taxamount',
  'totalamount',
  'unitprice'
]);

function normalizedKey(key) {
  return String(key || '').replace(/[_-]/g, '').toLowerCase();
}

function maskWithShape(value, prefixLength = 4, suffixLength = 3) {
  const text = String(value);
  if (text.length <= prefixLength + suffixLength) return MASK;
  return `${text.slice(0, prefixLength)}${MASK}${text.slice(-suffixLength)}`;
}

function maskPhone(value) {
  return maskWithShape(value, 4, 3);
}

function maskEmail(value) {
  const text = String(value);
  const at = text.indexOf('@');
  if (at <= 0) return MASK;
  return `${text.slice(0, 1)}${MASK}@${MASK}`;
}

function maskName(value) {
  const text = String(value);
  if (text.length <= 1) return MASK;
  if (text.length === 2) return `${text.slice(0, 1)}${MASK}`;
  return `${text.slice(0, 1)}${MASK}${text.slice(-1)}`;
}

function hasSensitiveParent(parentKeys, path) {
  const parent = normalizedKey(path[path.length - 1]);
  if (parentKeys.has(parent)) return true;
  return parent.endsWith('s') && parentKeys.has(parent.slice(0, -1));
}

function maskValue(key, value, path = []) {
  const normalized = normalizedKey(key);
  if (value === null || value === undefined) return value;

  if (PHONE_KEYS.has(normalized)) return maskPhone(value);
  if (EMAIL_KEYS.has(normalized)) return maskEmail(value);
  if (IDENTIFIER_KEYS.has(normalized)) return maskWithShape(value);
  if (PERSON_NAME_KEYS.has(normalized)) return maskName(value);
  if (BUSINESS_NAME_KEYS.has(normalized)) return maskName(value);
  if (
    normalized === 'code' &&
    hasSensitiveParent(SENSITIVE_CODE_PARENT_KEYS, path)
  ) return maskWithShape(value);
  if (
    normalized === 'name' &&
    hasSensitiveParent(SENSITIVE_NAME_PARENT_KEYS, path)
  ) return maskName(value);
  if (FREE_TEXT_KEYS.has(normalized)) return MASK;
  if (ATTACHMENT_KEYS.has(normalized)) return MASK;
  if (AMOUNT_KEYS.has(normalized)) return MASK;
  return value;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function maskDemoResponse(value, path = []) {
  if (Array.isArray(value)) {
    return value.map((item) => maskDemoResponse(item, path));
  }
  if (!isPlainObject(value)) return value;

  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    const masked = maskValue(key, child, path);
    return [
      key,
      masked === child && (isPlainObject(child) || Array.isArray(child))
        ? maskDemoResponse(child, [...path, key])
        : masked
    ];
  }));
}

function isReadOnlyDemoContext(context) {
  return context?.isReadOnlyDemo === true;
}

module.exports = {
  MASK,
  isReadOnlyDemoContext,
  maskDemoResponse,
  maskEmail,
  maskName,
  maskPhone,
  maskValue,
  maskWithShape
};
