const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const APP_ID = '2163779';
const KEY = 'b9d68ccf53cfd1732784';
const SECRET = '99c8b76b2c7c6f00a129';
const CLUSTER = 'eu';
const PORT = process.env.PORT || 3000;

let gameState = { started: false, players: {} };

// Cache parsed ROUNDS from moderator.html
let cachedRounds = null;
function getRounds() {
  if (cachedRounds) return cachedRounds;
  try {
    const html = fs.readFileSync(path.join(__dirname, 'moderator.html'), 'utf8');
    const idx = html.indexOf('const ROUNDS = ');
    const str = html.substring(idx + 'const ROUNDS = '.length);
    const decoder = (s) => {
      // Find the end of the JSON array
      let depth = 0, i = 0;
      for (; i < s.length; i++) {
        if (s[i] === '[' || s[i] === '{') depth++;
        else if (s[i] === ']' || s[i] === '}') { depth--; if (depth === 0) break; }
      }
      return JSON.parse(s.substring(0, i + 1));
    };
    cachedRounds = decoder(str);
    return cachedRounds;
  } catch(e) {
    console.error('Failed to parse ROUNDS:', e.message);
    return [];
  }
}

function getAllQ() {
  const rounds = getRounds();
  const all = [];
  rounds.forEach(r => r.questions.forEach((q, i) => {
    all.push({ ...q, round: r, qIdx: i, gIdx: all.length, points: q.points || r.points });
  }));
  return all;
}

function pusherTrigger(event, channel, data) {
  const body = JSON.stringify({ name: event, channel, data: JSON.stringify(data) });
  const md5 = crypto.createHash('md5').update(body).digest('hex');
  const ts = Math.floor(Date.now() / 1000);
  const params = { auth_key: KEY, auth_timestamp: String(ts), auth_version: '1.0', body_md5: md5 };
  const sorted = Object.keys(params).sort().map(k => k+'='+params[k]).join('&');
  const sig = crypto.createHmac('sha256', SECRET).update('POST\n/apps/'+APP_ID+'/events\n'+sorted).digest('hex');
  params.auth_signature = sig;
  const qs = Object.keys(params).sort().map(k => encodeURIComponent(k)+'='+encodeURIComponent(params[k])).join('&');

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api-'+CLUSTER+'.pusher.com',
      path: '/apps/'+APP_ID+'/events?'+qs,
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => resolve(b));
  });
}

function serveFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    res.setHeader('Content-Type', contentType);
    res.writeHead(200);
    res.end(content);
  } catch(e) {
    res.writeHead(404);
    res.end('File not found: ' + filePath);
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');

  // Static files
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/moderator' || url.pathname === '/moderator.html')) {
    cachedRounds = null; // refresh cache when moderator reloads
    serveFile(res, path.join(__dirname, 'moderator.html'), 'text/html; charset=utf-8');
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/hrac' || url.pathname === '/hrac.html')) {
    serveFile(res, path.join(__dirname, 'hrac.html'), 'text/html; charset=utf-8');
    return;
  }

  // GET /question/:index — returns full question data including images
  // This avoids Pusher 10KB message limit
  if (req.method === 'GET' && url.pathname.startsWith('/question/')) {
    const idx = parseInt(url.pathname.split('/')[2]);
    const allQ = getAllQ();
    if (isNaN(idx) || idx < 0 || idx >= allQ.length) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Question not found' }));
      return;
    }
    const q = allQ[idx];
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    // Return full question data including base64 images
    res.end(JSON.stringify({
      index: idx,
      question: q.q ? q.q.split('\n')[0] : '',
      round: q.round.name,
      roundIcon: q.round.icon,
      points: q.points,
      type: q.type || 'text',
      items: q.type === 'slideshow' ? q.items : (q.items || null),
      image: q.image || null,
      answerImage: q.answerImage || null,
      hasSubqs: !!(q.subqs && q.subqs.length),
      subqs: q.subqs || null,
    }));
    return;
  }

  // POST /join
  if (req.method === 'POST' && url.pathname === '/join') {
    const body = await readBody(req);
    try {
      const data = JSON.parse(body);
      gameState.players[data.id] = { name: data.name, score: 0, color: data.color };
      const result = await pusherTrigger('player-joined', 'quiz-channel', data);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, gameStarted: gameState.started, pusher: result }));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // POST /trigger — moderator triggers Pusher events
  // Strips large image data before sending via Pusher
  if (req.method === 'POST' && url.pathname === '/trigger') {
    const body = await readBody(req);
    try {
      const { event, data } = JSON.parse(body);
      if (event === 'game-started') { gameState.started = true; cachedRounds = null; }
      if (event === 'score-update' && gameState.players[data.playerId]) {
        gameState.players[data.playerId].score = data.score;
      }

      // Strip image data from new-question — hrac will fetch via /question/:index
      let pusherData = { ...data };
      if (event === 'new-question') {
        delete pusherData.image;
        delete pusherData.answerImage;
        // Keep only lightweight fields
      }
      // Strip image from answer-revealed too
      if (event === 'answer-revealed') {
        delete pusherData.answerImage;
        // hrac will already have it from /question fetch
      }

      const result = await pusherTrigger(event, 'quiz-channel', pusherData);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ ok: result.status === 200, pusher: result }));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // POST /answer
  if (req.method === 'POST' && url.pathname === '/answer') {
    const body = await readBody(req);
    try {
      const data = JSON.parse(body);
      const result = await pusherTrigger('player-answer', 'quiz-channel', data);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // GET /state
  if (req.method === 'GET' && url.pathname === '/state') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(gameState));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
    }
  }
  console.log('\n🎉 ================================');
  console.log('   Turky Kvíz server běží!');
  console.log('================================');
  console.log('\n📺  Moderátor: http://localhost:'+PORT+'/moderator');
  console.log('📱  Hráči:     http://'+localIP+':'+PORT+'/hrac');
  console.log('================================\n');
});
