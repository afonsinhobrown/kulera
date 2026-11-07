// Importa os autores dos livros antigos (que só têm o nome em texto livre) para o registo
// de autores e liga-os aos livros.
//
//   node scripts/import-authors.mjs            → mostra o que faria
//   node scripts/import-authors.mjs --apply    → grava
//
// Livros de Emílio Cossa ficam ligados ao autor da casa (é parte relacionada, 0% de royalties).
// Os restantes ficam como registo inicial, sem NUIT — a declaração do valor fica para o painel.

import pg from 'pg';
import { EMILIO_ID, ensureFinanceSchema, ensureRelatedAuthor, upsertAuthor } from '../lib/finance.js';

const apply = process.argv.includes('--apply');

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL no ambiente.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

try {
  await ensureFinanceSchema(pool);
  await ensureRelatedAuthor(pool);

  const books = (await pool.query(
    `select id, title, author from fair_books where author is not null and trim(author) <> '' order by created_at`,
  )).rows;

  const linked = new Set(
    (await pool.query('select book_id, author_id from fair_book_authors')).rows.map((r) => `${r.book_id}:${r.author_id}`),
  );

  const nomes = new Map();
  for (const b of books) {
    const nome = String(b.author).trim();
    if (!nomes.has(nome)) nomes.set(nome, []);
    nomes.get(nome).push(b);
  }

  console.log(`${books.length} livro(s) com autor, ${nomes.size} nome(s) distintos.`);

  const plano = [];
  for (const [nome, lista] of nomes) {
    const ehEmilio = /em[íi]lio\s+cossa/i.test(nome);
    const alvo = ehEmilio
      ? { id: EMILIO_ID, created: false }
      : await (apply ? upsertAuthor(pool, { fullName: nome, allowMissingNuit: true }) : Promise.resolve({ id: '(novo)', created: true }));
    plano.push({ nome, alvo, livros: lista });
  }

  let novos = 0;
  for (const p of plano) {
    console.log(`  ${p.alvo.created ? '+' : '='} ${p.nome} → ${p.livros.length} livro(s)` + (p.nome !== p.nome.trim() ? '' : ''));
    for (const b of p.livros) {
      if (linked.has(`${b.id}:${p.alvo.id}`)) continue;
      novos += 1;
      if (apply) {
        await pool.query(
          `insert into fair_book_authors (book_id, author_id, role, share_bps, amount_minor)
           values ($1,$2,'author',0,null) on conflict (book_id, author_id) do nothing`,
          [b.id, p.alvo.id],
        );
      }
    }
  }

  console.log(apply ? `Ligações criadas: ${novos}.` : `Ligações a criar: ${novos} (correr com --apply para gravar).`);
  console.log('O valor de cada autor por livro fica a 0 até ser declarado no painel.');
} catch (e) {
  console.error('Falhou:', e?.message || String(e));
  process.exitCode = 1;
} finally {
  await pool.end();
}
