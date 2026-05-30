#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const tmpPath = require('os').tmpdir()

function parseStartOptions(argv) {
  const options = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '--api-token' || arg === '--token') {
      if (i + 1 >= argv.length) {
        throw new Error(`${arg} requires a value`)
      }
      options.apiToken = argv[i + 1]
      i++
      continue
    }

    if (arg.startsWith('--api-token=')) {
      options.apiToken = arg.slice('--api-token='.length)
      if (!options.apiToken) {
        throw new Error('--api-token requires a value')
      }
      continue
    }

    if (arg.startsWith('--token=')) {
      options.apiToken = arg.slice('--token='.length)
      if (!options.apiToken) {
        throw new Error('--token requires a value')
      }
    }
  }

  return options
}

async function start() {
  const startOptions = parseStartOptions(process.argv.slice(2))

  // 检测是否存在 anonymous_token 文件,没有则生成
  if (!fs.existsSync(path.resolve(tmpPath, 'anonymous_token'))) {
    fs.writeFileSync(path.resolve(tmpPath, 'anonymous_token'), '', 'utf-8')
  }
  // 启动时更新anonymous_token
  const generateConfig = require('./generateConfig')
  await generateConfig()
  require('./server').serveNcmApi({
    checkVersion: true,
    apiToken: startOptions.apiToken,
  })
}
start()
