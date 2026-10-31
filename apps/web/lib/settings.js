import { ensurePaymentSchema } from './payments.js';
import { PUBLICATION_FEE_MINOR } from './pricing.js';

// Configurações que o Admin pode alterar (tabela fair_settings).
// Se uma chave não existir, usa-se o valor por omissão do código.
export async function getSetting(pool, key, fallback = null) {
  try {
    const r = await pool.query('select value from fair_settings where key = $1', [key]);
    return r.rows[0]?.value ?? fallback;
  } catch {
    return fallback;
  }
}

export async function setSetting(pool, key, value) {
  await ensurePaymentSchema();
  await pool.query(
    `insert into fair_settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, String(value)],
  );
}

/** Taxa de publicação por livro de parceiro externo (configurável no painel). */
export async function getPublicationFeeMinor(pool) {
  const raw = await getSetting(pool, 'publication_fee_minor', null);
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : PUBLICATION_FEE_MINOR;
}
