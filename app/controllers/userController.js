const User = require('../models/User');

// 获取所有用户（管理员）
exports.getAllUsers = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, role, keyword } = req.query;
    
    // 构建查询条件
    const query = {};
    
    if (status) {
      query.status = status;
    }
    
    if (role) {
      query.roles = role;
    }
    
    if (keyword) {
      query.$or = [
        { username: new RegExp(keyword, 'i') },
        { name: new RegExp(keyword, 'i') },
        { phone: new RegExp(keyword, 'i') }
      ];
    }
    
    // 分页查询
    const skip = (page - 1) * limit;
    const users = await User.find(query)
      .select('-password')
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });
    
    const total = await User.countDocuments(query);
    
    res.json({
      users,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('获取用户列表错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

// 获取单个用户信息
exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    
    if (!user) {
      return res.status(404).json({ message: '用户不存在' });
    }
    
    res.json({ user });
  } catch (error) {
    console.error('获取用户信息错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

// 创建用户（管理员）
exports.createUser = async (req, res) => {
  try {
    console.log('📝 收到创建用户请求:', req.body);
    console.log('🔑 请求用户:', req.user?.username);
    
    const { username, password, name, phone, email, roles, department, status } = req.body;
    
    // 验证必填字段
    if (!username || !password || !name) {
      console.log('❌ 必填字段缺失');
      return res.status(400).json({ message: '用户名、密码和姓名不能为空' });
    }
    
    // 检查用户名是否已存在
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      console.log('❌ 用户名已存在:', username);
      return res.status(400).json({ message: '用户名已存在' });
    }
    
    // 创建用户
    const user = new User({
      username,
      password,
      name,
      phone,
      email,
      roles: roles || ['executor'],
      department,
      status: status || 'active'
    });
    
    await user.save();
    console.log('✅ 用户创建成功:', user.username);
    
    res.status(201).json({
      message: '用户创建成功',
      user: user.toJSON()
    });
  } catch (error) {
    console.error('❌ 创建用户错误:', error);
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      console.log('❌ 验证错误:', messages);
      return res.status(400).json({ message: messages.join(', ') });
    }
    
    res.status(500).json({ message: '服务器错误: ' + error.message });
  }
};

// 更新用户信息
exports.updateUser = async (req, res) => {
  try {
    const { name, phone, email, roles, department, status } = req.body;
    
    const user = await User.findById(req.params.id);
    
    if (!user) {
      return res.status(404).json({ message: '用户不存在' });
    }
    
    // 更新字段
    if (name) user.name = name;
    if (phone) user.phone = phone;
    if (email) user.email = email;
    if (roles) user.roles = roles;
    if (department) user.department = department;
    if (status) user.status = status;
    
    await user.save();
    
    res.json({
      message: '用户信息更新成功',
      user: user.toJSON()
    });
  } catch (error) {
    console.error('更新用户信息错误:', error);
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({ message: messages.join(', ') });
    }
    
    res.status(500).json({ message: '服务器错误' });
  }
};

// 删除用户
exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    
    if (!user) {
      return res.status(404).json({ message: '用户不存在' });
    }
    
    // 不能删除自己
    if (user._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: '不能删除自己' });
    }
    
    await User.findByIdAndDelete(req.params.id);
    
    res.json({ message: '用户删除成功' });
  } catch (error) {
    console.error('删除用户错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

// 重置用户密码（管理员）
exports.resetPassword = async (req, res) => {
  try {
    const { newPassword } = req.body;
    
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: '新密码至少6个字符' });
    }
    
    const user = await User.findById(req.params.id);
    
    if (!user) {
      return res.status(404).json({ message: '用户不存在' });
    }
    
    user.password = newPassword;
    await user.save();
    
    res.json({ message: '密码重置成功' });
  } catch (error) {
    console.error('重置密码错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

