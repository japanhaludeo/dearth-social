'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL UNIQUE,
    account_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts(created_at DESC, id DESC);
  CREATE TABLE IF NOT EXISTS replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS replies_post_id_idx ON replies(post_id, created_at, id);
`);

app.disable('x-powered-by');
// Render and similar platforms terminate HTTPS at a reverse proxy. Trust it so
// Express can correctly set secure session cookies for the original request.
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use(session({
  name: 'dearthsocial.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

// Simple in-memory protection for local/demo use. Use a shared rate limiter in production.
const requestLog = new Map();
function rateLimit(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  if (req.method === 'GET') return next();
  const key = `${req.ip}:${req.path}`;
  const now = Date.now();
  const entries = (requestLog.get(key) || []).filter(time => now - time < 60_000);
  entries.push(now);
  requestLog.set(key, entries);
  if (entries.length > 20) return res.status(429).json({ error: 'リクエストが多すぎます。しばらくしてからお試しください。' });
  next();
}

app.use(rateLimit);

function isSafeOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.get('origin');
  if (!origin) return true;
  const host = req.get('host');
  try {
    const originUrl = new URL(origin);
    return host === originUrl.host;
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  if (!isSafeOrigin(req)) return res.status(403).json({ error: '不正なリクエスト元です。' });

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    if (req.session.csrfToken && req.get('x-csrf-token') !== req.session.csrfToken) {
      return res.status(403).json({ error: 'セッションを確認できませんでした。ページを再読み込みしてください。' });
    }
  }
  next();
});

function publicUser(row) {
  if (!row) return null;
  return { id: row.id, accountId: row.account_id.toLowerCase(), accountName: row.account_name, createdAt: row.created_at };
}

function normalizeAccountId(value) {
  return String(value || '').trim().toLowerCase();
}

function validateRegistration(accountId, accountName, password) {
  if (!/^[a-z0-9_]{2,30}$/.test(accountId)) {
    return 'アカウントIDは英数字・_を使い、2～30文字で入力してください。ハイフンは使えません。';
  }
  if (!accountName || accountName.length > 50) return 'アカウント名は1～50文字で入力してください。';
  if (password.length < 2 || password.length > 72) return 'パスワードは2～72文字で入力してください。';
  return null;
}

// Count ASCII and half-width katakana as one, all other grapheme clusters as two.
// This keeps combining marks and joined emoji from being counted as extra characters.
function weightedLength(text) {
  const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
  let length = 0;
  for (const { segment } of segmenter.segment(text)) {
    const codePoint = segment.codePointAt(0);
    const isHalfWidth = codePoint <= 0x7f || (codePoint >= 0xff61 && codePoint <= 0xff9f);
    length += isHalfWidth ? 1 : 2;
  }
  return length;
}

function validateText(text, maxLength, label) {
  if (!text.trim()) return `${label}を入力してください。`;
  if (weightedLength(text) > maxLength) return `${label}は全角2・半角1文字換算で${maxLength}文字以内にしてください。`;
  return null;
}

function getSessionUser(req) {
  if (!req.session.userId) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId) || null;
}

function requireUser(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'ログインが必要です。' });
    return null;
  }
  return user;
}

function getFeed() {
  const posts = db.prepare(`
    SELECT p.id, p.user_id AS userId, p.body, p.created_at AS createdAt,
           u.account_id AS accountId, u.account_name AS accountName
    FROM posts p JOIN users u ON u.id = p.user_id
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT 50
  `).all();

  const getReplies = db.prepare(`
    SELECT r.id, r.user_id AS userId, r.body, r.created_at AS createdAt,
           u.account_id AS accountId, u.account_name AS accountName
    FROM replies r JOIN users u ON u.id = r.user_id
    WHERE r.post_id = ?
    ORDER BY r.created_at ASC, r.id ASC
    LIMIT 100
  `);

  return posts.map(post => ({
    ...post,
    accountId: post.accountId.toLowerCase(),
    replies: getReplies.all(post.id).map(reply => ({ ...reply, accountId: reply.accountId.toLowerCase() }))
  }));
}

app.get('/api/csrf', (req, res) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.json({ csrfToken: req.session.csrfToken });
});

app.get('/api/account', (req, res) => {
  res.json({ user: publicUser(getSessionUser(req)) });
});

app.get('/api/posts', (req, res) => {
  res.json({ posts: getFeed() });
});

app.post('/api/posts', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const body = String(req.body.body || '');
  const error = validateText(body, 256, '投稿');
  if (error) return res.status(400).json({ error });
  const result = db.prepare('INSERT INTO posts (user_id, body) VALUES (?, ?)').run(user.id, body);
  res.status(201).json({ postId: Number(result.lastInsertRowid), posts: getFeed() });
});

app.post('/api/posts/:postId/replies', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const postId = Number(req.params.postId);
  if (!Number.isSafeInteger(postId) || postId < 1 || !db.prepare('SELECT 1 FROM posts WHERE id = ?').get(postId)) {
    return res.status(404).json({ error: '投稿が見つかりません。' });
  }
  const body = String(req.body.body || '');
  const error = validateText(body, 64, '返信');
  if (error) return res.status(400).json({ error });
  db.prepare('INSERT INTO replies (post_id, user_id, body) VALUES (?, ?, ?)').run(postId, user.id, body);
  res.status(201).json({ posts: getFeed() });
});

app.post('/api/account/register', async (req, res) => {
  const accountId = normalizeAccountId(req.body.accountId);
  const accountName = String(req.body.accountName || '').trim();
  const password = String(req.body.password || '');
  const error = validateRegistration(accountId, accountName, password);
  if (error) return res.status(400).json({ error });

  const exists = db.prepare('SELECT 1 FROM users WHERE LOWER(account_id) = ?').get(accountId);
  if (exists) return res.status(409).json({ error: 'このアカウントIDは既に使われています。' });

  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const result = db.prepare(`
      INSERT INTO users (account_id, account_name, password_hash)
      VALUES (?, ?, ?)
    `).run(accountId, accountName, passwordHash);
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'セッションの作成に失敗しました。' });
      req.session.userId = Number(result.lastInsertRowid);
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json({ user: publicUser(user), csrfToken: req.session.csrfToken });
    });
  } catch (insertError) {
    if (String(insertError).includes('UNIQUE')) {
      return res.status(409).json({ error: 'このアカウントIDは既に使われています。' });
    }
    console.error(insertError);
    res.status(500).json({ error: 'アカウントを作成できませんでした。' });
  }
});

app.post('/api/account/login', async (req, res) => {
  const accountId = normalizeAccountId(req.body.accountId);
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE LOWER(account_id) = ? ORDER BY id LIMIT 1').get(accountId);

  const valid = user ? await bcrypt.compare(password, user.password_hash) : await bcrypt.compare(password, '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi');
  if (!valid) return res.status(401).json({ error: 'アカウントIDまたはパスワードが正しくありません。' });

  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'ログインできませんでした。' });
    req.session.userId = user.id;
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    res.json({ user: publicUser(user), csrfToken: req.session.csrfToken });
  });
});

app.post('/api/account/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'ログアウトできませんでした。' });
    res.clearCookie('dearthsocial.sid');
    res.json({ ok: true });
  });
});

app.patch('/api/account/password', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'ログインが必要です。' });

  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');
  const confirmedPassword = String(req.body.confirmPassword || '');
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
    return res.status(401).json({ error: '現在のパスワードが正しくありません。' });
  }
  if (newPassword !== confirmedPassword) return res.status(400).json({ error: '新しいパスワードと確認用パスワードが一致しません。' });
  if (newPassword.length < 2 || newPassword.length > 72) return res.status(400).json({ error: 'パスワードは2～72文字で入力してください。' });
  if (await bcrypt.compare(newPassword, user.password_hash)) return res.status(400).json({ error: '現在と異なるパスワードを入力してください。' });

  const passwordHash = await bcrypt.hash(newPassword, 12);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(passwordHash, user.id);

  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'パスワードは変更されましたが、セッションの更新に失敗しました。' });
    res.clearCookie('dearthsocial.sid');
    res.json({ ok: true });
  });
});

app.delete('/api/account', async (req, res) => {
  const submittedAccountId = normalizeAccountId(req.body.accountId);
  let user = getSessionUser(req);
  if (!user && submittedAccountId) {
    user = db.prepare('SELECT * FROM users WHERE LOWER(account_id) = ? ORDER BY id LIMIT 1').get(submittedAccountId);
  }
  if (!user) return res.status(401).json({ error: 'ログイン情報を確認できません。再ログインするか、アカウントIDとパスワードを入力してください。' });
  if (submittedAccountId && normalizeAccountId(user.account_id) !== submittedAccountId) {
    return res.status(403).json({ error: 'ログイン中のアカウントと入力されたIDが一致しません。' });
  }

  const password = String(req.body.password || '');
  if (!(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'パスワードが正しくありません。' });
  }

  // Foreign-key cascades permanently remove the account's posts and replies too.
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'アカウントは削除しましたが、セッションの削除に失敗しました。' });
    res.clearCookie('dearthsocial.sid');
    res.json({ ok: true });
  });
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

if (require.main === module) {
  app.listen(PORT, () => console.log(`DearthSocial listening on port ${PORT}`));
}

module.exports = app;
