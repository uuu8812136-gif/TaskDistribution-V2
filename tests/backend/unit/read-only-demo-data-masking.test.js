const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MASK,
  maskDemoResponse,
  maskEmail,
  maskName,
  maskPhone,
  maskWithShape
} = require('../../../app/services/readOnlyDemoDataMaskingService');
const {
  readOnlyDemoDataMasking
} = require('../../../app/middlewares/readOnlyDemoDataMasking');

test('masks phone values in the requested fixed-shape style', () => {
  assert.equal(maskPhone('13112345678'), '1311********678');
  assert.equal(maskWithShape('ABC'), MASK);
});

test('masks email and personal names without changing structural fields', () => {
  assert.equal(maskEmail('alice@example.com'), 'a********@********');
  assert.equal(maskName('张三'), '张********');
  const source = {
    _id: '507f1f77bcf86cd799439011',
    teamId: '507f1f77bcf86cd799439012',
    team: { name: '变速箱物流部', code: 'GEARBOX-001' },
    user: { name: '李涛', phone: '13112345678', email: 'li@example.com' },
    equipment: { assetCode: 'EQ-0000001', name: '叉车' },
    supplierName: '华东物流供应商',
    contractNumber: 'HT-2026-001',
    plateNumber: '鲁A12345',
    amount: 1800,
    status: 'ACTIVE'
  };
  const masked = maskDemoResponse(source);
  assert.equal(masked._id, source._id);
  assert.equal(masked.teamId, source.teamId);
  assert.equal(masked.team.name, '变********部');
  assert.equal(masked.team.code, 'GEAR********001');
  assert.equal(masked.user.name, '李********');
  assert.equal(masked.user.phone, '1311********678');
  assert.equal(masked.user.email, 'l********@********');
  assert.equal(masked.equipment.assetCode, 'EQ-0********001');
  assert.equal(masked.equipment.name, '叉********');
  assert.equal(masked.supplierName, '华********商');
  assert.equal(masked.contractNumber, 'HT-2********001');
  assert.equal(masked.plateNumber, MASK);
  assert.equal(masked.amount, MASK);
  assert.equal(masked.status, source.status);
  assert.equal(source.user.phone, '13112345678');

  const listMasked = maskDemoResponse({
    teams: [{ name: '变速箱物流部', code: 'GEARBOX-001' }],
    users: [{ name: '王五', phone: '13912345678' }]
  });
  assert.equal(listMasked.teams[0].name, '变********部');
  assert.equal(listMasked.teams[0].code, 'GEAR********001');
  assert.equal(listMasked.users[0].name, '王********');
  assert.equal(listMasked.users[0].phone, '1391********678');
});

test('masks only read-only demo responses and blocks binary exports', () => {
  let responseBody;
  let statusCode = 200;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
    send(body) {
      responseBody = body;
      return this;
    }
  };
  const request = { authContext: { isReadOnlyDemo: true } };
  readOnlyDemoDataMasking(request, response, () => {});

  response.json({ phone: '13112345678', status: 'ACTIVE' });
  assert.equal(responseBody.phone, '1311********678');
  assert.equal(responseBody.status, 'ACTIVE');

  response.send(Buffer.from('unmasked workbook'));
  assert.equal(statusCode, 403);
  assert.equal(responseBody.code, 'READ_ONLY_DEMO_EXPORT_HIDDEN');

  responseBody = undefined;
  statusCode = 200;
  const normalResponse = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
    send(body) {
      responseBody = body;
      return this;
    }
  };
  const normalRequest = { authContext: { isReadOnlyDemo: false } };
  readOnlyDemoDataMasking(normalRequest, normalResponse, () => {});
  normalResponse.json({ phone: '13112345678' });
  assert.equal(responseBody.phone, '13112345678');
});
