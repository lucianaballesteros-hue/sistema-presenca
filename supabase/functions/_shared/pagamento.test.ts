/**
 * Testes de formas de cobrança e parcelamento.
 *
 *     node --test supabase/functions/_shared/pagamento.test.ts
 *
 * A amostra de XML é cópia literal do retorno real da escola (05/10/2026) —
 * incluindo o aninhamento de nome repetido que já causou um diagnóstico errado.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  classificarMeio,
  descreverParcelamento,
  dividirParcelas,
  formasOferecidas,
  type MeioPagamento,
  parcelamentoValido,
  parcelasPermitidas,
  parsearFormasCobranca,
  rotuloMeio,
} from "./pagamento.ts";

/**
 * Retorno real, abreviado. A estrutura é a armadilha: o nó-pai e o nó-item têm
 * o mesmo nome (`FormasCobrancas`), e nenhum deles se chama `wsFormaCobranca`.
 */
const XML_REAL = `<wsFormasCobrancas>
<RetornoOperacao>01 - Operação Realizada com Sucesso.</RetornoOperacao>
<FormasCobrancas>
  <FormasCobrancas><FormaCobrancaID>-31</FormaCobrancaID><Descricao>Recorrência Sponte Pay 2.0</Descricao></FormasCobrancas>
  <FormasCobrancas><FormaCobrancaID>-30</FormaCobrancaID><Descricao>Cartão Sponte Pay 2.0</Descricao></FormasCobrancas>
  <FormasCobrancas><FormaCobrancaID>-29</FormaCobrancaID><Descricao>Pix Sponte Pay 2.0</Descricao></FormasCobrancas>
  <FormasCobrancas><FormaCobrancaID>-28</FormaCobrancaID><Descricao>Boleto Sponte Pay 2.0</Descricao></FormasCobrancas>
  <FormasCobrancas><FormaCobrancaID>-27</FormaCobrancaID><Descricao>Link de Pagamento Sponte Pay 2.0</Descricao></FormasCobrancas>
  <FormasCobrancas><FormaCobrancaID>-26</FormaCobrancaID><Descricao>Crédito Sponte Pay</Descricao></FormasCobrancas>
  <FormasCobrancas><FormaCobrancaID>-20</FormaCobrancaID><Descricao>Pix Sponte Pay</Descricao></FormasCobrancas>
  <FormasCobrancas><FormaCobrancaID>-19</FormaCobrancaID><Descricao>Boleto Sponte Pay</Descricao></FormasCobrancas>
  <FormasCobrancas><FormaCobrancaID>-18</FormaCobrancaID><Descricao>Recorrência Sponte Pay</Descricao></FormasCobrancas>
  <FormasCobrancas><FormaCobrancaID>-5</FormaCobrancaID><Descricao>Cartão de Crédito</Descricao></FormasCobrancas>
  <FormasCobrancas><FormaCobrancaID>-1</FormaCobrancaID><Descricao>Dinheiro</Descricao></FormasCobrancas>
  <FormasCobrancas><FormaCobrancaID>1</FormaCobrancaID><Descricao>Boleto</Descricao></FormasCobrancas>
</FormasCobrancas>
</wsFormasCobrancas>`;

/* ------------------------------------------------------------------ *
 * Parse
 * ------------------------------------------------------------------ */

test("parsearFormasCobranca lê a estrutura aninhada real", () => {
  // O engano anterior foi procurar <wsFormaCobranca>, que não existe — e
  // concluir que a escola não tinha forma nenhuma cadastrada.
  const f = parsearFormasCobranca(XML_REAL);
  assert.equal(f.length, 12);
});

test("parsearFormasCobranca preserva ids negativos", () => {
  const f = parsearFormasCobranca(XML_REAL);
  const pix = f.find((x) => x.descricao === "Pix Sponte Pay 2.0");
  assert.equal(pix?.formaCobrancaId, -29);
});

test("parsearFormasCobranca marca as formas Sponte Pay 2.0", () => {
  const f = parsearFormasCobranca(XML_REAL);
  assert.equal(f.find((x) => x.formaCobrancaId === -29)?.spontePay2, true);
  assert.equal(f.find((x) => x.formaCobrancaId === -20)?.spontePay2, false);
  assert.equal(f.find((x) => x.formaCobrancaId === 1)?.spontePay2, false);
});

