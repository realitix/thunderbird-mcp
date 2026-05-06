#!/usr/bin/env node
/**
 * MCP Bridge for Thunderbird
 *
 * Converts stdio MCP protocol to HTTP requests for the Thunderbird MCP extension.
 * The extension exposes an HTTP endpoint on localhost:8765.
 */

const http = require('http');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');

const THUNDERBIRD_HOSTS = ['127.0.0.1'];
const REQUEST_TIMEOUT = 30000;
const CONNECTION_FILE = path.join(os.tmpdir(), 'thunderbird-mcp', 'connection.json');
const CONNECTION_RETRY_DELAY_MS = 1000;
const CONNECTION_MAX_RETRIES = 5;

// Max raw bytes for an attachment read from a path before base64 encoding.
// Encoded size grows ~33%, so 18 MB raw → ~24 MB base64, staying under the
// extension's 25 MB MAX_BASE64_SIZE limit.
const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

// Tools whose `attachments` array may contain string file paths that this
// bridge resolves on the host filesystem before forwarding. Needed because the
// Thunderbird snap (and other sandboxed installs) cannot see arbitrary host
// paths like /data/... or the host's /tmp; passing those paths through to the
// extension results in silent "failed to attach" warnings since file.exists()
// returns false inside the sandbox. Reading on the bridge side and shipping
// inline base64 sidesteps the sandbox entirely.
const ATTACHMENT_TOOLS = new Set(['sendMail', 'replyToMessage', 'forwardMessage']);

// Minimal MIME map — covers the file types JSB attaches in practice
// (invoices, signed PDFs, scans, photos, office docs, archives). Falls back to
// application/octet-stream which Thunderbird handles fine.
const MIME_BY_EXT = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  json: 'application/json',
  xml: 'application/xml',
  yml: 'application/yaml',
  yaml: 'application/yaml',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  ics: 'text/calendar',
  eml: 'message/rfc822',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime'
};

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * Read a file path off the host filesystem and convert it to the inline
 * { name, contentType, base64 } shape the extension already supports.
 * Throws on missing file, unreadable file, or oversized file — the caller
 * surfaces the error as a clear MCP error response instead of letting the
 * extension report the silent "failed to attach" warning.
 */
