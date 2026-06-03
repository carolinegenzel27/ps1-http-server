'use strict';
const net  = require('net');
const fs   = require('fs');
const path = require('path');

// mime types - maps file extensions to the right content-type header

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.pdf':  'application/pdf',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
};

const HTTP_STATUS = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
};

// HTTP parsing - read the raw buffer and turn it into a usable request object

function parseQueryString(qs) {
  const obj = {};
  if (!qs) return obj;
  for (const pair of qs.split('&')) {
    const eq  = pair.indexOf('=');
    const key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
    const val = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    if (key) obj[key] = val;
  }
  return obj;
}

function parseRequest(buf) {
  const sep = buf.indexOf('\r\n\r\n');
  if (sep === -1) return null;

  const headStr = buf.slice(0, sep).toString('utf8');
  const bodyBuf = buf.slice(sep + 4);
  const lines   = headStr.split('\r\n');
  const reqLine = lines[0] || '';

  const spaceA   = reqLine.indexOf(' ');
  const spaceB   = reqLine.lastIndexOf(' ');
  const method   = spaceA === -1 ? 'GET'          : reqLine.slice(0, spaceA).toUpperCase();
  const rawPath  = spaceA === -1 ? '/'            : reqLine.slice(spaceA + 1, spaceB === spaceA ? undefined : spaceB);
  const version  = spaceB === spaceA ? 'HTTP/1.1' : reqLine.slice(spaceB + 1);

  const qi       = rawPath.indexOf('?');
  const pathname = qi === -1 ? rawPath        : rawPath.slice(0, qi);
  const query    = parseQueryString(qi === -1 ? '' : rawPath.slice(qi + 1));

  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const ci = lines[i].indexOf(':');
    if (ci === -1) continue;
    headers[lines[i].slice(0, ci).trim().toLowerCase()] = lines[i].slice(ci + 1).trim();
  }

  const ct = headers['content-type'] || '';
  let body = bodyBuf.toString('utf8');
  if (ct.includes('application/json') && body) {
    try { body = JSON.parse(body); } catch (_) { /* leave as raw string */ }
  } else if (ct.includes('application/x-www-form-urlencoded') && body) {
    body = parseQueryString(body);
  }

  return {
    method,
    path: pathname,
    httpVersion: version,
    headers,
    query,
    params: {},
    body,
    rawBody: bodyBuf,
  };
}

// HTTP response - build the response and send it back through the socket

function buildResponseHead(statusCode, headers) {
  const statusText  = HTTP_STATUS[statusCode] || 'Unknown';
  const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  return `HTTP/1.1 ${statusCode} ${statusText}\r\n${headerLines}\r\n\r\n`;
}

