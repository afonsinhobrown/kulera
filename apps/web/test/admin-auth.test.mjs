// Testes da autenticação dos administradores.
// A base falsa em memória responde apenas às consultas usadas por lib/admin-auth.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COOKIE_NAME,
  createSession,
  destroyOtherSessions,
  destroySession,
  findUser,
  hashIp,
  hashPassword,
  readCookie,
  recentFailures,
  recordAttempt,
  saveBank,
  sessionUser,
  upsertAdmin,
  verifyPassword,
  bankOf,
} from '../lib/admin-auth.js';

function fakePool() {
  const users = [];
  const sessions = [];
  const attempts = [];
  const banks = [];
  const changes = [];
  const rows = (r) => ({ rows: r, rowCount: r.length });
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

  return {
    _state: { users, sessions, attempts, banks, changes },
    async query(sql, p = []) {
      const s = norm(sql);
      if (/^create table/i.test(s)) return rows([]);

      if (/^insert into fair_admin_users/i.test(s)) {
        users.push({
          id: 'u' + (users.length + 1),
          username: p[0],
          password_hash: p[1],
          role: p[2],
          display_name: p[3],
          can_change_password: p[4],
          status: 'active',
          last_login_at: null,
        });
        return rows([]);
      }
      if (/^update fair_admin_users set password_hash = \$2, role/i.test(s)) {
        const u = users.find((x) => x.username === p[0]);
        Object.assign(u, { password_hash: p[1], role: p[2], display_name: p[3], can_change_password: p[4], status: 'active' });
        return rows([]);
      }
      if (/^select id, username, password_hash.*from fair_admin_users where username/i.test(s)) {
        const u = users.find((x) => x.username === p[0]);
        return rows(u ? [u] : []);
      }
      if (/^select count\(\*\)::int as n from fair_admin_users/i.test(s)) return rows([{ n: users.length }]);
      if (/^update fair_admin_users set last_login_at/i.test(s)) return rows([]);
      if (/^update fair_admin_users set password_hash = \$2 where id/i.test(s)) {
        const u = users.find((x) => x.id === p[0]);
        if (u) u.password_hash = p[1];
        return rows([]);
      }

      if (/^insert into fair_admin_login_attempts/i.test(s)) {
        attempts.push({ username: p[0], ip_hash: p[1], ok: p[2] === true, created_at: new Date() });
        return rows([]);
      }
      if (/^select count\(\*\)::int as n from fair_admin_login_attempts/i.test(s)) {
        const n = attempts.filter(
          (a) => !a.ok && a.username === p[0] && a.ip_hash === p[1] && a.created_at > p[2],
        ).length;
        return rows([{ n }]);
      }

      if (/^insert into fair_admin_sessions/i.test(s)) {
        sessions.push({ token_hash: p[0], user_id: p[1], expires_at: p[2] });
        return rows([]);
      }
      if (/^select s\.token_hash, u\.id/i.test(s)) {
        const sess = sessions.find((x) => x.token_hash === p[0] && x.expires_at > new Date());
        if (!sess) return rows([]);
        const u = users.find((x) => x.id === sess.user_id);
        return rows(u ? [{ ...u, token_hash: sess.token_hash }] : []);
      }
      if (/^delete from fair_admin_sessions where token_hash/i.test(s)) {
        const i = sessions.findIndex((x) => x.token_hash === p[0]);
        if (i >= 0) sessions.splice(i, 1);
        return rows([]);
      }
      if (/^delete from fair_admin_sessions where user_id/i.test(s)) {
        for (let i = sessions.length - 1; i >= 0; i -= 1) {
          if (sessions[i].user_id === p[0] && sessions[i].token_hash !== p[1]) sessions.splice(i, 1);
        }
        return rows([]);
      }

      if (/^select holder, bank_name/i.test(s)) {
        return rows(banks.filter((b) => b.user_id === p[0]));
      }
      if (/^insert into fair_admin_bank_changes/i.test(s)) {
        changes.push({ user_id: p[0], before: p[1], after: p[2], ip_hash: p[3] });
        return rows([]);
      }
      if (/^insert into fair_admin_bank/i.test(s)) {
        const i = banks.findIndex((b) => b.user_id === p[0]);
        const row = { user_id: p[0], holder: p[1], bank_name: p[2], account_number: p[3], nib: p[4], wallet: p[5] };
        if (i >= 0) banks[i] = row;
        else banks.push(row);
        return rows([]);
      }

      throw new Error('SQL não previsto no teste: ' + s.slice(0, 90));
    },
  };
}

