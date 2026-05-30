const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const express = require('express')
const request = require('./util/request')
const packageJSON = require('./package.json')
const exec = require('child_process').exec
const cache = require('./util/apicache').middleware
const { cookieToJson } = require('./util/index')
const fileUpload = require('express-fileupload')
const decode = require('safe-decode-uri-component')

/**
 * The version check result.
 * @readonly
 * @enum {number}
 */
const VERSION_CHECK_RESULT = {
  FAILED: -1,
  NOT_LATEST: 0,
  LATEST: 1,
}

/**
 * @typedef {{
 *   identifier?: string,
 *   route: string,
 *   module: any
 * }} ModuleDefinition
 */

/**
 * @typedef {{
 *   port?: number,
 *   host?: string,
 *   checkVersion?: boolean,
 *   apiToken?: string,
 *   moduleDefs?: ModuleDefinition[]
 * }} NcmApiOptions
 */

/**
 * @typedef {{
 *   status: VERSION_CHECK_RESULT,
 *   ourVersion?: string,
 *   npmVersion?: string,
 * }} VersionCheckResult
 */

/**
 * @typedef {{
 *  server?: import('http').Server,
 * }} ExpressExtension
 */

/**
 * Get the module definitions dynamically.
 *
 * @param {string} modulesPath The path to modules (JS).
 * @param {Record<string, string>} [specificRoute] The specific route of specific modules.
 * @param {boolean} [doRequire] If true, require() the module directly.
 * Otherwise, print out the module path. Default to true.
 * @returns {Promise<ModuleDefinition[]>} The module definitions.
 *
 * @example getModuleDefinitions("./module", {"album_new.js": "/album/create"})
 */
async function getModulesDefinitions(
  modulesPath,
  specificRoute,
  doRequire = true,
) {
  const files = await fs.promises.readdir(modulesPath)
  const parseRoute = (/** @type {string} */ fileName) =>
    specificRoute && fileName in specificRoute
      ? specificRoute[fileName]
      : `/${fileName.replace(/\.js$/i, '').replace(/_/g, '/')}`

  const modules = files
    .reverse()
    .filter((file) => file.endsWith('.js'))
    .map((file) => {
      const identifier = file.split('.').shift()
      const route = parseRoute(file)
      const modulePath = path.join(modulesPath, file)
      const module = doRequire ? require(modulePath) : modulePath

      return { identifier, route, module }
    })

  return modules
}

/**
 * Check if the version of this API is latest.
 *
 * @returns {Promise<VersionCheckResult>} If true, this API is up-to-date;
 * otherwise, this API should be upgraded and you would
 * need to notify users to upgrade it manually.
 */
async function checkVersion() {
  return new Promise((resolve) => {
    exec('npm info NeteaseCloudMusicApi version', (err, stdout) => {
      if (!err) {
        let version = stdout.trim()

        /**
         * @param {VERSION_CHECK_RESULT} status
         */
        const resolveStatus = (status) =>
          resolve({
            status,
            ourVersion: packageJSON.version,
            npmVersion: version,
          })

        resolveStatus(
          packageJSON.version < version
            ? VERSION_CHECK_RESULT.NOT_LATEST
            : VERSION_CHECK_RESULT.LATEST,
        )
      } else {
        resolve({
          status: VERSION_CHECK_RESULT.FAILED,
        })
      }
    })
  })
}

const API_TOKEN_PARAM = 'apiToken'
const API_TOKEN_HEADER = 'x-api-token'

function firstString(value) {
  if (Array.isArray(value)) {
    return firstString(value[0])
  }
  if (value === undefined || value === null) {
    return ''
  }
  return String(value)
}

function hasOwn(object, key) {
  return (
    object &&
    typeof object === 'object' &&
    Object.prototype.hasOwnProperty.call(object, key)
  )
}

