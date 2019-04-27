#!/usr/bin/env node

const serveHandler = require('serve-handler')
const { readFileSync } = require('fs')
const http = require('http')
const https = require('https')
const { spawn } = require('child_process')
const { resolve, relative } = require('path')
const { watch } = require('chokidar')
const { parse: parseUrl } = require('url')
const parseArgs = require('mri')
const boxen = require('boxen')
const chalk = require('chalk')

const options = parseArgs(process.argv.slice(2), {
    default: {
        listen: 'tcp://localhost:3000',
        https: false,
        config: './serve.json',
        reload: '/__reload',
        watch: [],
        make: [],
        program: 'make',
        cors: '*'
    },
    alias: {
        l: 'listen',
        c: 'config'
    },
    boolean: [
        'https'
    ],
    string: [
        'make',
        'listen',
        'config',
        'reload',
        'cert',
        'key',
        'program'
    ]
})

const public = resolve(options._.shift() || process.cwd())
const serveOptions = { public }

try {
    const serveConfig = JSON.parse(readFileSync(resolve(process.cwd(), options.config)))
    Object.assign(serveOptions, serveConfig)
} catch (error) {
    if (error.code !== 'ENOENT') {
        throw error
    }
}

const watchPatterns = typeof options.watch === 'string' ? [ options.watch ] : options.watch
const makeTargets = typeof options.make === 'string' ? [ options.make ] : options.make

const server = !options.https
    ? http.createServer()
    : https.createServer({
        cert: readFileSync(options.cert),
        key: readFileSync(options.key)
    })

const sse = {}
let nextId = 0

server.on('request', (request, response) => {
    // If there is watchers available, and the reload URL is requested, handle as SSE.
    if (watchPatterns.length && request.url === options.reload) {
        const id = nextId++
        sse[id] = response

        request.on('close', () => {
            delete sse[id]
        })

        response.writeHead(200, {
            'Connection': 'keep-alive',
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache'
        })

        return response.write('\n')
    }

    response.setHeader('Access-Control-Allow-Origin', options.cors)

    // Pass every other request to serve requests to serve
    return serveHandler(request, response, serveOptions)
})

// Create file watchers that execute Make and send SSE events.
for (let i = 0; i < watchPatterns.length; i++) {
    const watchPattern = watchPatterns[i]
    const makeTarget = makeTargets[i]
    const watcher = watch(watchPattern)

    watcher.on('change', file => {
        console.log('changed ' + resolve(file))

        if (makeTarget) {
            console.log(options.program + ' ' + makeTarget)

            const proc = spawn(options.program, [ makeTarget ], { stdio: 'inherit' })

            proc.on('close', () => {
                for (const id in sse) {
                    sse[id].write('data: ' + file + '\n\n')
                }
            })
        } else {
            for (const id in sse) {
                sse[id].write('data: ' + file + '\n\n')
            }
        }
    })
}

// Listen and print fancy serve-like box.
server.listen(...parseListenOption(options.listen), () => {
    const details = server.address()
    const address = details.address === '::' ? 'localhost' : details.address
    const localAddress = `${options.https ? 'https' : 'http'}://${address}:${details.port}`

    let message = chalk.blue('Serving') + '\n\n'
    message += '- Public:  ' + chalk.blue(public) + '\n'
    message += '- Local:   ' + chalk.blue(localAddress)

    if (watchPatterns.length) {
        message += '\n'
        message += '- Reload:  ' + chalk.blue(localAddress + options.reload)
    }

    if (makeTargets.length || watchPatterns.length) {
        message += '\n\n'
        message += chalk.blue('Watching & Rebuilding')
        message += '\n'
    }

    if (makeTargets.length) {
        message += '\n'

        let longestTarget = 0
        const parts = {}

        for (const makeTarget of makeTargets) {
            if (longestTarget < makeTarget.length) {
                longestTarget = makeTarget.length
            }
        }

        for (let i = 0; i < makeTargets.length; i++) {
            const makeTarget = makeTargets[i]

            if (longestTarget < makeTarget.length) {
                longestTarget = makeTarget.length
            }

            const part = parts[makeTarget] = parts[makeTarget] || []
            const watchPattern = watchPatterns[i]

            if (watchPattern) {
                part.push(watchPattern)
            }
        }

        const targets = Object.keys(parts)

        for (let i = 0; i < targets.length; i++) {
            const targetName = targets[i]
            const patterns = parts[targetName]

            if (patterns.length === 0) {
                message += '- Unavailable build ' + chalk.yellow('make ' + targetName)
            } else {
                message += '- Changing ' + chalk.blue(watchPatterns[i]) + ' builds ' + chalk.blue('make ' + targetName)
            }

            if (i !== targets.length - 1) {
                message += '\n'
            }
        }
    }

    if (watchPatterns.length > makeTargets.length) {
        message += '\n'

        for (let i = makeTargets.length; i < watchPatterns.length; i++) {
            message += '- Watching ' + chalk.blue(watchPatterns[i])

            if (i !== watchPatterns.length - 1) {
                message += '\n'
            }
        }
    }

    console.log(boxen(message, { padding: 1, borderColor: 'blue', margin: 1 }))
})

// Copied from serve to parse the --listen flag in the same way
// https://github.com/zeit/serve/blob/master/bin/serve.js#L108
function parseListenOption (str) {
	if (!isNaN(str)) {
		return [str]
	}

	// We cannot use `new URL` here, otherwise it will not
	// parse the host properly and it would drop support for IPv6.
	const url = parseUrl(str)

	switch (url.protocol) {
	case 'pipe:': {
		// some special handling
		const cutStr = str.replace(/^pipe:/, '')

		if (cutStr.slice(0, 4) !== '\\\\.\\') {
			throw new Error(`Invalid Windows named pipe endpoint: ${str}`)
		}

		return [cutStr]
	}
	case 'unix:':
		if (!url.pathname) {
			throw new Error(`Invalid UNIX domain socket endpoint: ${str}`)
		}

		return [url.pathname]
	case 'tcp:':
		url.port = url.port || '3000'
		return [parseInt(url.port, 10), url.hostname]
	default:
		throw new Error(`Unknown --listen endpoint scheme (protocol): ${url.protocol}`)
	}
}