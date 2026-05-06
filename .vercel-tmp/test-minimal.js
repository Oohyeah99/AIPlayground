const express = require('express');
const app = express();
app.get('/api/test', (req, res) => res.json({ ok: true, node: process.version }));
app.get('/*', (req, res) => res.send('hello from vercel'));
module.exports = app;
