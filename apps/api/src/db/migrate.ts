import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Aplica as migrações por ordem, uma vez cada. Uso: DATABASE_URL=... node src/db/migrate.ts
export async function migrate(pool: pg.Pool, dir = fileURLToPath(new URL('../../migrations/', import.meta.url))): Promise<string[]> {
  await pool.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await pool.query('select name from schema_migrations')).rows.map((r) => r.name as string));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];

  for (const file of files) {
    if (done.has(file)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile(new URL(file, `file://${dir}`), 'utf8'));
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`Migração ${file} falhou: ${String(error)}`);
    } finally {
      client.release();
    }
  }
  return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL em falta');
  const pool = new pg.Pool({ connectionString: url });
  const applied = await migrate(pool);
  console.log(applied.length ? `Aplicadas: ${applied.join(', ')}` : 'Base de dados já está actualizada.');
  await pool.end();
}