function readAttachmentFromPath(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`Attachment not found: ${filePath}`);
    if (e.code === 'EACCES') throw new Error(`Attachment unreadable (permission denied): ${filePath}`);
    throw new Error(`Attachment stat failed (${e.code || 'unknown'}): ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Attachment is not a regular file: ${filePath}`);
  }
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment too large: ${filePath} is ${stat.size} bytes ` +
      `(limit ${MAX_ATTACHMENT_BYTES} bytes / ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB raw before base64)`
    );
  }
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    throw new Error(`Attachment read failed (${e.code || 'unknown'}): ${filePath}`);
  }
  return {
    name: path.basename(filePath),
    contentType: guessContentType(filePath),
    base64: buf.toString('base64')
  };
}

/**
 * Walk the `attachments` array of a tools/call payload and replace every
 * string entry (= file path) with an inline { name, contentType, base64 }
 * object read off the host filesystem. Inline objects already in
 * { name, base64 } shape are left untouched (back-compat).
 *
 * Mutates `args.attachments` in place. Throws on the first unreadable path so
 * the bridge fails loud instead of silently dropping the attachment.
 */
function inlineAttachmentPaths(args) {
  if (!args || !Array.isArray(args.attachments)) return;
  for (let i = 0; i < args.attachments.length; i++) {
    const entry = args.attachments[i];
    if (typeof entry === 'string') {
      args.attachments[i] = readAttachmentFromPath(entry);
    }
    // Objects (inline base64 or anything else) pass through unchanged —
    // the extension's filePathsToAttachDescs handles validation there.
  }
}

/**
 * Read connection info (port + auth token) written by the Thunderbird extension.
 * Returns { port, token } or null if the file doesn't exist.
 * Caches the result for a short TTL to avoid hitting the filesystem on every request.
 * Cache is cleared on connection errors (see clearConnectionCache).
 */
let cachedConnectionInfo = null;
let connectionCacheExpiry = 0;
const CONNECTION_CACHE_TTL_MS = 5000; // 5 seconds

function readConnectionInfo() {
  if (cachedConnectionInfo && Date.now() < connectionCacheExpiry) {
    return cachedConnectionInfo;
  }
  try {
    const data = JSON.parse(fs.readFileSync(CONNECTION_FILE, 'utf8'));
    cachedConnectionInfo = data;
    connectionCacheExpiry = Date.now() + CONNECTION_CACHE_TTL_MS;
    return data;
  } catch {
    return null;
  }
}

function clearConnectionCache() {
  cachedConnectionInfo = null;
  connectionCacheExpiry = 0;
}

// Ensure stdout doesn't buffer - critical for MCP protocol
if (process.stdout._handle?.setBlocking) {
  process.stdout._handle.setBlocking(true);
}

let pendingRequests = 0;
let stdinClosed = false;

function checkExit() {
  if (stdinClosed && pendingRequests === 0) {
    process.exit(0);
  }
}

// Write with backpressure handling
function writeOutput(data) {
  return new Promise((resolve) => {
    if (process.stdout.write(data)) {
      resolve();
    } else {
      process.stdout.once('drain', resolve);
    }
  });
}

/**
 * Sanitize JSON response that may contain invalid control characters.
 * Email bodies often contain raw control chars that break JSON parsing.
 * api.js now pre-encodes non-ASCII for Thunderbird's raw-byte HTTP writer;
 * this remains a fallback for malformed responses.
 */
function sanitizeJson(data) {
  // Remove control chars except \n, \r, \t
  let sanitized = data.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  // Escape raw newlines/carriage returns/tabs that aren't already escaped
  sanitized = sanitized.replace(/(?<!\\)\r/g, '\\r');
  sanitized = sanitized.replace(/(?<!\\)\n/g, '\\n');
  sanitized = sanitized.replace(/(?<!\\)\t/g, '\\t');
  return sanitized;
}

async function handleMessage(line) {
  const message = JSON.parse(line);
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  const isNotification =
    !hasId ||
    (typeof message.method === 'string' && message.method.startsWith('notifications/'));

  if (isNotification) {
    return null;
  }

  // Handle MCP lifecycle methods locally so the bridge can complete
  // handshake even when Thunderbird isn't running yet.
  switch (message.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'thunderbird-mcp', version: '0.1.0' }
        }
      };
    case 'ping':
      return { jsonrpc: '2.0', id: message.id, result: {} };
    case 'resources/list':
      return { jsonrpc: '2.0', id: message.id, result: { resources: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id: message.id, result: { prompts: [] } };
  }

  // For mail-sending tools, inline any attachments passed as file paths.
  // The Thunderbird extension may run inside a sandboxed snap that cannot
  // see /data/..., the host /tmp, or any path outside its confined view —
  // letting paths through results in silent "failed to attach" warnings.
  // Reading on the bridge side and shipping base64 sidesteps the sandbox.
  if (message.method === 'tools/call'
      && message.params
      && ATTACHMENT_TOOLS.has(message.params.name)) {
    try {
      inlineAttachmentPaths(message.params.arguments);
    } catch (e) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32602, message: e.message }
      };
    }
  }

  return forwardToThunderbird(message);
}

function tryRequest(hostname, postData, port, token) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const req = http.request({
      hostname,
      port,
      path: '/',
      method: 'POST',
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode === 403) {
          clearConnectionCache();
          reject(new Error('Authentication failed (403). Token may be stale — retrying with fresh connection info.'));
          return;
        }
        const data = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(data));
        } catch {
          try {
            resolve(JSON.parse(sanitizeJson(data)));
          } catch (e) {
            reject(new Error(`Invalid JSON from Thunderbird: ${e.message}`));
          }
        }
      });
    });

    req.on('error', reject);

    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy();
      reject(new Error('Request to Thunderbird timed out'));
    });

    req.write(postData);
    req.end();
  });
}

async function forwardToThunderbird(message, _retried) {
  const postData = JSON.stringify(message);

  // Read connection info (port + auth token) from the file written by the extension.
  // Fail-closed: if the connection file is missing, retry a few times
  // (Thunderbird may still be starting), then fail with an error.
  // Never forward requests without authentication.
  let connInfo = readConnectionInfo();
  if (!connInfo) {
    for (let attempt = 0; attempt < CONNECTION_MAX_RETRIES; attempt++) {
      await new Promise(r => setTimeout(r, CONNECTION_RETRY_DELAY_MS));
      connInfo = readConnectionInfo();
      if (connInfo) break;
    }
    if (!connInfo) {
      throw new Error(
        'Connection file not found. Is Thunderbird running with the MCP extension? ' +
        'The extension must be started first to create the connection file.'
      );
    }
  }

  if (!connInfo.port || !connInfo.token) {
    throw new Error('Invalid connection file: missing port or token');
  }

  const { port, token } = connInfo;

  // Try each host in order - handles platforms where 'localhost' resolves to
  // IPv6 (::1) but the extension only listens on IPv4 (127.0.0.1).
  const tryNext = (hosts) => {
    const [hostname, ...rest] = hosts;
    return tryRequest(hostname, postData, port, token).catch((err) => {
      if (rest.length > 0 && (err.code === 'ECONNREFUSED' || err.code === 'EADDRNOTAVAIL')) {
        return tryNext(rest);
      }
      // On 403 or connection refused, clear cache and retry once with fresh
      // connection info (Thunderbird may have restarted on a new port/token).
      if (!_retried) {
        if (err.message && err.message.includes('403')) {
          clearConnectionCache();
          return forwardToThunderbird(message, true);
        }
        if (err.code === 'ECONNREFUSED' || err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT') {
          clearConnectionCache();
          return forwardToThunderbird(message, true);
        }
      }
      // Already retried or non-recoverable error
      if (err.code === 'ECONNREFUSED' || err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT') {
        throw new Error(`Connection failed: ${err.message}. Is Thunderbird running with the MCP extension?`);
      }
      throw err;
    });
  };

  return tryNext(THUNDERBIRD_HOSTS);
}

// Process stdin as JSON-RPC messages
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;

  let messageId = null;
  try {
    messageId = JSON.parse(line).id ?? null;
  } catch {
    // Leave as null when request cannot be parsed
  }

  pendingRequests++;
  handleMessage(line)
    .then(async (response) => {
      if (response !== null) {
        await writeOutput(JSON.stringify(response) + '\n');
      }
    })
    .catch(async (err) => {
      await writeOutput(JSON.stringify({
        jsonrpc: '2.0',
        id: messageId,
        error: { code: -32700, message: `Bridge error: ${err.message}` }
      }) + '\n');
    })
    .finally(() => {
      pendingRequests--;
      checkExit();
    });
});

rl.on('close', () => {
  stdinClosed = true;
  checkExit();
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