test('a senha é guardada com sal e nunca em texto', () => {
  const a = hashPassword('senha-teste-tecno');
  const b = hashPassword('senha-teste-tecno');
  assert.notEqual(a, b, 'duas gravações da mesma senha dão hashes diferentes (sal aleatório)');
  assert.ok(!a.includes('senha-teste-tecno'));
  assert.ok(a.startsWith('pbkdf2$'));
  assert.equal(verifyPassword('senha-teste-tecno', a), true);
  assert.equal(verifyPassword('outra', a), false);
});

test('verifyPassword recusa hashes malformados sem lançar', () => {
  for (const bad of ['', null, 'x', 'bcrypt$1$2$3', 'pbkdf2$0$a$b', 'pbkdf2$100000$salt$zz']) {
    assert.equal(verifyPassword('x', bad), false);
  }
});

test('upsertAdmin cria e depois actualiza; contas duplicadas não nascem', async () => {
  const pool = fakePool();
  const first = await upsertAdmin(pool, {
    username: 'tecnoincubadora',
    password: 'senha-teste-tecno',
    role: 'tecnoincubadora',
    displayName: 'TecnoIncubadora',
    canChangePassword: false,
  });
  assert.equal(first.created, true);
  const second = await upsertAdmin(pool, {
    username: 'tecnoincubadora',
    password: 'nova-senha-longa',
    role: 'tecnoincubadora',
    displayName: 'TecnoIncubadora',
    canChangePassword: false,
  });
  assert.equal(second.created, false);
  assert.equal(pool._state.users.length, 1);

  const user = await findUser(pool, 'TECNOINCUBADORA');
  assert.ok(user, 'procura normaliza maiúsculas');
  assert.equal(user.can_change_password, false, 'a senha da TecnoIncubadora fica bloqueada');
  assert.equal(verifyPassword('nova-senha-longa', user.password_hash), true);
});

test('sessão: criada, lida, terminada e expirada', async () => {
  const pool = fakePool();
  await upsertAdmin(pool, { username: 'kulera', password: 'senha-teste-kulera', role: 'kulera', displayName: 'Editora Kulera' });
  const user = await findUser(pool, 'kulera');

  const { token } = await createSession(pool, user.id);
  const live = await sessionUser(pool, token);
  assert.equal(live.username, 'kulera');

  await destroySession(pool, token);
  assert.equal(await sessionUser(pool, token), null);

  const { token: t2 } = await createSession(pool, user.id);
  assert.ok(await sessionUser(pool, t2));
  // Expira no passado → deixa de valer.
  pool._state.sessions.find((s) => s.token_hash).expires_at = new Date(Date.now() - 1000);
  assert.equal(await sessionUser(pool, t2), null);

  assert.equal(await sessionUser(pool, 'inexistente'), null);
  assert.equal(await sessionUser(pool, ''), null);
});

test('mudar a senha termina as outras sessões e mantém a actual', async () => {
  const pool = fakePool();
  await upsertAdmin(pool, { username: 'kulera', password: 'senha-teste-kulera', role: 'kulera', displayName: 'Editora Kulera' });
  const user = await findUser(pool, 'kulera');
  const a = await createSession(pool, user.id);
  const b = await createSession(pool, user.id);

  const current = await sessionUser(pool, b.token);
  await pool.query('update fair_admin_users set password_hash = $2 where id = $1', [user.id, hashPassword('outra-senha-9')]);
  await destroyOtherSessions(pool, user.id, b.token);

  assert.equal(await sessionUser(pool, a.token), null, 'sessão antiga cai');
  assert.ok(await sessionUser(pool, b.token), 'sessão que trocou a senha continua');
  assert.equal(pool._state.users[0].password_hash !== current.password_hash, true);
});

test('limite de tentativas falhadas conta só a janela recente', async () => {
  const pool = fakePool();
  const ip = '203.0.113.9';
  for (let i = 0; i < 3; i += 1) await recordAttempt(pool, 'kulera', ip, false);
  await recordAttempt(pool, 'kulera', ip, true);
  assert.equal(await recentFailures(pool, 'kulera', ip), 3);
  assert.equal(await recentFailures(pool, 'kulera', '198.51.100.1'), 0);

  // Tentativas antigas não contam.
  pool._state.attempts.forEach((a) => { a.created_at = new Date(Date.now() - 60 * 60 * 1000); });
  assert.equal(await recentFailures(pool, 'kulera', ip), 0);
});

