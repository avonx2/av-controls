import net from 'node:net'

const ports = [
  { name: 'websocket broker', port: 18080 },
  { name: 'av-controls e2e fixture', port: 18173 },
]

function checkPortInUse(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()

    server.once('error', (error) => {
      if (error && typeof error === 'object' && 'code' in error) {
        if (error.code === 'EADDRINUSE') {
          resolve(true)
          return
        }
        if (error.code === 'EACCES' || error.code === 'EPERM') {
          reject(new Error(`cannot probe 127.0.0.1:${port} due to permission error (${error.code})`))
          return
        }
      }
      reject(error)
    })

    server.listen(port, '127.0.0.1', () => {
      server.close((closeError) => {
        if (closeError) {
          reject(closeError)
          return
        }
        resolve(false)
      })
    })
  })
}

const occupied = []

for (const { name, port } of ports) {
  const inUse = await checkPortInUse(port)
  if (inUse) {
    occupied.push(`${name} on 127.0.0.1:${port}`)
  }
}

if (occupied.length > 0) {
  console.error('[av-controls:test-env] aborting because test ports are already in use:')
  for (const line of occupied) {
    console.error(`- ${line}`)
  }
  process.exit(1)
}

console.info('[av-controls:test-env] test ports are free')
