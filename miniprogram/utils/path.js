import config from '@/config/index.js'

/**
 * 将文件路径转换为完整的 URL
 * @param {string} path - 文件路径
 * @returns {string} 完整的 URL
 */
export function getFullFileUrl(path) {
	if (!path) {
		return ''
	}
	
	// 如果已经是完整URL，直接返回
	if (path.startsWith('http://') || path.startsWith('https://')) {
		return path
	}
	
	// 获取基础URL（不带 /api）
	const baseUrl = config.uploadURL || config.baseURL.replace('/api', '')
	
	// 将 Windows 路径的反斜杠转换为正斜杠
	let normalizedPath = path.replace(/\\/g, '/')
	
	// 确保路径以 / 开头
	if (!normalizedPath.startsWith('/')) {
		normalizedPath = '/' + normalizedPath
	}
	
	return baseUrl + normalizedPath
}

/**
 * 从附件列表中提取图片
 * @param {Array} attachments - 附件列表
 * @returns {Array} 图片列表
 */
export function getImages(attachments) {
	if (!attachments || !Array.isArray(attachments)) {
		return []
	}
	return attachments.filter(att => {
		const mimetype = att.mimetype || ''
		return mimetype.startsWith('image/')
	})
}

/**
 * 从附件列表中提取非图片文件
 * @param {Array} attachments - 附件列表
 * @returns {Array} 文件列表
 */
export function getFiles(attachments) {
	if (!attachments || !Array.isArray(attachments)) {
		return []
	}
	return attachments.filter(att => {
		const mimetype = att.mimetype || ''
		return !mimetype.startsWith('image/')
	})
}

/**
 * 格式化文件大小
 * @param {number} bytes - 字节数
 * @returns {string} 格式化后的大小
 */
export function formatFileSize(bytes) {
	if (!bytes || bytes === 0) return '0 B'
	const k = 1024
	const sizes = ['B', 'KB', 'MB', 'GB']
	const i = Math.floor(Math.log(bytes) / Math.log(k))
	return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i]
}

