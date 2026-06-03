'use strict';
const { createApp } = require('./server');

const app = createApp();

// global middleware - runs on every single request before the routes

// logs the method, path and how long each request took
app.use((req, res, next) => {
  const start = Date.now();
  const origJson = res.json.bind(res);
  const origSend = res.send.bind(res);

  const log = () => console.log(`${req.method} ${req.path} — ${Date.now() - start}ms`);

  res.json = (data) => { log(); origJson(data); };
  res.send = (data) => { log(); origSend(data); };

  next();
});

// static files

app.static('./public');   // serve everything in the public folder, like index.html

// routes

app.get('/', (req, res) => {
  res.json({ message: 'Hello from ps1-http-server!', docs: '/api' });
});

// search route - takes q and limit from the query string (e.g. /search?q=hello&limit=5)
app.get('/search', (req, res) => {
  const { q = '', limit = '10' } = req.query;
  res.json({ query: q, limit: parseInt(limit, 10), results: [] });
});

// get a specific user by their id from the URL (e.g. /users/42)
app.get('/users/:id', (req, res) => {
  res.json({ userId: req.params.id, headers: req.headers });
});

// get posts for a user - combines path param (id) and query param (page)
app.get('/users/:id/posts', (req, res) => {
  res.json({ userId: req.params.id, page: req.query.page || '1' });
});

// create a new user - body must have a name, returns 400 if missing
app.post('/users', (req, res) => {
  if (!req.body || !req.body.name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  res.status(201).json({ id: Date.now(), name: req.body.name });
});

// update a user by id - new data comes from the request body
app.put('/users/:id', (req, res) => {
  res.json({ updated: req.params.id, data: req.body });
});

// delete a user by id
app.delete('/users/:id', (req, res) => {
  res.status(200).json({ deleted: req.params.id });
});

// start the server

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
  console.log('  GET  /                   → JSON greeting');
  console.log('  GET  /search?q=foo       → query string demo');
  console.log('  GET  /users/:id          → path params');
  console.log('  POST /users              → JSON body parsing');
  console.log('  GET  /index.html         → static file serving');
  console.log('  GET  /stats              → request hit counter');
});
