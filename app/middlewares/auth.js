const { verifyToken } = require('../utils/jwt');
const User = require('../models/User');

// 验证用户是否登录
exports.authenticate = async (req, res, next) => {
  try {
    // 从请求头获取token
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: '未提供认证令牌' });
    }
    
    const token = authHeader.substring(7);
    
    // 验证token
    const decoded = verifyToken(token);
    
    if (!decoded) {
      return res.status(401).json({ message: '无效的认证令牌' });
    }
    
    // 查询用户
    const user = await User.findById(decoded.id);
    
    if (!user) {
      return res.status(401).json({ message: '用户不存在' });
    }
    
    if (user.status !== 'active') {
      return res.status(401).json({ message: '用户已被禁用' });
    }
    
    // 将用户信息附加到请求对象
    req.user = user;
    next();
  } catch (error) {
    console.error('认证错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

// 验证用户角色
exports.authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: '未登录' });
    }
    
    // 检查用户是否拥有所需角色
    const hasRole = roles.some(role => req.user.roles.includes(role));
    
    if (!hasRole) {
      return res.status(403).json({ 
        message: '权限不足',
        requiredRoles: roles,
        userRoles: req.user.roles
      });
    }
    
    next();
  };
};

// 验证是否为管理员
exports.isAdmin = (req, res, next) => {
  if (!req.user || !req.user.roles.includes('admin')) {
    return res.status(403).json({ message: '需要管理员权限' });
  }
  next();
};

