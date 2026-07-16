'use strict';

const mongoose = require('mongoose');

// Legacy location fields remain readable while all new writes use fileId.
const fileAttachmentSchema = new mongoose.Schema({
  fileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FileAsset',
    default: null
  },
  originalName: {
    type: String,
    trim: true,
    maxlength: 255
  },
  mimeType: {
    type: String,
    trim: true,
    maxlength: 150
  },
  size: {
    type: Number,
    min: 0
  },
  uploadTime: {
    type: Date,
    default: Date.now
  },
  filename: String,
  path: String,
  mimetype: String
}, {
  _id: true,
  strict: true
});

module.exports = fileAttachmentSchema;
