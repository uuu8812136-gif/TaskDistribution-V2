'use strict';

const TOKEN_INVALID_CODES = new Set([40014, 42001]);

class WechatApiError extends Error {
  constructor(code, message, { transient = false, platformCode = null } = {}) {
    super(message);
    this.name = 'WechatApiError';
    this.code = code;
    this.transient = transient;
    this.platformCode = platformCode;
  }
}

function platformError(payload, operation) {
  const platformCode = Number(payload?.errcode);
  return new WechatApiError(
    `WECHAT_${operation}_${Number.isFinite(platformCode) ? platformCode : 'INVALID_RESPONSE'}`,
    `WeChat ${operation.toLowerCase()} failed`,
    {
      transient: platformCode === -1 || platformCode === 45009,
      platformCode: Number.isFinite(platformCode) ? platformCode : null
    }
  );
}

function createWechatMiniProgramClient({ appId, appSecret, fetchImpl = globalThis.fetch, now = Date.now }) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  let cachedToken = null;
  let tokenExpiresAt = 0;

  async function requestJson(url, options = {}) {
    let response;
    try {
      response = await fetchImpl(url, {
        ...options,
        signal: options.signal || AbortSignal.timeout(10000)
      });
    } catch (error) {
      throw new WechatApiError('WECHAT_NETWORK_ERROR', 'WeChat request failed', {
        transient: true
      });
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new WechatApiError('WECHAT_RESPONSE_INVALID', 'WeChat returned an invalid response', {
        transient: response.status >= 500
      });
    }
    if (!response.ok) {
      throw new WechatApiError(`WECHAT_HTTP_${response.status}`, 'WeChat request failed', {
        transient: response.status >= 500
      });
    }
    return payload;
  }

  async function exchangeLoginCode(code) {
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.searchParams.set('appid', appId);
    url.searchParams.set('secret', appSecret);
    url.searchParams.set('js_code', code);
    url.searchParams.set('grant_type', 'authorization_code');
    const payload = await requestJson(url);
    if (payload.errcode) throw platformError(payload, 'CODE_EXCHANGE');
    if (typeof payload.openid !== 'string' || !payload.openid) {
      throw new WechatApiError('WECHAT_OPENID_MISSING', 'WeChat login did not return an OpenID');
    }
    return { openId: payload.openid, unionId: payload.unionid || null };
  }

  async function accessToken(forceRefresh = false) {
    if (!forceRefresh && cachedToken && now() < tokenExpiresAt) return cachedToken;
    const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
    url.searchParams.set('grant_type', 'client_credential');
    url.searchParams.set('appid', appId);
    url.searchParams.set('secret', appSecret);
    const payload = await requestJson(url);
    if (payload.errcode) throw platformError(payload, 'TOKEN');
    if (typeof payload.access_token !== 'string' || !payload.access_token) {
      throw new WechatApiError('WECHAT_TOKEN_MISSING', 'WeChat did not return an access token');
    }
    const expiresIn = Number(payload.expires_in) || 7200;
    cachedToken = payload.access_token;
    tokenExpiresAt = now() + Math.max(60, expiresIn - 300) * 1000;
    return cachedToken;
  }

  async function sendSubscriptionMessage(payload, allowTokenRefresh = true) {
    const token = await accessToken(false);
    const url = new URL('https://api.weixin.qq.com/cgi-bin/message/subscribe/send');
    url.searchParams.set('access_token', token);
    let result;
    try {
      result = await requestJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      // A broken response after the send request is ambiguous. Retrying could
      // consume a second one-time grant and deliver the same notice twice.
      error.deliveryOutcomeUnknown = true;
      throw error;
    }
    if (!result.errcode) return result;
    if (allowTokenRefresh && TOKEN_INVALID_CODES.has(Number(result.errcode))) {
      await accessToken(true);
      return sendSubscriptionMessage(payload, false);
    }
    throw platformError(result, 'SEND');
  }

  return Object.freeze({ exchangeLoginCode, sendSubscriptionMessage });
}

module.exports = { WechatApiError, createWechatMiniProgramClient };
