const assert = require('assert')
const { default: axios } = require('axios')
const main = require('./main')

describe('methods in server.js', () => {
  it('has serveNcmApi', () => {
    assert.strictEqual(typeof main.serveNcmApi, 'function')
  })

  it('has getModulesDefinitions', () => {
    assert.strictEqual(typeof main.getModulesDefinitions, 'function')
  })
})

describe('methods in module', () => {
  it('has activate_init_profile', () => {
    assert.strictEqual(typeof main.activate_init_profile, 'function')
  })
})

describe('api token auth', () => {
  const apiToken = 'test-secret'
  let app
  let host

  before(async () => {
    app = await main.serveNcmApi({
      port: 0,
      host: '127.0.0.1',
      apiToken,
      moduleDefs: [
        {
          route: '/mock',
          module: async (query) => ({
            status: 200,
            body: {
              code: 200,
              keyword: query.keyword,
              hasApiToken: Object.prototype.hasOwnProperty.call(
                query,
                'apiToken',
              ),
            },
          }),
        },
      ],
    })

    if (!app.server) {
      throw new Error('failed to set up token auth server')
    }

    await new Promise((resolve, reject) => {
      if (!app.server) {
        reject(new Error('failed to set up token auth server'))
        return
      }

      if (app.server.listening) {
        resolve()
        return
      }

      app.server.once('listening', resolve)
      app.server.once('error', reject)
    })

    const address = app.server && app.server.address()
    if (!address || typeof address !== 'object') {
      throw new Error('failed to set up token auth server')
    }
    host = `http://127.0.0.1:${address.port}`
  })

  after((done) => {
    if (app.server) {
      app.server.close(done)
      return
    }

    done(new Error('failed to close token auth server'))
  })

  it('rejects requests without token', async () => {
    const response = await axios.get(`${host}/mock`, {
      validateStatus: () => true,
    })

    assert.strictEqual(response.status, 401)
    assert.strictEqual(response.data.code, 401)
  })

  it('rejects static index without token', async () => {
    const response = await axios.get(`${host}/`, {
      validateStatus: () => true,
    })

    assert.strictEqual(response.status, 401)
    assert.strictEqual(response.data.code, 401)
  })

  it('accepts static index with api token in url prefix', async () => {
    const response = await axios.get(`${host}/${apiToken}/`)

    assert.strictEqual(response.status, 200)
    assert(response.data.includes('<html'))
  })

  it('accepts api token in url prefix', async () => {
    const response = await axios.get(`${host}/${apiToken}/mock`, {
      params: {
        keyword: 'test',
      },
    })

    assert.strictEqual(response.status, 200)
    assert.strictEqual(response.data.code, 200)
    assert.strictEqual(response.data.keyword, 'test')
  })

  it('rejects wrong api token in url prefix', async () => {
    const response = await axios.get(`${host}/wrong-token/mock`, {
      validateStatus: () => true,
    })

    assert.strictEqual(response.status, 401)
    assert.strictEqual(response.data.code, 401)
  })

  it('accepts x-api-token header', async () => {
    const response = await axios.get(`${host}/mock`, {
      headers: {
        'X-API-Token': apiToken,
      },
    })

    assert.strictEqual(response.status, 200)
    assert.strictEqual(response.data.code, 200)
  })

  it('accepts authorization bearer token', async () => {
    const response = await axios.get(`${host}/mock`, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
    })

    assert.strictEqual(response.status, 200)
    assert.strictEqual(response.data.code, 200)
  })

  it('accepts apiToken query and strips it from module params', async () => {
    const response = await axios.get(`${host}/mock`, {
      params: {
        apiToken,
      },
    })

    assert.strictEqual(response.status, 200)
    assert.strictEqual(response.data.hasApiToken, false)
  })
})
