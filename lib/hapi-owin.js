'use strict'

const debug = require('debug')('hapi:owin')

var path = require('path')
var edge = require('edge')
var urlParser = require('url')

var initialize = edge.func({
  assemblyFile: process.env.CONNECT_OWIN_NATIVE || path.join(__dirname, 'clr/Connect.Owin.dll'),
  typeName: 'Connect.Owin.OwinMiddleware',
  methodName: 'Initialize'
})

var handle = edge.func({
  assemblyFile: process.env.CONNECT_OWIN_NATIVE || path.join(__dirname, 'clr/Connect.Owin.dll'),
  typeName: 'Connect.Owin.OwinMiddleware',
  methodName: 'Handle'
})

exports.register = (server, options, next) => {
  // do something
  if (typeof options === 'string') {
    options = { assemblyFile: options }
  } else if (typeof options !== 'object') {
    throw new Error('Specify the file name of the OWIN assembly DLL or provide an options object.')
  } else if (typeof options.assemblyFile !== 'string') {
    throw new Error('OWIN assembly file name must be provided as a string parameter or assemblyFile options property.')
  }

  debug('Options: ', options)

  var owinAppId

  var owinBodyParser = (request, reply, next) => {
    if (request.body) {
      debug('Current body: ' + request.body)
      return next()
    }

    debug('Parsing body...')

    // Has body?
    if ('transfer-encoding' in request.headers ||
      ('content-length' in request.headers && request.headers['content-length'] !== '0')) {
      debug('Body length: ' + request.headers['content-length'])

      // Parse body
      var buffers = []
      request.on('peek', (chunk) => buffers.push(chunk))
      request.once('finish', () => {
        request.body = Buffer.concat(buffers)
        debug('Appending body: ' + request.body)

        return next()
      })
    } else {
      request.body = new Buffer(0)

      debug('Created empty body.')
      return next()
    }
  }

  var owinMiddleware = function (request, reply) {
    function onInitialized () {
      // Create the baseline OWIN env using properties of the request object
      var env = {
        'connect-owin.appId': owinAppId,
        'owin.RequestMethod': request.method,
        'owin.RequestPath': urlParser.parse(request.url).pathname,
        'owin.RequestPathBase': '',
        'owin.RequestProtocol': 'HTTP/' + request.raw.req.httpVersion,
        'owin.RequestQueryString': urlParser.parse(request.url).query || '',
        'owin.RequestScheme': request.raw.req.connection.encrypted ? 'https' : 'http',
        'owin.RequestHeaders': request.headers
      }
      if (Buffer.isBuffer(request.body)) {
        env['owin.RequestBody'] = request.body
      } else if (typeof request.body === 'object') {
        env['owin.RequestBody'] = new Buffer(JSON.stringify(request.body))
      } else {
        var err = new Error('Invalid body format')
        err.status = 400
        err.body = request.body
        return reply(err)
      }

      // Add options to the OWIN environment.
      // This is a good mechanism to export global node.js functions to the OWIN middleware in .NET.
      for (var i in options) {
        env['node.' + i] = options[i]
      }

      // Add per-request owin properties to the OWIN environment.
      // This is a good mechanism to allow previously running connect middleware
      // to export request-specific node.js functions to the OWIN middleware in .NET.
      if (typeof request.owin === 'object') {
        for (var j in request.owin) {
          env['node.' + j] = request.owin[j]
        }
      }

      // Add js functions to OWIN environment
      // This will allow the OWIN middleware in .NET to configure the 'res' object.
      var res = reply()
      env['connect-owin.setStatusCodeFunc'] = function (data, callback) {
        if (typeof data === 'number') {
          res = res.code(data)
        }
        callback(null, null)
      }
      env['connect-owin.setHeaderFunc'] = function (data, callback) {
        if (typeof data === 'object') {
          for (var i in data) {
            res.header(i, data[i].join(','))
          }
        }
        callback(null, null)
      }
      env['connect-owin.removeHeaderFunc'] = function (data, callback) {
        if (typeof data === 'string') {
          delete res.headers[data]
        }
        callback(null, null)
      }
      env['connect-owin.removeAllHeadersFunc'] = function (data, callback) {
        for (var i in res.headers) {
          delete res.headers[i]
        }
        callback(null, null)
      }
      env['connect-owin.writeFunc'] = function (data, callback) {
        if (Buffer.isBuffer(data)) {
          res(data)
        }
        callback(null, null)
      }

      debug('Calling .NET middleware...')

      // Call into .NET OWIN application
      handle(env, (error, result) => {
        if (error) return reply(error)

        // Consider this response complete or continue running connect pipeline?
        return result ? reply.continue() : reply.close()
      })
    }

    function ensureInitialized () {
      debug('Initializing OWIN application...')
      initialize(options, (error, result) => {
        if (error) {
          debug('Initialize error!')
          return reply(error)
        }
        // Result is a unique identifier of the OWIN middleware in .NET.
        // It is passed to the handle method so that .NET code can dispatch the request
        // to the appropriate OWIN middleware instance.
        owinAppId = result
        debug('OWIN application initialized.')

        onInitialized()
      })
    }

    if (owinAppId !== undefined) {
      onInitialized()
    } else {
      ensureInitialized()
    }
  }

  server.ext('onRequest', (request, reply) => {
    return owinBodyParser(request, reply, (err) => {
      if (err) {
        debug('Parsing error!')
        return reply(err)
      }

      return owinMiddleware(request, reply)
    })
  })

  next()
}

exports.register.attributes = {
  pkg: require('../package.json')
}
