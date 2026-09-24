
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const { Pool, types } = require('pg');

types.setTypeParser(20, Number);

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const SESSION_TTL_HOURS = Math.min(Math.max(Number(process.env.SESSION_TTL_HOURS || 12), 1), 168);
const SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000;

if (!DATABASE_URL) throw new Error('DATABASE_URL não configurada.');
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('JWT_SECRET deve ter pelo menos 32 caracteres.');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
});

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'"],
      "font-src": ["'self'"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "frame-ancestors": ["'none'"]
    }
  }
}));
app.use(express.json({ limit: '50kb', strict: true }));
app.use(cookieParser());

function sameOriginGuard(req, res, next) {
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite && !['same-origin','same-site','none'].includes(fetchSite)) {
    return res.status(403).json({ error: 'Origem da solicitação não permitida.' });
  }
  const origin = req.get('origin');
  const expected = req.protocol + '://' + req.get('host');
  if (origin && origin !== expected) {
    return res.status(403).json({ error: 'Origem da solicitação não permitida.' });
  }
  next();
}
app.use('/api', sameOriginGuard);
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Muitas solicitações. Aguarde alguns minutos.' } }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, skipSuccessfulRequests: true, message: { error: 'Muitas tentativas de autenticação. Tente novamente mais tarde.' } }));

const secureCookie = process.env.NODE_ENV === 'production';
const authCookie = { httpOnly: true, secure: secureCookie, sameSite: 'strict', maxAge: SESSION_TTL_MS, path: '/' };
const csrfCookie = { httpOnly: false, secure: secureCookie, sameSite: 'strict', maxAge: SESSION_TTL_MS, path: '/' };

function issueCsrf(res) {
  const token = crypto.randomBytes(24).toString('hex');
  res.cookie('csrf_token', token, csrfCookie);
  return token;
}

async function issueAuth(res, user, req) {
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    'INSERT INTO sessions (jti,user_id,user_agent,expires_at) VALUES ($1,$2,$3,$4)',
    [jti, user.id, String(req.get('user-agent') || '').slice(0,300), expiresAt]
  );
  const token = jwt.sign(
    { uid: user.id, sv: user.session_version },
    JWT_SECRET,
    { expiresIn: SESSION_TTL_HOURS + 'h', issuer: 'aurum', audience: 'aurum-web', jwtid: jti }
  );
  res.cookie('auth_token', token, authCookie);
  return issueCsrf(res);
}

function cleanEmail(value) { return String(value || '').trim().toLowerCase(); }
function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254; }
function bad(res, message, status) { return res.status(status || 400).json({ error: message }); }
function hashIp(value) {
  return crypto.createHmac('sha256', JWT_SECRET).update(String(value || '')).digest('hex');
}
async function audit(req, event, userId, details) {
  try {
    await pool.query(
      'INSERT INTO audit_logs (user_id,event,ip_hash,user_agent,details) VALUES ($1,$2,$3,$4,$5::jsonb)',
      [userId || null, event, hashIp(req.ip), String(req.get('user-agent') || '').slice(0,300), JSON.stringify(details || {})]
    );
  } catch (e) {
    console.error('Falha ao registrar auditoria:', e.message);
  }
}

async function auth(req, res, next) {
  try {
    const token = req.cookies.auth_token;
    if (!token) return bad(res, 'Sessão não encontrada. Entre novamente.', 401);
    const payload = jwt.verify(token, JWT_SECRET, { issuer: 'aurum', audience: 'aurum-web' });
    const result = await pool.query(
      'SELECT u.id,u.name,u.email,u.session_version,s.jti FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.jti=$2 AND s.revoked_at IS NULL AND s.expires_at>NOW()',
      [payload.uid, payload.jti]
    );
    const user = result.rows[0];
    if (!user || user.session_version !== payload.sv) return bad(res, 'Sessão expirada. Entre novamente.', 401);
    req.user = user;
    req.sessionJti = payload.jti;
    pool.query('UPDATE sessions SET last_seen_at=NOW() WHERE jti=$1', [payload.jti]).catch(()=>{});
    next();
  } catch (e) {
    return bad(res, 'Sessão inválida. Entre novamente.', 401);
  }
}