function getUrlPrefixApiToken(req) {
  const originalUrl = firstString(req.originalUrl || req.url)
  try {
    const url = new URL(originalUrl, 'http://localhost')
    const firstSegment = url.pathname.split('/').filter(Boolean)[0]
    return firstSegment ? decode(firstSegment) : ''
  } catch (_) {
    const firstSegment = originalUrl.split(/[/?#]/).filter(Boolean)[0]
    return firstSegment ? decode(firstSegment) : ''
  }
}

function getRequestApiToken(req) {
  const authorization = firstString(req.headers.authorization)
  const bearerToken = authorization.match(/^Bearer\s+(.+)$/i)

  if (bearerToken) {
    return bearerToken[1].trim()
  }

  const headerToken = firstString(req.headers[API_TOKEN_HEADER])
  if (headerToken) {
    return headerToken
  }

  if (hasOwn(req.query, API_TOKEN_PARAM)) {
    return firstString(req.query[API_TOKEN_PARAM])
  }

  if (hasOwn(req.body, API_TOKEN_PARAM)) {
    return firstString(req.body[API_TOKEN_PARAM])
  }

  return ''
}

function stripApiTokenQueryFromUrl(value) {
  try {
    const url = new URL(value, 'http://localhost')
    url.searchParams.delete(API_TOKEN_PARAM)
    return `${url.pathname}${url.search}${url.hash}`
  } catch (_) {
    const withoutToken = value.replace(
      new RegExp(`([?&])${API_TOKEN_PARAM}=[^&]*`, 'gi'),
      '$1',
    )
    return withoutToken
      .replace(/&&+/g, '&')
      .replace(/\?&+/, '?')
      .replace(/[?&]$/, '')
  }
}

function stripApiTokenPrefixFromUrl(value, apiToken) {
  try {
    const url = new URL(value, 'http://localhost')
    const segments = url.pathname.split('/')

    if (segments.length > 1 && decode(segments[1]) === apiToken) {
      segments.splice(1, 1)
      url.pathname = segments.join('/') || '/'
    }

    return `${url.pathname}${url.search}${url.hash}`
  } catch (_) {
    const escapedApiToken = apiToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return value.replace(new RegExp(`^/${escapedApiToken}(?=/|$)`), '') || '/'
  }
}

function removeRequestApiToken(req) {
  if (hasOwn(req.query, API_TOKEN_PARAM)) {
    delete req.query[API_TOKEN_PARAM]
  }

  if (hasOwn(req.body, API_TOKEN_PARAM)) {
    delete req.body[API_TOKEN_PARAM]
  }

  if (typeof req.url === 'string') {
    req.url = stripApiTokenQueryFromUrl(req.url)
  }

  if (typeof req.originalUrl === 'string') {
    req.originalUrl = stripApiTokenQueryFromUrl(req.originalUrl)
  }
}

function removeUrlPrefixApiToken(req, apiToken) {
  if (typeof req.url === 'string') {
    req.url = stripApiTokenPrefixFromUrl(req.url, apiToken)
  }

  if (typeof req.originalUrl === 'string') {
    req.originalUrl = stripApiTokenPrefixFromUrl(req.originalUrl, apiToken)
  }
}

function isApiTokenValid(requestToken, apiToken) {
  if (!apiToken) {
    return true
  }

  if (!requestToken) {
    return false
  }

  const requestTokenBuffer = Buffer.from(requestToken)
  const apiTokenBuffer = Buffer.from(apiToken)

  if (requestTokenBuffer.length !== apiTokenBuffer.length) {
    return false
  }

  return crypto.timingSafeEqual(requestTokenBuffer, apiTokenBuffer)
}

function createApiTokenAuth(apiToken) {
  return (req, res, next) => {
    if (!apiToken) {
      next()
      return
    }

    const urlPrefixToken = getUrlPrefixApiToken(req)
    const requestToken =
      urlPrefixToken === apiToken ? urlPrefixToken : getRequestApiToken(req)

    if (urlPrefixToken === apiToken) {
      removeUrlPrefixApiToken(req, apiToken)
    }

    removeRequestApiToken(req)

    if (!isApiTokenValid(requestToken, apiToken)) {
      res.status(401).send({
        code: 401,
        data: null,
        msg: 'Unauthorized',
      })
      return
    }

    next()
  }
}

function redactApiTokenFromUrl(originalUrl) {
  try {
    const url = new URL(originalUrl, 'http://localhost')
    if (url.searchParams.has(API_TOKEN_PARAM)) {
      url.searchParams.set(API_TOKEN_PARAM, '[REDACTED]')
    }
    return `${url.pathname}${url.search}${url.hash}`
  } catch (_) {
    return originalUrl.replace(
      new RegExp(`([?&]${API_TOKEN_PARAM}=)[^&]*`, 'gi'),
      '$1[REDACTED]',
    )
  }
}

/**
 * Construct the server of NCM API.
 *
 * @param {ModuleDefinition[]} [moduleDefs] Customized module definitions [advanced]
 * @param {string} [apiToken] Token required by HTTP API requests.
 * @returns {Promise<import("express").Express>} The server instance.
 */
async function consturctServer(moduleDefs, apiToken) {
  const app = express()
  const { CORS_ALLOW_ORIGIN } = process.env
  app.set('trust proxy', true)

  /**
   * Serving static files
   */
  app.use(express.static(path.join(__dirname, 'public')))
  /**
   * CORS & Preflight request
   */
  app.use((req, res, next) => {
    if (req.path !== '/' && !req.path.includes('.')) {
      res.set({
        'Access-Control-Allow-Credentials': true,
        'Access-Control-Allow-Origin':
          CORS_ALLOW_ORIGIN || req.headers.origin || '*',
        'Access-Control-Allow-Headers':
          'X-Requested-With,Content-Type,Authorization,X-API-Token',
        'Access-Control-Allow-Methods': 'PUT,POST,GET,DELETE,OPTIONS',
        'Content-Type': 'application/json; charset=utf-8',
      })
    }
    req.method === 'OPTIONS' ? res.status(204).end() : next()
  })

  /**
   * Cookie Parser
   */
  app.use((req, _, next) => {
    req.cookies = {}
    //;(req.headers.cookie || '').split(/\s*;\s*/).forEach((pair) => { //  Polynomial regular expression //
    ;(req.headers.cookie || '').split(/;\s+|(?<!\s)\s+$/g).forEach((pair) => {
      let crack = pair.indexOf('=')
      if (crack < 1 || crack == pair.length - 1) return
      req.cookies[decode(pair.slice(0, crack)).trim()] = decode(
        pair.slice(crack + 1),
      ).trim()
    })
    next()
  })

  /**
   * Body Parser and File Upload
   */
  app.use(express.json({ limit: '50mb' }))
  app.use(express.urlencoded({ extended: false, limit: '50mb' }))

  app.use(createApiTokenAuth(apiToken))

  app.use(fileUpload())

  /**
   * Cache
   */
  app.use(cache('2 minutes', (_, res) => res.statusCode === 200))

  /**
   * Special Routers
   */
  const special = {
    'daily_signin.js': '/daily_signin',
    'fm_trash.js': '/fm_trash',
    'personal_fm.js': '/personal_fm',
  }

  /**
   * Load every modules in this directory
   */
  const moduleDefinitions =
    moduleDefs ||
    (await getModulesDefinitions(path.join(__dirname, 'module'), special))

  for (const moduleDef of moduleDefinitions) {
    // Register the route.
    app.use(moduleDef.route, async (req, res) => {
      ;[req.query, req.body].forEach((item) => {
        if (typeof item.cookie === 'string') {
          item.cookie = cookieToJson(decode(item.cookie))
        }
      })

      let query = Object.assign(
        {},
        { cookie: req.cookies },
        req.query,
        req.body,
        req.files,
      )

      try {
        const moduleResponse = await moduleDef.module(query, (...params) => {
          // 参数注入客户端IP
          const obj = [...params]
          let ip = req.ip

          if (ip.substring(0, 7) == '::ffff:') {
            ip = ip.substring(7)
          }
          if (ip == '::1') {
            ip = global.cnIp
          }
          // console.log(ip)
          obj[3] = {
            ...obj[3],
            ip,
          }
          return request(...obj)
        })
        console.log('[OK]', decode(redactApiTokenFromUrl(req.originalUrl)))

        const cookies = moduleResponse.cookie
        if (!query.noCookie) {
          if (Array.isArray(cookies) && cookies.length > 0) {
            if (req.protocol === 'https') {
              // Try to fix CORS SameSite Problem
              res.append(
                'Set-Cookie',
                cookies.map((cookie) => {
                  return cookie + '; SameSite=None; Secure'
                }),
              )
            } else {
              res.append('Set-Cookie', cookies)
            }
          }
        }
        res.status(moduleResponse.status).send(moduleResponse.body)
      } catch (/** @type {*} */ moduleResponse) {
        console.log('[ERR]', decode(redactApiTokenFromUrl(req.originalUrl)), {
          status: moduleResponse.status,
          body: moduleResponse.body,
        })
        if (!moduleResponse.body) {
          res.status(404).send({
            code: 404,
            data: null,
            msg: 'Not Found',
          })
          return
        }
        if (moduleResponse.body.code == '301')
          moduleResponse.body.msg = '需要登录'
        if (!query.noCookie) {
          res.append('Set-Cookie', moduleResponse.cookie)
        }

        res.status(moduleResponse.status).send(moduleResponse.body)
      }
    })
  }

  return app
}

/**
 * Serve the NCM API.
 * @param {NcmApiOptions} options
 * @returns {Promise<import('express').Express & ExpressExtension>}
 */
async function serveNcmApi(options = {}) {
  const port = Number(
    options.port !== undefined ? options.port : process.env.PORT || '3000',
  )
  const host = options.host || process.env.HOST || ''
  const apiToken =
    options.apiToken || process.env.API_TOKEN || process.env.NCM_API_TOKEN || ''

  const checkVersionSubmission =
    options.checkVersion &&
    checkVersion().then(({ npmVersion, ourVersion, status }) => {
      if (status == VERSION_CHECK_RESULT.NOT_LATEST) {
        console.log(
          `最新版本: ${npmVersion}, 当前版本: ${ourVersion}, 请及时更新`,
        )
      }
    })
  const constructServerSubmission = consturctServer(options.moduleDefs, apiToken)

  const [_, app] = await Promise.all([
    checkVersionSubmission,
    constructServerSubmission,
  ])

  /** @type {import('express').Express & ExpressExtension} */
  const appExt = app
  appExt.server = app.listen(port, host, () => {
    const address = appExt.server && appExt.server.address()
    const displayPort =
      address && typeof address === 'object' ? address.port : port
    console.log(
      `server running @ http://${host ? host : 'localhost'}:${displayPort}`,
    )
    if (apiToken) {
      console.log('api token auth enabled')
    }
  })

  return appExt
}

module.exports = {
  serveNcmApi,
  getModulesDefinitions,
}
