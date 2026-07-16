import config from '@/config/index.js'

/**
 * 请求拦截器
 */
const requestInterceptor = (options) => {
  // 获取token
  const token = uni.getStorageSync('token')
  
  // 设置请求头
  options.header = {
    'Content-Type': 'application/json',
    ...options.header
  }
  
  // 添加token
  if (token) {
    options.header.Authorization = `Bearer ${token}`
  }
  
  // 添加baseURL
  if (!options.url.startsWith('http')) {
    options.url = config.baseURL + options.url
  }
  
  return options
}

/**
 * 响应拦截器
 */
const responseInterceptor = (response) => {
  const { statusCode, data } = response
  
  // HTTP状态码处理
  if (statusCode === 200 || statusCode === 201) {
    return Promise.resolve(data)
  }
  
  // 401 未授权，跳转登录
  if (statusCode === 401) {
    uni.showToast({
      title: '登录已过期，请重新登录',
      icon: 'none',
      duration: 2000
    })
    
    // 清除token
    uni.removeStorageSync('token')
    uni.removeStorageSync('userInfo')
    
    // 跳转登录页
    setTimeout(() => {
      uni.reLaunch({
        url: '/pages/login/index'
      })
    }, 2000)
    
    return Promise.reject(new Error('未授权'))
  }
  
  // 403 无权限
  if (statusCode === 403) {
    uni.showToast({
      title: data.message || '没有权限',
      icon: 'none',
      duration: 2000
    })
    return Promise.reject(new Error(data.message || '没有权限'))
  }
  
  // 404 资源不存在
  if (statusCode === 404) {
    uni.showToast({
      title: data.message || '请求的资源不存在',
      icon: 'none',
      duration: 2000
    })
    return Promise.reject(new Error(data.message || '请求的资源不存在'))
  }
  
  // 500 服务器错误
  if (statusCode === 500) {
    uni.showToast({
      title: data.message || '服务器错误',
      icon: 'none',
      duration: 2000
    })
    return Promise.reject(new Error(data.message || '服务器错误'))
  }
  
  // 其他错误
  uni.showToast({
    title: data.message || '请求失败',
    icon: 'none',
    duration: 2000
  })
  
  return Promise.reject(new Error(data.message || '请求失败'))
}

/**
 * 网络请求封装
 */
const request = (options) => {
  return new Promise((resolve, reject) => {
    // 请求拦截
    options = requestInterceptor(options)
    
    // 显示loading
    if (options.showLoading !== false) {
      uni.showLoading({
        title: options.loadingText || '加载中...',
        mask: true
      })
    }
    
    // 发起请求
    uni.request({
      ...options,
      success: (res) => {
        // 隐藏loading
        if (options.showLoading !== false) {
          uni.hideLoading()
        }
        
        // 响应拦截
        responseInterceptor(res)
          .then(data => resolve(data))
          .catch(err => reject(err))
      },
      fail: (err) => {
        // 隐藏loading
        if (options.showLoading !== false) {
          uni.hideLoading()
        }
        
        // 网络错误
        uni.showToast({
          title: '网络错误，请检查网络连接',
          icon: 'none',
          duration: 2000
        })
        
        reject(new Error('网络错误'))
      }
    })
  })
}

/**
 * GET 请求
 */
export const get = (url, params = {}, options = {}) => {
  return request({
    url,
    method: 'GET',
    data: params,
    ...options
  })
}

/**
 * POST 请求
 */
export const post = (url, data = {}, options = {}) => {
  return request({
    url,
    method: 'POST',
    data,
    ...options
  })
}

/**
 * PUT 请求
 */
export const put = (url, data = {}, options = {}) => {
  return request({
    url,
    method: 'PUT',
    data,
    ...options
  })
}

/**
 * DELETE 请求
 */
export const del = (url, data = {}, options = {}) => {
  return request({
    url,
    method: 'DELETE',
    data,
    ...options
  })
}

/**
 * 文件上传
 */
export const upload = (url, filePath, formData = {}, options = {}) => {
  return new Promise((resolve, reject) => {
    // 获取token
    const token = uni.getStorageSync('token')
    
    // 显示loading
    if (options.showLoading !== false) {
      uni.showLoading({
        title: '上传中...',
        mask: true
      })
    }
    
    // 上传文件
    uni.uploadFile({
      url: config.baseURL + url,
      filePath,
      name: options.name || 'file',
      formData,
      header: {
        Authorization: token ? `Bearer ${token}` : '',
        ...options.header
      },
      success: (res) => {
        // 隐藏loading
        if (options.showLoading !== false) {
          uni.hideLoading()
        }
        
        const data = JSON.parse(res.data)
        
        if (res.statusCode === 200 || res.statusCode === 201) {
          resolve(data)
        } else {
          uni.showToast({
            title: data.message || '上传失败',
            icon: 'none',
            duration: 2000
          })
          reject(new Error(data.message || '上传失败'))
        }
      },
      fail: (err) => {
        // 隐藏loading
        if (options.showLoading !== false) {
          uni.hideLoading()
        }
        
        uni.showToast({
          title: '上传失败',
          icon: 'none',
          duration: 2000
        })
        
        reject(err)
      }
    })
  })
}

export default request

