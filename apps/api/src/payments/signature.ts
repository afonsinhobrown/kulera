import { createHmac, timingSafeEqual } from 'node:crypto';

// A PaySuite assina o corpo bruto com HMAC-SHA256 no cabeçalho X-Signature.
// CONFIRMAR na documentação oficial (https://paysuite.tech/docs): codificação (hex/base64) e prefixo.
// Aceitamos hex e base64, com ou sem o prefixo «sha256=».
// Validar SEMPRE antes de fazer parse do JSON, e sobre o corpo bruto exacto.
export function verifySignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined | null,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;

  const provided = signatureHeader.trim().replace(/^sha256=/i, '');
  const digest = createHmac('sha256', secret).update(rawBody).digest();

  return (
    safeEqual(provided.toLowerCase(), digest.toString('hex')) ||
    safeEqual(provided, digest.toString('base64'))
  );
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