function csrf(req, res, next) {
  const sent = req.get('x-csrf-token');
  const cookie = req.cookies.csrf_token;
  if (!sent || !cookie || sent !== cookie) return bad(res, 'Sessão de segurança expirada. Recarregue a página.', 403);
  next();
}

async function initDb() {
  const sql = [
    "CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY,name VARCHAR(80) NOT NULL,email VARCHAR(254) NOT NULL,password_hash TEXT NOT NULL,session_version INTEGER NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users ((LOWER(email)))",
    "CREATE TABLE IF NOT EXISTS sessions (jti UUID PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,user_agent VARCHAR(300) NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),expires_at TIMESTAMPTZ NOT NULL,revoked_at TIMESTAMPTZ)",
    "CREATE INDEX IF NOT EXISTS sessions_user_active_idx ON sessions (user_id,revoked_at,expires_at)",
    "CREATE TABLE IF NOT EXISTS audit_logs (id BIGSERIAL PRIMARY KEY,user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,event VARCHAR(80) NOT NULL,ip_hash CHAR(64) NOT NULL,user_agent VARCHAR(300) NOT NULL DEFAULT '',details JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS audit_logs_user_created_idx ON audit_logs (user_id,created_at DESC)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ",
    "CREATE TABLE IF NOT EXISTS categories (id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name VARCHAR(40) NOT NULL,type VARCHAR(10) NOT NULL CHECK (type IN ('income','expense')),color VARCHAR(20) NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS transactions (id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,title VARCHAR(120) NOT NULL,type VARCHAR(10) NOT NULL CHECK (type IN ('income','expense')),amount BIGINT NOT NULL CHECK (amount > 0),category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,date DATE NOT NULL,status VARCHAR(10) NOT NULL CHECK (status IN ('paid','pending')),notes VARCHAR(1000) NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS budgets (id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,month CHAR(7) NOT NULL,\"limit\" BIGINT NOT NULL CHECK (\"limit\" > 0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS goals (id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name VARCHAR(80) NOT NULL,target BIGINT NOT NULL CHECK (target > 0),saved BIGINT NOT NULL DEFAULT 0 CHECK (saved >= 0),deadline DATE NOT NULL,color VARCHAR(20) NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
  ];
  for (const q of sql) await pool.query(q);
}

const defaultCategories = [
  ['Salário','income','#709487'],['Freelance','income','#c9aa76'],['Moradia','expense','#6f8ea2'],
  ['Alimentação','expense','#b392a3'],['Transporte','expense','#8e97bc'],['Lazer','expense','#c8836e'],
  ['Saúde','expense','#819268'],['Educação','expense','#61777e']
];

async function createDefaults(client, userId) {
  for (const row of defaultCategories) {
    await client.query('INSERT INTO categories (user_id,name,type,color) VALUES ($1,$2,$3,$4)', [userId, row[0], row[1], row[2]]);
  }
}

app.get('/health', function(req, res) { res.json({ ok: true }); });

app.post('/api/auth/register', async function(req, res) {
  const name = String(req.body.name || '').trim();
  const email = cleanEmail(req.body.email);
  const password = String(req.body.password || '');
  if (name.length < 2 || name.length > 80) return bad(res, 'Informe um nome válido.');
  if (!validEmail(email)) return bad(res, 'Informe um e-mail válido.');
  if (password.length < 15 || password.length > 128) return bad(res, 'A senha deve ter entre 15 e 128 caracteres.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query('SELECT 1 FROM users WHERE LOWER(email)=LOWER($1)', [email]);
    if (exists.rowCount) { await client.query('ROLLBACK'); return bad(res, 'Já existe uma conta com este e-mail.', 409); }
    const hash = await bcrypt.hash(password, 12);
    const result = await client.query('INSERT INTO users (name,email,password_hash) VALUES ($1,$2,$3) RETURNING id,name,email,session_version', [name,email,hash]);
    const user = result.rows[0];
    await createDefaults(client, user.id);
    await client.query('COMMIT');
    const csrfToken = await issueAuth(res, user, req);
    await audit(req, 'account_registered', user.id, {});
    res.status(201).json({ user: { id:user.id, name:user.name, email:user.email }, csrfToken:csrfToken });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    bad(res, 'Não foi possível criar a conta.', 500);
  } finally {
    client.release();
  }
});

