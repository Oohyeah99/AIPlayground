/**
 * Local Ollama provider — KL's laptop (localhost:11434)
 * Uses the same factory as the office Ollama provider but with the local base URL.
 */
const { createStream } = require('./ollama');
const LOCAL_OLLAMA_URL = process.env.LOCAL_OLLAMA_URL || 'http://localhost:11434';

module.exports = createStream(LOCAL_OLLAMA_URL, 'ollama-local');