function createResponse(socket) {
  let _status      = 200;
  const _headers   = {};
  let _sent        = false;

  function _finalize(bodyData, typeHeaders) {
    if (_sent) return;
    _sent = true;
    const buf = Buffer.isBuffer(bodyData)
      ? bodyData
      : Buffer.from(String(bodyData ?? ''), 'utf8');
    const allHeaders = {
      'Connection':     'close',
      ...typeHeaders,
      ..._headers,
      'Content-Length': buf.length,  // always calculated from the actual buffer, user can't override this
    };
    if (!socket.destroyed) {
      socket.write(buildResponseHead(_status, allHeaders));
      socket.write(buf);
      socket.end();
    }
  }

  return {
    get statusCode()  { return _status; },
    get headersSent() { return _sent;   },

    status(code) { _status = code; return this; },

    setHeader(key, value) { _headers[key] = String(value); return this; },
    getHeader(key)        { return _headers[key]; },

    json(data) {
      _finalize(JSON.stringify(data), { 'Content-Type': 'application/json' });
    },

    send(data) {
      if (data !== null && typeof data === 'object' && !Buffer.isBuffer(data)) {
        _finalize(JSON.stringify(data), { 'Content-Type': 'application/json' });
      } else {
        const ct = _headers['Content-Type'] || 'text/plain; charset=utf-8';
        _finalize(data, { 'Content-Type': ct });
      }
    },

    sendStatus(code) {
      _status = code;
      _finalize(HTTP_STATUS[code] || String(code), { 'Content-Type': 'text/plain' });
    },

    sendFile(filePath) {
      if (_sent) return;
      const abs = path.resolve(filePath);
      fs.readFile(abs, (err, data) => {
        if (socket.destroyed) return;
        if (err) {
          _status = 404;
          _finalize('Not Found', { 'Content-Type': 'text/plain' });
          return;
        }
        const ext = path.extname(abs);
        _finalize(data, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      });
    },
  };
}

// route compilation - converts a path template like /users/:id into a regex we can match against

// e.g. "/users/:id/posts" becomes { regex: /^\/users\/([^/]+)\/posts$/, names: ['id'] }
function compileRoute(template) {
  const names = [];
  const src = template
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')           // escape any special regex characters in the path
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
  return { regex: new RegExp(`^${src}$`), names };
}

// main App class - this is what the user gets back from createApp()

class App {
  constructor() {
    this._routes     = [];   // each entry has: method, regex, names, handlers
    this._middleware = [];   // each entry has: prefix, fn
    this._staticRoot = null;
    this._hitCount   = {};   // tracks how many times each route was called
  }

  // route registration - one method per HTTP verb

  _addRoute(method, template, handlers) {
    const { regex, names } = compileRoute(template);
    this._routes.push({ method, regex, names, handlers });
    return this;
  }

  get(t, ...h)    { return this._addRoute('GET',    t, h); }
  post(t, ...h)   { return this._addRoute('POST',   t, h); }
  put(t, ...h)    { return this._addRoute('PUT',    t, h); }
  patch(t, ...h)  { return this._addRoute('PATCH',  t, h); }
  delete(t, ...h) { return this._addRoute('DELETE', t, h); }
  all(t, ...h) {
    ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].forEach(m => this._addRoute(m, t, h));
    return this;
  }

  // add middleware - runs before the route handler on every matching request

  use(...args) {
    if (typeof args[0] === 'function') {
      this._middleware.push({ prefix: '/', fn: args[0] });
    } else if (typeof args[0] === 'string' && typeof args[1] === 'function') {
      this._middleware.push({ prefix: args[0], fn: args[1] });
    }
    return this;
  }

  // set a folder to serve static files from

  static(root) {
    this._staticRoot = path.resolve(root);
    return this;
  }

  // dispatcher - takes the raw socket data and figures out which route to run

  _dispatch(socket, buf) {
    const req = parseRequest(buf);

    if (!req) {
      if (!socket.destroyed) {
        socket.end(
          'HTTP/1.1 400 Bad Request\r\n' +
          'Content-Length: 11\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          'Bad Request'
        );
      }
      return;
    }

    req.socket = socket;
    const res = createResponse(socket);

    // i wanted to be able to see which routes are actually being used so i added this
    const key = `${req.method} ${req.path}`;
    this._hitCount[key] = (this._hitCount[key] || 0) + 1;

    // /stats returns the whole counter object
    if (req.method === 'GET' && req.path === '/stats') {
      res.json(this._hitCount);
      return;
    }

    // check static files first - if there's a matching file it wins over routes
    if (this._staticRoot && req.method === 'GET') {
      const rel  = req.path.replace(/^\/+/, '') || '';
      const abs  = path.resolve(this._staticRoot, rel);
      const root = this._staticRoot;

      // security check - make sure nobody can escape the static folder with ../../ tricks
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        res.status(403).send('Forbidden');
        return;
      }

      try {
        const stat = fs.statSync(abs);
        if (stat.isFile()) {
          res.sendFile(abs);
          return;
        }
        if (stat.isDirectory()) {
          const idx = path.join(abs, 'index.html');
          if (fs.existsSync(idx)) { res.sendFile(idx); return; }
        }
      } catch (_) {
        // file not found, keep going and try to match a route instead
      }
    }

    // try to find a route that matches the method and path
    for (const route of this._routes) {
      if (route.method !== req.method) continue;
      const m = req.path.match(route.regex);
      if (!m) continue;

      req.params = {};
      route.names.forEach((name, i) => {
        req.params[name] = decodeURIComponent(m[i + 1]);
      });

      const mw    = this._middleware
        .filter(({ prefix }) => req.path.startsWith(prefix))
        .map(({ fn }) => fn);
      const chain = [...mw, ...route.handlers];
      let   idx   = 0;

      const next = (err) => {
        if (res.headersSent) return;
        if (err) { res.status(500).json({ error: 'Internal Server Error' }); return; }
        if (idx < chain.length) {
          const fn = chain[idx++];
          try { fn(req, res, next); }
          catch (_) { res.status(500).json({ error: 'Internal Server Error' }); }
        }
      };

      next();
      return;
    }

    res.status(404).json({ error: 'Not Found', path: req.path });
  }

  // start the server - opens a TCP server and listens on the given port

  listen(port, callback) {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);

      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);

        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd === -1) return; // still waiting for the full headers to arrive

        // read content-length so we know how long to wait for the body
        const headStr    = buf.slice(0, headerEnd).toString('utf8');
        const clMatch    = headStr.match(/^content-length:\s*(\d+)$/im);
        const bodyLen    = clMatch ? parseInt(clMatch[1], 10) : 0;
        const totalNeeded = headerEnd + 4 + bodyLen;

        if (buf.length < totalNeeded) return; // body is still coming in, wait for more data

        const fullReq = buf.slice(0, totalNeeded);
        buf = buf.slice(totalNeeded); // save the rest in case there's another request right after

        this._dispatch(socket, fullReq);
      });

      socket.on('error', () => socket.destroy());
      socket.setTimeout(10_000, () => socket.end());
    });

    server.listen(port, callback);
    return server;
  }
}

function createApp() {
  return new App();
}

module.exports = { createApp, App };