app.post('/api/auth/login', async function(req, res) {
  const email = cleanEmail(req.body.email);
  const password = String(req.body.password || '');
  const result = await pool.query('SELECT id,name,email,password_hash,session_version,failed_login_count,locked_until FROM users WHERE LOWER(email)=LOWER($1)', [email]);
  const user = result.rows[0];

  if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
    return bad(res, 'Muitas tentativas. Aguarde alguns minutos e tente novamente.', 429);
  }

  const valid = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!user || !valid) {
    if (user) {
      const failures = Number(user.failed_login_count || 0) + 1;
      const lockMinutes = failures >= 5 ? Math.min(60, 5 * Math.pow(2, Math.min(failures - 5, 4))) : 0;
      await pool.query(
        "UPDATE users SET failed_login_count=$1,locked_until=CASE WHEN $2::int>0 THEN NOW()+($2::text||' minutes')::interval ELSE NULL END WHERE id=$3",
        [failures, lockMinutes, user.id]
      );
      await audit(req, 'login_failed', user.id, { locked: lockMinutes > 0 });
    }
    return bad(res, 'E-mail ou senha incorretos.', 401);
  }

  await pool.query('UPDATE users SET failed_login_count=0,locked_until=NULL,last_login_at=NOW() WHERE id=$1', [user.id]);
  const csrfToken = issueAuth(res, user);
  res.json({ user: { id:user.id, name:user.name, email:user.email }, csrfToken:csrfToken });
});

app.get('/api/session', auth, function(req, res) {
  const csrfToken = req.cookies.csrf_token || issueCsrf(res);
  res.json({ user: { id:req.user.id, name:req.user.name, email:req.user.email }, csrfToken:csrfToken });
});

app.post('/api/auth/logout', auth, csrf, async function(req, res) {
  await pool.query('UPDATE sessions SET revoked_at=NOW() WHERE jti=$1', [req.sessionJti]);
  await audit(req, 'logout', req.user.id, {});
  res.clearCookie('auth_token', { path:'/' });
  res.clearCookie('csrf_token', { path:'/' });
  res.json({ ok:true });
});

app.get('/api/data', auth, async function(req, res) {
  const uid = req.user.id;
  const categories = await pool.query('SELECT id,name,type,color FROM categories WHERE user_id=$1 ORDER BY id', [uid]);
  const transactions = await pool.query("SELECT id,title,type,amount,category_id,TO_CHAR(date,'YYYY-MM-DD') AS date,status,notes FROM transactions WHERE user_id=$1 ORDER BY date DESC,id DESC", [uid]);
  const budgets = await pool.query('SELECT id,category_id,month,\"limit\" FROM budgets WHERE user_id=$1 ORDER BY month DESC,id', [uid]);
  const goals = await pool.query("SELECT id,name,target,saved,TO_CHAR(deadline,'YYYY-MM-DD') AS deadline,color FROM goals WHERE user_id=$1 ORDER BY deadline,id", [uid]);
  res.json({ user:{id:req.user.id,name:req.user.name,email:req.user.email}, categories:categories.rows, transactions:transactions.rows, budgets:budgets.rows, goals:goals.rows });
});

