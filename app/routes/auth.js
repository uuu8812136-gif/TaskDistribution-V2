const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate, isAdmin } = require('../middlewares/auth');

// 用户注册
router.post('/register', authenticate, isAdmin, authController.register);

// 用户登录
router.post('/login', authController.login);

// 获取当前用户信息（需要登录）
router.get('/me', authenticate, authController.getCurrentUser);

// 修改密码（需要登录）
router.post('/change-password', authenticate, authController.changePassword);

module.exports = router;

