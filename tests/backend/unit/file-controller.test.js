'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { contentDisposition } = require('../../../app/controllers/fileController');

test('content disposition keeps Unicode names without allowing response-header injection', () => {
  const header = contentDisposition('\u8bbe\u5907"\r\nX-Evil: yes.png');

  assert.match(header, /^attachment; filename="[^"]+"; filename\*=UTF-8''/);
  assert.equal(header.includes('\r'), false);
  assert.equal(header.includes('\n'), false);
  assert.equal(header.includes('%E8%AE%BE%E5%A4%87'), true);
  assert.equal(header.includes('%0D%0A'), true);
});
