const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');

// 加载环境变量
dotenv.config();

const app = express();

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 静态文件服务（上传的文件）
app.use('/uploads', express.static('uploads'));

// MongoDB连接
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => {
  console.log('✅ MongoDB连接成功');
})
.catch(err => {
  console.error('❌ MongoDB连接失败:', err.message);
  process.exit(1);
});

// 测试路由
app.get('/', (req, res) => {
  res.json({ 
    message: 'Horselink（马链）任务管理系统API',
    version: '1.0.0',
    status: 'running'
  });
});

// 路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/extensions', require('./routes/extensions'));
app.use('/api/statistics', require('./routes/statistics'));
app.use('/api/messages', require('./routes/messages'));

// 通用文件上传路由
const upload = require('./middlewares/upload');
const { authenticate } = require('./middlewares/auth');
app.post('/api/upload', authenticate, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: '没有上传文件' });
    }
    
    // 处理中文文件名编码
    let originalName;
    
    // 优先使用 friendlyName（小程序端生成的友好文件名）
    if (req.body.friendlyName) {
      originalName = req.body.friendlyName;
    } else {
      // 否则使用 multer 解析的文件名（需要转码）
      originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    }
    
    res.json({
      message: '文件上传成功',
      filePath: `/uploads/${req.file.filename}`,
      originalName: originalName,
      size: req.file.size,
      mimetype: req.file.mimetype
    });
  } catch (error) {
    console.error('文件上传错误:', error);
    res.status(500).json({ message: '文件上传失败' });
  }
});

// 404处理
app.use((req, res) => {
  res.status(404).json({ message: '接口不存在' });
});

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    message: '服务器内部错误',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

const PORT = process.env.PORT || 8099;

app.listen(PORT, () => {
  console.log(`🚀 服务器运行在端口 ${PORT}`);
  console.log(`📍 环境: ${process.env.NODE_ENV}`);
});