test("parsearFormasCobranca devolve lista vazia sem formas", () => {
  assert.deepEqual(parsearFormasCobranca("<wsFormasCobrancas />"), []);
});

/* ------------------------------------------------------------------ *
 * Classificação
 * ------------------------------------------------------------------ */

test("classificarMeio reconhece pix e cartão", () => {
  assert.equal(classificarMeio("Pix Sponte Pay 2.0"), "pix");
  assert.equal(classificarMeio("Cartão Sponte Pay 2.0"), "cartao");
  assert.equal(classificarMeio("Crédito Sponte Pay"), "cartao");
  assert.equal(classificarMeio("Cartão de Crédito"), "cartao");
});

test("classificarMeio separa recorrência de cartão comum", () => {
  // "Recorrência" também é cartão; a ordem dos testes é o que impede que ela
  // seja classificada como cartão parcelável.
  assert.equal(classificarMeio("Recorrência Sponte Pay 2.0"), "cartao_recorrente");
  assert.equal(classificarMeio("Crédito Recorrente"), "cartao_recorrente");
});

test("classificarMeio reconhece boleto", () => {
  // O formulário de matrícula atual da escola usa boleto — ver análise dos
  // vídeos do time interno (06/10/2026).
  assert.equal(classificarMeio("Boleto Sponte Pay 2.0"), "boleto");
  assert.equal(classificarMeio("Boleto"), "boleto");
  assert.equal(classificarMeio("Boleto Automatizado"), "boleto");
});

test("classificarMeio devolve null fora do escopo", () => {
  for (const d of ["Dinheiro", "Cheque", "Fatura Educbank", "PayPal", "Débito Automático"]) {
    assert.equal(classificarMeio(d), null, `${d} não deveria ser aceito`);
  }
});

test("classificarMeio tolera texto sem acento", () => {
  assert.equal(classificarMeio("Cartao Sponte Pay"), "cartao");
  assert.equal(classificarMeio("Recorrencia Sponte Pay"), "cartao_recorrente");
});

/* ------------------------------------------------------------------ *
 * Formas oferecidas
 * ------------------------------------------------------------------ */

test("formasOferecidas devolve pix, cartão e boleto", () => {
  const f = formasOferecidas(parsearFormasCobranca(XML_REAL));
  assert.deepEqual(f.map((x) => x.meio), ["pix", "cartao", "boleto", "cartao_recorrente"]);
});

test("formasOferecidas exclui dinheiro, cheque e os demais", () => {
  const f = formasOferecidas(parsearFormasCobranca(XML_REAL));
  assert.equal(f.some((x) => /dinheiro|cheque|paypal|educbank/i.test(x.descricao)), false);
});

test("formasOferecidas escolhe o boleto Sponte Pay, não o 2.0 nem o manual", () => {
  // A base tem Boleto Sponte Pay 2.0 (-28), Boleto Sponte Pay (-19) e Boleto (1).
  // Fica o -19: o boleto manual não gera link, e o 2.0 não aparece na tela de
  // Geração de Link desta escola.
  const f = formasOferecidas(parsearFormasCobranca(XML_REAL));
  assert.equal(f.find((x) => x.meio === "boleto")?.formaCobrancaId, -19);
});

test("formasOferecidas prefere a geração antiga quando há duas", () => {
  // Medido em produção: parcela em Pix Sponte Pay 2.0 (-29) não aparece na
  // tela de Geração de Link, e sem aparecer lá não há como gerar o link —
  // nem pela automação, nem à mão.
  const f = formasOferecidas(parsearFormasCobranca(XML_REAL));
  assert.equal(f.find((x) => x.meio === "pix")?.formaCobrancaId, -20);
  assert.equal(f.find((x) => x.meio === "cartao")?.formaCobrancaId, -26);
});

test("formasOferecidas coloca Pix primeiro", () => {
  const f = formasOferecidas(parsearFormasCobranca(XML_REAL));
  assert.equal(f[0].meio, "pix");
});

/* ------------------------------------------------------------------ *
 * Parcelamento
 * ------------------------------------------------------------------ */

test("Pix não parcela", () => {
  assert.deepEqual(parcelasPermitidas("pix"), [1]);
  assert.equal(parcelamentoValido("pix", 3), false);
  assert.equal(parcelamentoValido("pix", 1), true);
});

