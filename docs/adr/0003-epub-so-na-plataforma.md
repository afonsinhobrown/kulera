# ADR-0003 — EPUB 3 gerado a partir de Word e PDF; leitura só na plataforma

- **Estado**: Decidido (promotor)

## Decisão
Os livros digitais são produzidos em EPUB 3, validados com EPUBCheck, e servidos apenas ao leitor da plataforma, com verificação de acesso a cada pedido, marca de água e limite de dispositivos. Não há download nem ligação directa ao ficheiro.

## Consequências
Nenhuma protecção impede capturas de ecrã; o objectivo é dificultar e rastrear fugas. A conversão de PDF para EPUB reflowable depende da estrutura do ficheiro (ver RF-CON-06/07).
