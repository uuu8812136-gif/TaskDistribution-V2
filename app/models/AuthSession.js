'use strict';

const mongoose = require('mongoose');
const {
  SESSION_MODES,
  SESSION_MODE_VALUES,
  SESSION_REVOKE_REASON_VALUES
} = require('../config/permissions');

const authSessionSchema = new mongoose.Schema({
  jtiHash: {
    type: String,
    required: true,
    immutable: true,
    lowercase: true,
    trim: true,
    match: /^[a-f0-9]{64}$/,
    select: false
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  mode: {
    type: String,
    enum: SESSION_MODE_VALUES,
    required: true,
    immutable: true
  },
  activeTeamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectTeam',
    default: null,
    immutable: true
  },
  tokenVersion: {
    type: Number,
    required: true,
    min: 0,
    immutable: true,
    validate: {
      validator: Number.isInteger,
      message: 'tokenVersion must be an integer'
    }
  },
  issuedAt: {
    type: Date,
    required: true,
    default: Date.now,
    immutable: true
  },
  expiresAt: {
    type: Date,
    required: true,
    immutable: true
  },
  revokedAt: {
    type: Date,
    default: null
  },
  revokeReason: {
    type: String,
    enum: SESSION_REVOKE_REASON_VALUES,
    default: null
  },
  revokeDetail: {
    type: String,
    trim: true,
    maxlength: 500,
    default: null
  }
}, {
  timestamps: true,
  strict: 'throw',
  optimisticConcurrency: true
});

authSessionSchema.pre('validate', function validateSessionState(next) {
  if (this.mode === SESSION_MODES.TEAM && !this.activeTeamId) {
    this.invalidate('activeTeamId', 'TEAM mode requires activeTeamId');
  }
  if (this.mode !== SESSION_MODES.TEAM && this.activeTeamId) {
    this.invalidate('activeTeamId', `${this.mode} mode cannot have activeTeamId`);
  }
  if (this.expiresAt && this.issuedAt && this.expiresAt <= this.issuedAt) {
    this.invalidate('expiresAt', 'expiresAt must be later than issuedAt');
  }
  if (this.revokedAt && this.issuedAt && this.revokedAt < this.issuedAt) {
    this.invalidate('revokedAt', 'revokedAt cannot be earlier than issuedAt');
  }
  if (this.revokedAt && !this.revokeReason) {
    this.invalidate('revokeReason', 'A revoked session requires revokeReason');
  }
  if (!this.revokedAt && (this.revokeReason || this.revokeDetail)) {
    this.invalidate('revokedAt', 'Revocation metadata requires revokedAt');
  }
  next();
});

authSessionSchema.index(
  { jtiHash: 1 },
  { unique: true, name: 'uq_auth_session_jti_hash' }
);
authSessionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'ttl_auth_session_expires_at' }
);
authSessionSchema.index(
  { userId: 1, revokedAt: 1, expiresAt: 1 },
  { name: 'ix_auth_session_user_active_expiry' }
);
authSessionSchema.index(
  { activeTeamId: 1, revokedAt: 1, expiresAt: 1 },
  { name: 'ix_auth_session_team_active_expiry' }
);

module.exports = mongoose.model('AuthSession', authSessionSchema);
