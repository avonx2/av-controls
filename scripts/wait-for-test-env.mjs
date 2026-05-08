import net from 'node:net'

const targets = [
  { name: 'websocket broker', host: '127.0.0.1', port: 18080 },
  { name: 'av-controls e2e fixture', host: '127.0.0.1', port: 18173 },
]

const timeoutMs = 20_000
const retryDelayMs = 250

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function canConnect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })

    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })

    socket.once('error', (error) => {
      socket.destroy()
      if (error && typeof error === 'object' && 'code' in error) {
        if (error.code === 'ECONNREFUSED') {
          resolve(false)
          return
        }
        if (error.code === 'EACCES' || error.code === 'EPERM') {
          reject(new Error(`cannot probe ${host}:${port} due to permission error (${error.code})`))
          return
        }
      }
      reject(error)
    })
  })
}

async function waitForTarget(target) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await canConnect(target.host, target.port)) {
      console.info(`[av-controls:test] ready: ${target.name} on ${target.host}:${target.port}`)
      return
    }
    await sleep(retryDelayMs)
  }

  throw new Error(`timed out waiting for ${target.name} on ${target.host}:${target.port}`)
}

for (const target of targets) {
  await waitForTarget(target)
}

console.info('[av-controls:test] test environment is ready')