test('dados bancários: guardados com registo do antes e do depois', async () => {
  const pool = fakePool();
  await upsertAdmin(pool, { username: 'kulera', password: 'senha-teste-kulera', role: 'kulera', displayName: 'Editora Kulera' });
  const user = await findUser(pool, 'kulera');

  await saveBank(pool, user.id, { holder: 'Editora Kulera, Lda', bank_name: 'BCI', account_number: '1234567890' }, '1.2.3.4');
  const first = await bankOf(pool, user.id);
  assert.equal(first.holder, 'Editora Kulera, Lda');

  await saveBank(pool, user.id, { holder: 'Editora Kulera, Lda', bank_name: 'Millennium bim', account_number: '999' }, '1.2.3.4');
  const changes = pool._state.changes;
  assert.equal(changes.length, 2, 'cada alteração deixa registo');
  assert.equal(JSON.parse(changes[1].before).bank_name, 'BCI');
  assert.equal(JSON.parse(changes[1].after).bank_name, 'Millennium bim');
  assert.ok(changes[1].ip_hash && changes[1].ip_hash !== '1.2.3.4', 'o IP é guardado com hash');
});

test('saveBank limpa caracteres de controlo e corta o tamanho', async () => {
  const pool = fakePool();
  await upsertAdmin(pool, { username: 'kulera', password: 'senha-teste-kulera', role: 'kulera', displayName: 'Editora Kulera' });
  const user = await findUser(pool, 'kulera');
  const saved = await saveBank(pool, user.id, { holder: 'A\u0000B\nC', wallet: 'x'.repeat(60) }, '');
  assert.equal(saved.holder, 'ABC');
  assert.equal(saved.wallet.length, 20);
});

test('cookie de sessão é lido do cabeçalho', () => {
  const req = { headers: { cookie: 'a=1; kadm=abc123; b=2' } };
  assert.equal(readCookie(req, COOKIE_NAME), 'abc123');
  assert.equal(readCookie(req, 'naoexiste'), null);
  assert.equal(readCookie({ headers: {} }, COOKIE_NAME), null);
  assert.equal(hashIp('1.2.3.4'), hashIp('1.2.3.4'));
  assert.notEqual(hashIp('1.2.3.4'), hashIp('1.2.3.5'));
});

// ===== Endpoint /api/admin-session, de ponta a ponta sobre a base falsa =====

const makeRes = () => {
  const r = {
    code: 200,
    h: {},
    setHeader(k, v) { r.h[k.toLowerCase()] = v; },
    status(c) { r.code = c; return r; },
    json(b) { r.body = b; return r; },
  };
  return r;
};

const req = ({ method = 'POST', body, cookie, ip = '203.0.113.10' }) => ({
  method,
  headers: { 'x-forwarded-for': ip, 'x-requested-with': 'kulera-admin', ...(cookie ? { cookie } : {}) },
  body,
});

// O módulo lib/db.js fixa o pool na primeira importação, por isso os testes do
// endpoint partilham uma única base falsa e limpam-na entre casos.
let sharedPool = null;

async function readyEndpoint({ seed = true } = {}) {
  if (!sharedPool) {
    sharedPool = fakePool();
    globalThis.__kuleraPool = sharedPool;
  }
  const state = sharedPool._state;
  for (const key of ['users', 'sessions', 'attempts', 'banks', 'changes']) state[key].length = 0;

  if (seed) {
    await upsertAdmin(sharedPool, {
      username: 'tecnoincubadora',
      password: 'senha-teste-tecno',
      role: 'tecnoincubadora',
      displayName: 'TecnoIncubadora',
      canChangePassword: false,
    });
    await upsertAdmin(sharedPool, {
      username: 'kulera',
      password: 'senha-teste-kulera',
      role: 'kulera',
      displayName: 'Editora Kulera',
    });
  }
  const { default: handler } = await import('../api/admin-session.js');
  return { pool: sharedPool, handler };
}

const cookieOf = (res) => {
  const raw = String(res.h['set-cookie'] || '');
  return raw.split(';')[0];
};

