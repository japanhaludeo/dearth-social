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

function getSessionUser(req) {
  if (!req.session.userId) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId) || null;
}

app.get('/api/csrf', (req, res) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.json({ csrfToken: req.session.csrfToken });
});

app.get('/api/account', (req, res) => {
  res.json({ user: publicUser(getSessionUser(req)) });
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
  // Normally the session identifies the account. If a hosted deployment lost its
  // in-memory session, allow deletion only after re-authenticating with ID/password.
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
