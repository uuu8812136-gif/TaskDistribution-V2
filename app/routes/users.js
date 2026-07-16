const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticate, isAdmin } = require('../middlewares/auth');

// 所有路由都需要登录
router.use(authenticate);

// 获取所有用户（管理员）
router.get('/', isAdmin, userController.getAllUsers);

// 获取单个用户信息
router.get('/:id', userController.getUserById);

// 创建用户（管理员）
router.post('/', isAdmin, userController.createUser);

// 更新用户信息（管理员）
router.put('/:id', isAdmin, userController.updateUser);

// 删除用户（管理员）
router.delete('/:id', isAdmin, userController.deleteUser);

// 重置用户密码（管理员）
router.post('/:id/reset-password', isAdmin, userController.resetPassword);

module.exports = router;

