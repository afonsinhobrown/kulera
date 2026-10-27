import pg from 'pg';
export const pool = globalThis.__kuleraPool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
