// Cálculo da divisão de cada venda, segundo as três regras do promotor.
//
// A: livro de autor terceiro na Kulera  → autor recebe o valor declarado; Kulera 0%;
//                                          resto (bruto − gateway − autor) fica com a
//                                          TecnoIncubadora.
// B: livro do Emílio Cossa (em qualquer editora) → autor 0%; Kulera 0%; TecnoIncubadora
//                                          fica com tudo menos o gateway.
// C: livros de outras editoras          → TecnoIncubadora retém 30% do bruto, e é de lá
//                                          que sai o gateway; a editora fica com 70%.
//
// Regra de ouro: o lado Kulera (margem da editora + royalties do Emílio) nunca pode ficar
// acima da TecnoIncubadora.

export const GATEWAY_BPS = 700; // 7% retidos pelo gateway em cada venda
export const PLATFORM_BPS = 3000; // 30% da plataforma no cenário C (gateway incluído)

export const SCENARIOS = {
  KULERA_AUTHOR: 'A',
  RELATED_AUTHOR: 'B',
  MARKET: 'C',
};

const share = (grossMinor, bps) => Number((BigInt(grossMinor) * BigInt(bps) + 5000n) / 10000n);

/** Taxa do gateway (7%) sobre o valor bruto. */
export function gatewayFee(grossMinor) {
  if (!Number.isInteger(grossMinor) || grossMinor < 0) throw new RangeError('valor inválido');
  return share(grossMinor, GATEWAY_BPS);
}

/** A regra de ouro, à parte, para poder ser validada ao configurar um livro. */
export function goldenRule({ kulera = 0, emilio = 0, tech = 0 }) {
  const kuleraSide = Number(kulera) + Number(emilio);
  const ok = kuleraSide <= Number(tech);
  return { ok, kuleraSide, tech: Number(tech), excess: ok ? 0 : kuleraSide - Number(tech) };
}

/**
 * Divide uma venda.
 *
 * @param {object} p
 * @param {number} p.grossMinor      valor bruto, em centavos
 * @param {'A'|'B'|'C'} p.scenario
 * @param {number} [p.authorShareBps]   valor do autor em pontos base (cenário A)
 * @param {number|null} [p.authorAmountMinor] valor fixo do autor, quando acordado em dinheiro
 *
 * `tech` é a fatia da plataforma antes de pagar o gateway; `techNet` é o que sobra depois
 * de o gateway levar os seus 7% (no cenário C o gateway sai dos 30%; nos cenários A e B
 * já foi descontado antes).
 */
export function splitSale({ grossMinor, scenario, authorShareBps = 0, authorAmountMinor = null } = {}) {
  if (!Number.isInteger(grossMinor) || grossMinor < 0) throw new RangeError('valor inválido');
  if (!Object.values(SCENARIOS).includes(scenario)) throw new RangeError('cenário inválido');

  const gateway = gatewayFee(grossMinor);
  let author = 0;
  let publisher = 0;
  let kulera = 0;
  let tech = 0;

  if (scenario === SCENARIOS.MARKET) {
    tech = share(grossMinor, PLATFORM_BPS);
    publisher = grossMinor - tech;
  } else if (scenario === SCENARIOS.KULERA_AUTHOR) {
    const fixed = authorAmountMinor == null ? null : Number(authorAmountMinor);
    const declared = fixed != null && Number.isFinite(fixed) ? fixed : share(grossMinor, Number(authorShareBps) || 0);
    author = Math.max(0, Math.min(Math.round(declared), grossMinor - gateway));
    tech = grossMinor - gateway - author;
  } else {
    // Cenário B: o Emílio não leva royalties — ganha pelo capital (50% do lucro).
    author = 0;
    tech = grossMinor - gateway;
  }

  const emilio = 0;
  const techNet = scenario === SCENARIOS.MARKET ? tech - gateway : tech;
  const golden = goldenRule({ kulera, emilio, tech });

  // Nenhum cêntimo se perde: a soma das partes é sempre o bruto. No cenário C o gateway
  // já está dentro da fatia da plataforma; nos cenários A e B foi descontado antes.
  const total =
    author + publisher + kulera + emilio + tech + (scenario === SCENARIOS.MARKET ? 0 : gateway);
  if (total !== grossMinor) throw new Error('divisão inconsistente: ' + total + ' != ' + grossMinor);

  return {
    scenario,
    gross: grossMinor,
    gateway,
    author,
    publisher,
    kulera,
    emilio,
    tech,
    techNet,
    golden,
  };
}
