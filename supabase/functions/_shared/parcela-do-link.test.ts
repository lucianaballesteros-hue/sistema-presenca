/**
 * Qual cobrança recebe o link de pagamento.
 *
 *     node --test supabase/functions/_shared/parcela-do-link.test.ts
 *
 * Com taxa de matrícula o aluno passa a ter **dois** planos — e cada um
 * tem a sua "parcela 1". A escolha errada manda o aluno pagar a
 * mensalidade de fevereiro em vez da taxa que garante a vaga, e a régua
 * do Sponte cobra a taxa depois como se ele estivesse devendo.
 *
 * Antes a ordenação era só por `NumeroParcela`: com duas "parcela 1", o
 * desempate ficava por conta da ordem em que o Sponte devolve o XML.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { escolherParcelaDoLink } from "./matricula.ts";

/** Monta um bloco de parcela como o `GetParcelas` devolve. */
function parcela(p: {
  conta: number;
  numero?: number;
  vencimento?: string;
  categoria?: string;
  pagaEm?: string;
}) {
  return `<wsParcela>
<ContaReceberID>${p.conta}</ContaReceberID>
<NumeroParcela>${p.numero ?? 1}</NumeroParcela>
<Vencimento>${p.vencimento ?? "26/10/2026"}</Vencimento>
<Categoria>${p.categoria ?? "Mensalidade"}</Categoria>
<DataPagamento>${p.pagaEm ?? ""}</DataPagamento>
<ValorParcela>100,00</ValorParcela>
</wsParcela>`;
}

const xml = (...ps: string[]) => `<GetParcelasResponse>${ps.join("")}</GetParcelasResponse>`;

/* ------------------------------------------------------------------ *
 * O caso que motivou a mudança
 * ------------------------------------------------------------------ */

test("com taxa e mensalidade, o link vai para a que vence primeiro", () => {
  // A taxa vence em 5 dias; a mensalidade, quando o curso começa.
  const r = escolherParcelaDoLink(xml(
    parcela({ conta: 1794, numero: 1, vencimento: "08/02/2027", categoria: "Mensalidade" }),
    parcela({ conta: 1800, numero: 1, vencimento: "26/10/2026", categoria: "Taxa de matricula" }),
  ));
  assert.equal(r?.contaReceberId, 1800, "deveria escolher a taxa");
});

test("a ordem do XML não decide", () => {
  // O mesmo caso, com os blocos invertidos. Era aqui que a escolha
  // antiga mudava de resposta.
  const r = escolherParcelaDoLink(xml(
    parcela({ conta: 1800, numero: 1, vencimento: "26/10/2026", categoria: "Taxa de matricula" }),
    parcela({ conta: 1794, numero: 1, vencimento: "08/02/2027", categoria: "Mensalidade" }),
  ));
  assert.equal(r?.contaReceberId, 1800);
});

test("vencendo no mesmo dia, a taxa ganha", () => {
  // Turma que começa dentro do prazo de cobrança: as duas caem no piso.
  // A taxa é o que garante a vaga, então é ela que o aluno paga.
  const r = escolherParcelaDoLink(xml(
    parcela({ conta: 1794, numero: 1, vencimento: "26/10/2026", categoria: "Mensalidade" }),
    parcela({ conta: 1800, numero: 1, vencimento: "26/10/2026", categoria: "Taxa de matricula" }),
  ));
  assert.equal(r?.contaReceberId, 1800);
});

test("com a mensalidade adiantada, o link vai para ela", () => {
  // Turma futura e plano sem taxa: a primeira mensalidade vence em 5 dias
  // e as demais só começam quando o curso começa. São dois planos de
  // mensalidade, e o link tem de ir para o que vence agora.
  const r = escolherParcelaDoLink(xml(
    parcela({ conta: 1810, numero: 1, vencimento: "08/02/2027", categoria: "Mensalidade" }),
    parcela({ conta: 1811, numero: 2, vencimento: "08/03/2027", categoria: "Mensalidade" }),
    parcela({ conta: 1809, numero: 1, vencimento: "27/10/2026", categoria: "Mensalidade" }),
  ));
  assert.equal(r?.contaReceberId, 1809, "deveria escolher a adiantada");
});

/* ------------------------------------------------------------------ *
 * Sem taxa — o comportamento de sempre
 * ------------------------------------------------------------------ */

