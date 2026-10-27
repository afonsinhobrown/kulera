// Divide o HTML do livro em capítulos, no início de cada <h1>.
export function splitChapters(html) {
  const parts = html.split(/(?=<h1[\s>])/i).map((p) => p.trim()).filter(Boolean);
  return parts.map((part, i) => {
    const m = part.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const title = m ? m[1].replace(/<[^>]+>/g, '').trim() : `Parte ${i + 1}`;
    return { title: title || `Parte ${i + 1}`, html: part };
  });
}

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
