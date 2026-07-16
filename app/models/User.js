const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

function normalizeUsername(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().toLowerCase()
    : value;
}

const userSchema = new mongoose.Schema({
  // 登录信息
  username: {
    type: String,
    required: [true, '用户名不能为空'],
    unique: true,
    trim: true,
    minlength: [3, '用户名至少3个字符'],
    maxlength: [50, '用户名最多50个字符']
  },
  usernameNormalized: {
    type: String,
    trim: true,
    lowercase: true,
    minlength: [3, '标准化用户名至少3个字符'],
    maxlength: [50, '标准化用户名最多50个字符']
  },
  password: {
    type: String,
    required: [true, '密码不能为空'],
    minlength: [6, '密码至少6个字符']
  },
  
  // 基本信息
  name: {
    type: String,
    required: [true, '姓名不能为空'],
    trim: true
  },
  phone: {
    type: String,
    trim: true,
    match: [/^1[3-9]\d{9}$/, '请输入有效的手机号']
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    match: [/^\S+@\S+\.\S+$/, '请输入有效的邮箱地址']
  },
  
  // 角色：admin-管理员, executor-执行人, cc-抄送人
  // 一个用户可以有多个角色
  roles: [{
    type: String,
    enum: ['admin', 'executor', 'cc'],
    default: 'executor'
  }],

  // V2 global identity. Team-level roles live in TeamMembership.
  isSuperAdmin: {
    type: Boolean,
    default: false,
    required: true
  },

  // Incrementing this value invalidates every JWT issued for the user.
  tokenVersion: {
    type: Number,
    default: 0,
    min: 0,
    required: true,
    validate: {
      validator: Number.isInteger,
      message: 'tokenVersion必须是整数'
    }
  },
  
  // 部门
  department: {
    type: String,
    trim: true
  },
  
  // 状态
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
  },
  
  // 头像
  avatar: {
    type: String
  },
  
  // 最后登录时间
  lastLoginAt: {
    type: Date
  }
}, {
  timestamps: true
});

userSchema.pre('validate', function setNormalizedUsername(next) {
  if (this.isModified('username') || !this.usernameNormalized) {
    this.usernameNormalized = normalizeUsername(this.username);
  }
  next();
});

userSchema.index(
  { usernameNormalized: 1 },
  {
    unique: true,
    name: 'uq_user_username_normalized',
    partialFilterExpression: { usernameNormalized: { $type: 'string' } }
  }
);

// 密码加密中间件
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) {
    return next();
  }
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// 验证密码方法
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// 返回用户信息（不包含密码）
userSchema.methods.toJSON = function() {
  const user = this.toObject();
  delete user.password;
  return user;
};

module.exports = mongoose.model('User', userSchema);
module.exports.normalizeUsername = normalizeUsername;