test('endpoint: senha errada não abre sessão e conta tentativas', async () => {
  const { handler } = await readyEndpoint();
  let res = makeRes();
  await handler(req({ body: { action: 'login', username: 'kulera', password: 'errada' } }), res);
  assert.equal(res.code, 401);
  assert.equal(res.body.error, 'invalid_credentials');
  assert.equal(res.h['set-cookie'], undefined, 'sem cookie quando falha');

  // Utilizador inexistente responde exactamente o mesmo (não revela quem existe).
  res = makeRes();
  await handler(req({ body: { action: 'login', username: 'ninguem', password: 'x' } }), res);
  assert.equal(res.code, 401);
  assert.equal(res.body.error, 'invalid_credentials');
});

test('endpoint: login, leitura da sessão, dados bancários, senha bloqueada e logout', async () => {
  const { handler } = await readyEndpoint();

  let res = makeRes();
  await handler(req({ body: { action: 'login', username: 'tecnoincubadora', password: 'senha-teste-tecno' } }), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.user.role, 'tecnoincubadora');
  assert.equal(res.body.user.canChangePassword, false);
  const cookie = cookieOf(res);
  assert.match(cookie, /^kadm=/);
  assert.match(String(res.h['set-cookie']), /HttpOnly/);

  // GET devolve quem está autenticado.
  res = makeRes();
  await handler(req({ method: 'GET', cookie }), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.user.username, 'tecnoincubadora');

  // Sem sessão não se lê nada.
  res = makeRes();
  await handler(req({ method: 'GET' }), res);
  assert.equal(res.code, 401);

  // Dados bancários: guardados na própria sessão, com registo.
  res = makeRes();
  await handler(
    req({ cookie, body: { action: 'save_bank', bank: { holder: 'TecnoIncubadora', bank_name: 'BCI', account_number: '123' } } }),
    res,
  );
  assert.equal(res.code, 200);
  assert.equal(res.body.bank.bank_name, 'BCI');
  res = makeRes();
  await handler(req({ method: 'GET', cookie }), res);
  assert.equal(res.body.bank.account_number, '123');

  // A senha da TecnoIncubadora não se altera pela aplicação.
  res = makeRes();
  await handler(req({ cookie, body: { action: 'change_password', current: 'senha-teste-tecno', password: 'outra-senha' } }), res);
  assert.equal(res.code, 403);
  assert.equal(res.body.error, 'password_locked');

  // POST sem o cabeçalho anti-CSRF é recusado.
  res = makeRes();
  const semCsrf = req({ cookie, body: { action: 'save_bank', bank: {} } });
  delete semCsrf.headers['x-requested-with'];
  await handler(semCsrf, res);
  assert.equal(res.code, 403);
  assert.equal(res.body.error, 'csrf');

  // Logout fecha a sessão e limpa o cookie.
  res = makeRes();
  await handler(req({ cookie, body: { action: 'logout' } }), res);
  assert.equal(res.code, 200);
  assert.match(String(res.h['set-cookie']), /Max-Age=0/);
  res = makeRes();
  await handler(req({ method: 'GET', cookie }), res);
  assert.equal(res.code, 401);
});

test('endpoint: a Kulera pode trocar de senha (recomendado, não obrigatório)', async () => {
  const { handler } = await readyEndpoint();
  let res = makeRes();
  await handler(req({ body: { action: 'login', username: 'kulera', password: 'senha-teste-kulera' } }), res);
  const cookie = cookieOf(res);
  assert.equal(res.body.passwordChangeRecommended, true);

  res = makeRes();
  await handler(req({ cookie, body: { action: 'change_password', current: 'senha-teste-kulera', password: 'curta' } }), res);
  assert.equal(res.code, 400);
  assert.equal(res.body.error, 'password_too_short');

  res = makeRes();
  await handler(req({ cookie, body: { action: 'change_password', current: 'errada', password: 'senha-boa-123' } }), res);
  assert.equal(res.code, 401);

  res = makeRes();
  await handler(req({ cookie, body: { action: 'change_password', current: 'senha-teste-kulera', password: 'senha-boa-123' } }), res);
  assert.equal(res.code, 200);
  assert.equal((await findUser(globalThis.__kuleraPool, 'kulera')).password_hash.startsWith('pbkdf2$'), true);
});

test('endpoint: sem administradores criados, pede o seed em vez de inventar senha', async () => {
  const { handler } = await readyEndpoint({ seed: false });
  const res = makeRes();
  await handler(req({ body: { action: 'login', username: 'kulera', password: 'senha-teste-kulera' } }), res);
  assert.equal(res.code, 503);
  assert.equal(res.body.error, 'admin_not_seeded');
});