test("sem taxa, escolhe a primeira mensalidade", () => {
  const r = escolherParcelaDoLink(xml(
    parcela({ conta: 1794, numero: 3, vencimento: "26/12/2026" }),
    parcela({ conta: 1794, numero: 1, vencimento: "26/10/2026" }),
    parcela({ conta: 1794, numero: 2, vencimento: "26/11/2026" }),
  ));
  assert.equal(r?.numeroParcela, "1");
});

test("parcela já paga não recebe link", () => {
  const r = escolherParcelaDoLink(xml(
    parcela({ conta: 1794, numero: 1, vencimento: "26/10/2026", pagaEm: "20/10/2026" }),
    parcela({ conta: 1794, numero: 2, vencimento: "26/11/2026" }),
  ));
  assert.equal(r?.numeroParcela, "2", "a paga foi pulada");
});

test("conta zerada é ignorada", () => {
  // O Sponte devolve um bloco com ContaReceberID 0 quando não há nada.
  const r = escolherParcelaDoLink(xml(
    parcela({ conta: 0, numero: 1 }),
    parcela({ conta: 1794, numero: 1, vencimento: "26/11/2026" }),
  ));
  assert.equal(r?.contaReceberId, 1794);
});

/* ------------------------------------------------------------------ *
 * Resposta imprestável não derruba a matrícula
 * ------------------------------------------------------------------ */

test("XML vazio devolve null em vez de lançar", () => {
  // O GetParcelas mostrou-se instável em 21/10/2026: chamadas sucessivas
  // para o mesmo aluno ora traziam os dados, ora blocos vazios. Perder a
  // matrícula já feita por causa disso seria pior que ficar sem o link,
  // que a régua do Sponte gera depois.
  assert.equal(escolherParcelaDoLink(""), null);
  assert.equal(escolherParcelaDoLink("<GetParcelasResponse></GetParcelasResponse>"), null);
});

test("blocos sem conteúdo devolvem null", () => {
  // Foi exatamente o que a API devolveu durante a investigação.
  assert.equal(
    escolherParcelaDoLink("<wsParcela></wsParcela><wsParcela></wsParcela>"),
    null,
  );
});

test("tudo pago devolve null", () => {
  const r = escolherParcelaDoLink(xml(
    parcela({ conta: 1794, numero: 1, pagaEm: "20/10/2026" }),
  ));
  assert.equal(r, null);
});

/* ------------------------------------------------------------------ *
 * Vencimento ausente ou estranho
 * ------------------------------------------------------------------ */

test("parcela sem vencimento vai para o fim da fila", () => {
  const r = escolherParcelaDoLink(xml(
    parcela({ conta: 1800, numero: 1, vencimento: "" }),
    parcela({ conta: 1794, numero: 9, vencimento: "26/11/2026" }),
  ));
  assert.equal(r?.contaReceberId, 1794, "data conhecida vem antes");
});

test("a data é lida como dia/mês/ano, não como texto", () => {
  // "02/11/2026" vem antes de "10/10/2026"? Não: novembro é depois.
  // Comparar as strings cruas daria a resposta errada.
  const r = escolherParcelaDoLink(xml(
    parcela({ conta: 1, numero: 1, vencimento: "02/11/2026" }),
    parcela({ conta: 2, numero: 1, vencimento: "10/10/2026" }),
  ));
  assert.equal(r?.contaReceberId, 2, "outubro vem antes de novembro");
});

test("o ano pesa mais que o dia", () => {
  const r = escolherParcelaDoLink(xml(
    parcela({ conta: 1, numero: 1, vencimento: "28/12/2026" }),
    parcela({ conta: 2, numero: 1, vencimento: "01/01/2027" }),
  ));
  assert.equal(r?.contaReceberId, 1);
});

/* ------------------------------------------------------------------ *
 * Os campos chegam inteiros
 * ------------------------------------------------------------------ */

test("a leitura dos campos não quebra com a classe de caractere", () => {
  // `[\\s\\S]` dentro de template literal: com uma barra só, a classe
  // vira `[sS]` e passa a casar apenas essas duas letras.
  const r = escolherParcelaDoLink(xml(
    parcela({ conta: 1794, numero: 7, vencimento: "26/11/2026" }),
  ));
  assert.equal(r?.contaReceberId, 1794);
  assert.equal(r?.numeroParcela, "7");
});
