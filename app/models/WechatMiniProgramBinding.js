'use strict';

const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  templateId: {
    type: String,
    required: true,
    trim: true,
    maxlength: 128
  },
  remainingCount: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },
  lastResult: {
    type: String,
    enum: ['accept', 'reject', 'ban', 'consumed'],
    required: true
  },
  updatedAt: {
    type: Date,
    required: true,
    default: Date.now
  }
}, { _id: false });

const bindingSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  openId: {
    type: String,
    required: true,
    trim: true,
    maxlength: 128,
    select: false
  },
  subscriptions: {
    type: [subscriptionSchema],
    default: [],
    select: false
  },
  boundAt: {
    type: Date,
    required: true,
    default: Date.now
  },
  lastBoundAt: {
    type: Date,
    required: true,
    default: Date.now
  }
}, { timestamps: true });

bindingSchema.index({ userId: 1 }, { unique: true, name: 'uq_wechat_binding_user' });
bindingSchema.index({ openId: 1 }, { unique: true, name: 'uq_wechat_binding_openid' });

module.exports = mongoose.model('WechatMiniProgramBinding', bindingSchema);
