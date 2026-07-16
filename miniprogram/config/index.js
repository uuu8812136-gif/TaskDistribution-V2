// 环境配置
const env = process.env.NODE_ENV || 'development'

const config = {
  development: {
    // 开发环境API地址
    baseURL: 'https://www.horselink.cn/api',
    uploadURL: 'https://www.horselink.cn/'
  },
  production: {
    // 生产环境API地址
    baseURL: 'https://www.horselink.cn/api',
    uploadURL: 'https://www.horselink.cn/'
  }
}

export default config[env]

