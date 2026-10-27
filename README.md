# Kulera+

Plataforma digital para divulgação, venda e leitura de livros e artigos da **Editora Kulera**, outras editoras e escritores independentes.  
Desenvolvimento: **TECNOINCUBADORA**.

---

## 📚 Documentação de Referência
- [**Guia Técnico do Programador**](docs/GUIA_TECNICO.md) — Fonte única de verdade técnica do projeto (*o como*).
- [**Especificação de Requisitos (ERS)**](docs/referencia/Kulera+%20—%20Especificação%20de%20Requisitos%20(ERS).pdf) — Requisitos funcionais e não-funcionais (*o quê*).
- [**Termos de Referência (ToR)**](docs/referencia/Kulera+%20—%20Termos%20de%20Referência%20(ToR).pdf) — Contexto de negócio, objetivos e escopo do promotor.
- [**Registo de Decisões de Arquitetura (ADRs)**](docs/adr/) — Decisões tomadas (PWA, PaySuite, EPUB 3).

---

## 🏛️ Estrutura do Monorepo

```
kulera+/
├── apps/
│   ├── web/        # PWA / Loja, Leitor in-app protegido e Painel Admin
│   ├── api/        # Backend Node.js: pagamentos (PaySuite), acessos (canAccess), split, schema PostgreSQL
│   └── worker/     # Processamento em background: conversão Word/PDF para EPUB 3 (Pandoc + EPUBCheck)
├── packages/
│   └── shared/     # Dicionários de tradução (pt, en), utilitários e tipos partilhados
├── docs/
│   ├── GUIA_TECNICO.md
│   ├── adr/        # Decisões de arquitetura
│   └── referencia/ # PDFs originais dos ToR e ERS
├── .env.example
├── package.json
└── tsconfig.base.json
```

---

## ⚡ Começar Rápido

### Requisitos:
- Node.js >= 20.0.0
- Base de dados PostgreSQL (ex.: Neon)

### Instalação e Testes:
```bash
# 1. Instalar dependências
npm install

# 2. Correr todos os testes
npm test

# 3. Testes específicos
npm run test:web   # Testes do fluxo de compra, pagamento e leitor
npm run test:api   # Testes de domínio, split e pagamentos PaySuite
```

---

## 🔒 Regras de Ouro
1. **Nunca ativar acesso, subscrição ou pedido sem pagamento confirmado pela PaySuite.**
2. **Nunca expor conteúdo pago a quem não tem direito (sem download direto, sempre com marca d'água).**
3. **Nunca perder dinheiro, transações nem dados de clientes (dinheiro sempre em inteiros/centavos, nunca float).**
4. **Idempotência estrita em todos os webhooks e operações financeiras.**
