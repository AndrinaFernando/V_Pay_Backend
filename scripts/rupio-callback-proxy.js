// Temporary development proxy: expose only the signed Rupio callback to the tunnel.
const http = require('node:http');

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/webhooks/rupio') {
    res.writeHead(404).end();
    return;
  }
  const upstream = http.request({
    hostname: '127.0.0.1', port: 3001, method: 'POST', path: req.url,
    headers: { ...req.headers, host: '127.0.0.1:3001' },
    timeout: 30000,
  }, response => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
});

server.listen(3002, '127.0.0.1', () => console.log('Rupio callback proxy listening on 127.0.0.1:3002'));
