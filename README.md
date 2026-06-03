# ps1-http-server

HTTP/1.1 server built from scratch using Node.js `net` module — no `http` library.

## Usage

```bash
node example.js
# Server running on http://localhost:3000
```

## Features

**Static file serving** — `app.static('./public')` serves files from a directory with correct MIME types. Blocks directory traversal attacks (403 for any path outside the root).

**Route handlers** — Express-style routing with path parameters, query strings, and JSON body parsing.

```js
app.get('/users/:id', (req, res) => {
  res.json({ id: req.params.id, page: req.query.page });
});

app.post('/users', (req, res) => {
  res.status(201).json({ name: req.body.name });
});
```

**Creative feature: request counter** — I wanted a way to see which routes are actually getting called while the server is running, so every request gets counted. `GET /stats` returns the full breakdown.

```json
{
  "GET /": 5,
  "GET /users/42": 3,
  "POST /users": 1
}
```
