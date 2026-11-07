// Cria (ou actualiza) os dois administradores da plataforma.
//
// As senhas NÃO vivem no repositório: entram por variáveis de ambiente.
//
//   TECNOINCUBADORA_PASSWORD=... KULERA_PASSWORD=... node scripts/seed-admins.mjs
//
// Ou, uma vez só, com as senhas na linha de comando:
//
//   node scripts/seed-admins.mjs <senha-tecnoincubadora> <senha-kulera>
//
// Requer DATABASE_URL (a mesma que a aplicação usa).

import pg from 'pg';
import { ensureAdminSchema, upsertAdmin, countAdmins } from '../lib/admin-auth.js';

const [, , argTecno, argKulera] = process.argv;

const tecno = String(process.env.TECNOINCUBADORA_PASSWORD ?? argTecno ?? '').trim();
const kulera = String(process.env.KULERA_PASSWORD ?? argKulera ?? '').trim();

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL no ambiente.');
  process.exit(1);
}
if (!tecno || !kulera) {
  console.error(
    'Faltam as senhas. Use:\n' +
      '  TECNOINCUBADORA_PASSWORD=... KULERA_PASSWORD=... node scripts/seed-admins.mjs\n' +
      'ou\n' +
      '  node scripts/seed-admins.mjs <senha-tecnoincubadora> <senha-kulera>',
  );
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

try {
  await ensureAdminSchema(pool);
  const before = await countAdmins(pool);

  // A senha da TecnoIncubadora não se altera dentro da aplicação: a conta é
  // criada com can_change_password = false. A da Kulera pode ser trocada — a
  // troca é recomendada, nunca obrigatória.
  const a = await upsertAdmin(pool, {
    username: 'tecnoincubadora',
    password: tecno,
    role: 'tecnoincubadora',
    displayName: 'TecnoIncubadora',
    canChangePassword: false,
  });
  const b = await upsertAdmin(pool, {
    username: 'kulera',
    password: kulera,
    role: 'kulera',
    displayName: 'Editora Kulera',
    canChangePassword: true,
  });

  console.log(
    `Administradores prontos (antes: ${before}). ` +
      `tecnoincubadora: ${a.created ? 'criado' : 'actualizado'}; ` +
      `kulera: ${b.created ? 'criado' : 'actualizado'}.`,
  );
  console.log('A senha da TecnoIncubadora está bloqueada para alteração dentro da app.');
} catch (e) {
  console.error('Falhou:', e?.message || String(e));
  process.exitCode = 1;
} finally {
  await pool.end();
}