test("boleto não parcela — quem parcela é o plano", () => {
  // Parcelar boleto seria emitir N boletos por mensalidade, e o plano de
  // mensalidades já faz isso. Dividir de novo duplicaria a cobrança.
  assert.deepEqual(parcelasPermitidas("boleto"), [1]);
  assert.equal(parcelamentoValido("boleto", 6), false);
});

test("cartão parcela até 12×", () => {
  assert.equal(parcelasPermitidas("cartao").length, 12);
  assert.equal(parcelamentoValido("cartao", 12), true);
  assert.equal(parcelamentoValido("cartao", 13), false);
  assert.equal(parcelamentoValido("cartao", 0), false);
});

test("recorrência não parcela por cima do ciclo", () => {
  assert.deepEqual(parcelasPermitidas("cartao_recorrente"), [1]);
});

/* ------------------------------------------------------------------ *
 * Divisão de valores
 * ------------------------------------------------------------------ */

test("dividirParcelas não perde centavos", () => {
  // Três de 33,33 somariam 99,99 — a última parcela absorve a diferença.
  const p = dividirParcelas(100, 3);
  assert.deepEqual(p, [33.33, 33.33, 33.34]);
  assert.equal(p.reduce((a, b) => a + b, 0), 100);
});

test("dividirParcelas fecha a soma em valores reais de plano", () => {
  for (const total of [1290, 3825.36, 3841.18, 4609.44, 7224.24, 1161]) {
    for (const n of [1, 2, 3, 6, 10, 12]) {
      const soma = dividirParcelas(total, n).reduce((a, b) => a + b, 0);
      assert.equal(Math.round(soma * 100), Math.round(total * 100),
        `${total} em ${n}× não fechou`);
    }
  }
});

test("dividirParcelas em 1× devolve o total", () => {
  assert.deepEqual(dividirParcelas(637.56, 1), [637.56]);
});

test("dividirParcelas recusa quantidade inválida", () => {
  assert.throws(() => dividirParcelas(100, 0), RangeError);
});

/* ------------------------------------------------------------------ *
 * Exibição
 * ------------------------------------------------------------------ */

test("rotuloMeio traduz para o vocabulário do aluno", () => {
  assert.equal(rotuloMeio("pix"), "Pix");
  assert.equal(rotuloMeio("cartao"), "Cartão de crédito");
});

test("descreverParcelamento descreve boleto", () => {
  const t = descreverParcelamento("boleto", 1, 564.30).replace(/ /g, " ");
  assert.equal(t, "R$ 564,30 por boleto");
});

test("descreverParcelamento descreve pix como à vista", () => {
  const t = descreverParcelamento("pix", 1, 637.56).replace(/ /g, " ");
  assert.equal(t, "R$ 637,56 à vista no Pix");
});

test("descreverParcelamento divide o valor no cartão", () => {
  const t = descreverParcelamento("cartao", 3, 300).replace(/ /g, " ");
  assert.equal(t, "3× de R$ 100,00 no cartão");
});

test("descreverParcelamento trata 1× no cartão sem dizer '1× de'", () => {
  const t = descreverParcelamento("cartao", 1, 637.56).replace(/ /g, " ");
  assert.equal(t, "R$ 637,56 em 1× no cartão");
});

/* ------------------------------------------------------------------ *
 * A distinção que mais custa se for confundida
 * ------------------------------------------------------------------ */

test("parcela do plano e parcela do cartão são coisas diferentes", () => {
  // Plano de 6 mensalidades de R$ 637,56 pago em 3× no cartão:
  // são 6 TÍTULOS no Sponte, cada um dividido em 3 pela operadora.
  // Não são 3 cobranças no total.
  const mensalidade = 637.56;
  const mensalidadesDoPlano = 6;
  const parcelasDoCartao = 3;

  const porTitulo = dividirParcelas(mensalidade, parcelasDoCartao);
  assert.equal(porTitulo.length, 3);
  assert.equal(Math.round(porTitulo.reduce((a, b) => a + b, 0) * 100), 63756);

  const totalDoContrato = mensalidade * mensalidadesDoPlano;
  assert.equal(Math.round(totalDoContrato * 100), 382536);
});