function parseMoney(v) { const n=Number(v); return Number.isSafeInteger(n) && n>=0 && n<=1000000000000 ? n : null; }
function validType(v) { return v==='income' || v==='expense'; }
function validStatus(v) { return v==='paid' || v==='pending'; }
function validDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }
function validMonth(v) { return /^\d{4}-\d{2}$/.test(String(v || '')); }
function validColor(v) { return /^#[0-9a-fA-F]{6}$/.test(String(v || '')); }

async function ownedCategory(userId, id, type) {
  const result = await pool.query('SELECT id,type FROM categories WHERE id=$1 AND user_id=$2', [id,userId]);
  const row = result.rows[0];
  return row && (!type || row.type===type) ? row : null;
}

app.post('/api/transactions', auth, csrf, async function(req,res) {
  const title=String(req.body.title||'').trim(), type=req.body.type, amount=parseMoney(req.body.amount), categoryId=req.body.category_id, date=req.body.date, status=req.body.status, notes=String(req.body.notes||'').slice(0,1000);
  if (!title || title.length>120 || !validType(type) || !amount || !validDate(date) || !validStatus(status)) return bad(res,'Revise os dados do lançamento.');
  if (!(await ownedCategory(req.user.id,categoryId,type))) return bad(res,'Categoria inválida.');
  const r=await pool.query('INSERT INTO transactions (user_id,title,type,amount,category_id,date,status,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[req.user.id,title,type,amount,categoryId,date,status,notes]);
  res.status(201).json({id:r.rows[0].id});
});

app.put('/api/transactions/:id', auth, csrf, async function(req,res) {
  const title=String(req.body.title||'').trim(), type=req.body.type, amount=parseMoney(req.body.amount), categoryId=req.body.category_id, date=req.body.date, status=req.body.status, notes=String(req.body.notes||'').slice(0,1000);
  if (!title || title.length>120 || !validType(type) || !amount || !validDate(date) || !validStatus(status)) return bad(res,'Revise os dados do lançamento.');
  if (!(await ownedCategory(req.user.id,categoryId,type))) return bad(res,'Categoria inválida.');
  const r=await pool.query('UPDATE transactions SET title=$1,type=$2,amount=$3,category_id=$4,date=$5,status=$6,notes=$7 WHERE id=$8 AND user_id=$9',[title,type,amount,categoryId,date,status,notes,req.params.id,req.user.id]);
  if (!r.rowCount) return bad(res,'Lançamento não encontrado.',404);
  res.json({ok:true});
});

app.delete('/api/transactions/:id', auth, csrf, async function(req,res) {
  const r=await pool.query('DELETE FROM transactions WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id]);
  if (!r.rowCount) return bad(res,'Lançamento não encontrado.',404);
  res.json({ok:true});
});

app.post('/api/budgets', auth, csrf, async function(req,res) {
  const limit=parseMoney(req.body.limit);
  if (!limit || !validMonth(req.body.month)) return bad(res,'Revise os dados do orçamento.');
  if (!(await ownedCategory(req.user.id,req.body.category_id,'expense'))) return bad(res,'Categoria inválida.');
  const r=await pool.query('INSERT INTO budgets (user_id,category_id,month,\"limit\") VALUES ($1,$2,$3,$4) RETURNING id',[req.user.id,req.body.category_id,req.body.month,limit]);
  res.status(201).json({id:r.rows[0].id});
});

app.put('/api/budgets/:id', auth, csrf, async function(req,res) {
  const limit=parseMoney(req.body.limit);
  if (!limit || !validMonth(req.body.month)) return bad(res,'Revise os dados do orçamento.');
  if (!(await ownedCategory(req.user.id,req.body.category_id,'expense'))) return bad(res,'Categoria inválida.');
  const r=await pool.query('UPDATE budgets SET category_id=$1,month=$2,\"limit\"=$3 WHERE id=$4 AND user_id=$5',[req.body.category_id,req.body.month,limit,req.params.id,req.user.id]);
  if (!r.rowCount) return bad(res,'Orçamento não encontrado.',404);
  res.json({ok:true});
});

app.delete('/api/budgets/:id', auth, csrf, async function(req,res) {
  const r=await pool.query('DELETE FROM budgets WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id]);
  if (!r.rowCount) return bad(res,'Orçamento não encontrado.',404);
  res.json({ok:true});
});

app.post('/api/goals', auth, csrf, async function(req,res) {
  const target=parseMoney(req.body.target), saved=parseMoney(req.body.saved), name=String(req.body.name||'').trim();
  if (name.length<2 || name.length>80 || !target || saved===null || !validDate(req.body.deadline) || !validColor(req.body.color)) return bad(res,'Revise os dados do objetivo.');
  const r=await pool.query('INSERT INTO goals (user_id,name,target,saved,deadline,color) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',[req.user.id,name,target,saved,req.body.deadline,req.body.color]);
  res.status(201).json({id:r.rows[0].id});
});

app.put('/api/goals/:id', auth, csrf, async function(req,res) {
  const target=parseMoney(req.body.target), saved=parseMoney(req.body.saved), name=String(req.body.name||'').trim();
  if (name.length<2 || name.length>80 || !target || saved===null || !validDate(req.body.deadline) || !validColor(req.body.color)) return bad(res,'Revise os dados do objetivo.');
  const r=await pool.query('UPDATE goals SET name=$1,target=$2,saved=$3,deadline=$4,color=$5 WHERE id=$6 AND user_id=$7',[name,target,saved,req.body.deadline,req.body.color,req.params.id,req.user.id]);
  if (!r.rowCount) return bad(res,'Objetivo não encontrado.',404);
  res.json({ok:true});
});

app.delete('/api/goals/:id', auth, csrf, async function(req,res) {
  const r=await pool.query('DELETE FROM goals WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id]);
  if (!r.rowCount) return bad(res,'Objetivo não encontrado.',404);
  res.json({ok:true});
});

app.post('/api/categories', auth, csrf, async function(req,res) {
  const name=String(req.body.name||'').trim();
  if (name.length<2 || name.length>40 || !validType(req.body.type) || !validColor(req.body.color)) return bad(res,'Revise os dados da categoria.');
  const r=await pool.query('INSERT INTO categories (user_id,name,type,color) VALUES ($1,$2,$3,$4) RETURNING id',[req.user.id,name,req.body.type,req.body.color]);
  res.status(201).json({id:r.rows[0].id});
});

app.put('/api/categories/:id', auth, csrf, async function(req,res) {
  const name=String(req.body.name||'').trim();
  if (name.length<2 || name.length>40 || !validType(req.body.type) || !validColor(req.body.color)) return bad(res,'Revise os dados da categoria.');
  const r=await pool.query('UPDATE categories SET name=$1,type=$2,color=$3 WHERE id=$4 AND user_id=$5',[name,req.body.type,req.body.color,req.params.id,req.user.id]);
  if (!r.rowCount) return bad(res,'Categoria não encontrada.',404);
  res.json({ok:true});
});

app.delete('/api/categories/:id', auth, csrf, async function(req,res) {
  const r=await pool.query('DELETE FROM categories WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id]);
  if (!r.rowCount) return bad(res,'Categoria não encontrada.',404);
  res.json({ok:true});
});

app.put('/api/profile', auth, csrf, async function(req,res) {
  const name=String(req.body.name||'').trim();
  if (name.length<2 || name.length>80) return bad(res,'Informe um nome válido.');
  await pool.query('UPDATE users SET name=$1 WHERE id=$2',[name,req.user.id]);
  res.json({ok:true});
});

app.put('/api/password', auth, csrf, async function(req,res) {
  const currentPassword=String(req.body.currentPassword||''), newPassword=String(req.body.newPassword||'');
  if (newPassword.length<15 || newPassword.length>128) return bad(res,'A nova senha deve ter entre 15 e 128 caracteres.');
  const found=await pool.query('SELECT password_hash,session_version FROM users WHERE id=$1',[req.user.id]);
  if (!(await bcrypt.compare(currentPassword,found.rows[0].password_hash))) return bad(res,'A senha atual está incorreta.',401);
  const hash=await bcrypt.hash(newPassword,12);
  const updated=await pool.query('UPDATE users SET password_hash=$1,session_version=session_version+1 WHERE id=$2 RETURNING id,name,email,session_version',[hash,req.user.id]);
  await pool.query('UPDATE sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL',[req.user.id]);
  const csrfToken=await issueAuth(res,updated.rows[0],req);
  await audit(req, 'password_changed', req.user.id, {});
  res.json({csrfToken:csrfToken});
});

app.post('/api/demo', auth, csrf, async function(req,res) {
  const uid=req.user.id;
  const counts=await pool.query('SELECT (SELECT COUNT(*) FROM transactions WHERE user_id=$1) AS tx,(SELECT COUNT(*) FROM budgets WHERE user_id=$1) AS budgets,(SELECT COUNT(*) FROM goals WHERE user_id=$1) AS goals',[uid]);
  if (Number(counts.rows[0].tx)||Number(counts.rows[0].budgets)||Number(counts.rows[0].goals)) return bad(res,'Os exemplos só podem ser adicionados a uma conta ainda vazia.',409);
  const cats=await pool.query('SELECT id,name FROM categories WHERE user_id=$1',[uid]);
  const byName=Object.fromEntries(cats.rows.map(function(c){return [c.name,c.id];}));
  const now=new Date(), month=String(now.getFullYear())+'-'+String(now.getMonth()+1).padStart(2,'0');
  function d(day){ return month+'-'+String(day).padStart(2,'0'); }
  const sample=[
    ['Salário mensal','income',850000,byName['Salário'],d(5),'paid'],
    ['Aluguel do apartamento','expense',215000,byName['Moradia'],d(5),'paid'],
    ['Supermercado','expense',56890,byName['Alimentação'],d(9),'paid'],
    ['Plano de saúde','expense',38900,byName['Saúde'],d(10),'paid'],
    ['Combustível','expense',24500,byName['Transporte'],d(14),'paid'],
    ['Cinema e café','expense',12600,byName['Lazer'],d(22),'paid']
  ];
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of sample) await client.query('INSERT INTO transactions (user_id,title,type,amount,category_id,date,status,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[uid,row[0],row[1],row[2],row[3],row[4],row[5],'']);
    await client.query('INSERT INTO budgets (user_id,category_id,month,\"limit\") VALUES ($1,$2,$3,$4)',[uid,byName['Alimentação'],month,120000]);
    const deadline=new Date(now.getFullYear()+1,now.getMonth(),1);
    const deadlineText=String(deadline.getFullYear())+'-'+String(deadline.getMonth()+1).padStart(2,'0')+'-01';
    await client.query('INSERT INTO goals (user_id,name,target,saved,deadline,color) VALUES ($1,$2,$3,$4,$5,$6)',[uid,'Reserva de emergência',3000000,450000,deadlineText,'#709487']);
    await client.query('COMMIT');
    res.json({ok:true});
  } catch(e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
});

app.get('/api/security/sessions', auth, async function(req,res) {
  const rows = await pool.query(
    'SELECT jti,created_at,last_seen_at,expires_at,user_agent,CASE WHEN jti=$2 THEN true ELSE false END AS current FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>NOW() ORDER BY last_seen_at DESC',
    [req.user.id, req.sessionJti]
  );
  res.json({ sessions: rows.rows });
});

app.get('/api/security/events', auth, async function(req,res) {
  const rows = await pool.query(
    'SELECT event,created_at,details FROM audit_logs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30',
    [req.user.id]
  );
  res.json({ events: rows.rows });
});

app.post('/api/security/logout-others', auth, csrf, async function(req,res) {
  const result = await pool.query(
    'UPDATE sessions SET revoked_at=NOW() WHERE user_id=$1 AND jti<>$2 AND revoked_at IS NULL',
    [req.user.id, req.sessionJti]
  );
  await audit(req, 'sessions_revoked_others', req.user.id, { count: result.rowCount });
  res.json({ ok:true, revoked:result.rowCount });
});

app.post('/api/security/logout-all', auth, csrf, async function(req,res) {
  const result = await pool.query('UPDATE sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL', [req.user.id]);
  await audit(req, 'sessions_revoked_all', req.user.id, { count: result.rowCount });
  res.clearCookie('auth_token', { path:'/' });
  res.clearCookie('csrf_token', { path:'/' });
  res.json({ ok:true, revoked:result.rowCount });
});

app.delete('/api/security/account', auth, csrf, async function(req,res) {
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');
  if (confirm !== 'EXCLUIR') return bad(res, 'Digite EXCLUIR para confirmar.', 400);
  const found = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!found.rows[0] || !(await bcrypt.compare(password, found.rows[0].password_hash))) {
    await audit(req, 'account_delete_failed', req.user.id, {});
    return bad(res, 'Senha incorreta.', 401);
  }
  await audit(req, 'account_deleted', req.user.id, {});
  await pool.query('DELETE FROM users WHERE id=$1', [req.user.id]);
  res.clearCookie('auth_token', { path:'/' });
  res.clearCookie('csrf_token', { path:'/' });
  res.json({ ok:true });
});

app.use(express.static(__dirname, { index:'index.html', extensions:['html'], setHeaders:function(res,filePath){ if(filePath.endsWith('index.html')) res.setHeader('Cache-Control','no-cache'); } }));

app.get('/{*splat}', function(req,res) {
  if (req.path.startsWith('/api/')) return res.status(404).json({error:'Rota não encontrada.'});
  res.sendFile(path.join(__dirname,'index.html'));
});

app.use(function(err,req,res,next) {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({error:'Ocorreu um erro interno. Tente novamente.'});
});

initDb().then(function(){
  app.listen(PORT,'0.0.0.0',function(){ console.log('Aurum online na porta '+PORT); });
}).catch(function(err){
  console.error('Falha ao inicializar o banco:',err);
  process.exit(1);
});
