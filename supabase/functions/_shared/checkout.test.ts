/**
 * Testes do checkout.
 *
 *     node --test supabase/functions/_shared/checkout.test.ts
 *
 * O que está em jogo aqui é a data em que o aluno começa a pagar. Errar
 * para frente adia receita; errar para trás manda cobrança vencida para
 * quem acabou de se matricular, e aciona a régua no mesmo dia.
 *
 * `hoje` entra por parâmetro para o teste poder fixá-lo — a resposta muda
 * sozinha com o passar dos dias, que é justamente o motivo de ela não ser
 * guardada em lugar nenhum.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { DIAS_ATE_COBRAR, primeiroVencimentoMensalidade } from "./checkout.ts";

const HOJE = new Date("2026-10-21T09:00:00");

/* ------------------------------------------------------------------ *
 * O caso que motivou a mudança
 * ------------------------------------------------------------------ */

test("turma do ano que vem: a mensalidade espera o curso começar", () => {
  // É o caso real: EVOL Terça 14:00 PR 1/27 começa em 08/02/2027, e
  // estava sendo vendida em outubro de 2026.
  assert.equal(
    primeiroVencimentoMensalidade("2027-02-08", HOJE),
    "2027-02-08",
  );
});

test("turma que já começou cobra como sempre cobrou", () => {
  // Nada de retroativo: a primeira mensalidade vence daqui a 5 dias.
  assert.equal(
    primeiroVencimentoMensalidade("2026-03-01", HOJE),
    "2026-10-26",
  );
});

test("turma sem data de início cobra como sempre cobrou", () => {
  // As de 2027 ainda não têm término preenchido; algumas podem não ter
  // início. Sem o dado, o comportamento antigo é o seguro.
  for (const vazio of [null, undefined, ""]) {
    assert.equal(
      primeiroVencimentoMensalidade(vazio, HOJE),
      "2026-10-26",
      `entrada ${JSON.stringify(vazio)}`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * A borda: nunca no passado
 * ------------------------------------------------------------------ */

test("turma que começa HOJE não gera cobrança para hoje", () => {
  // Vencer no mesmo dia da matrícula não dá tempo de o aluno receber o
  // link, abrir e pagar — nasce atrasada.
  assert.equal(primeiroVencimentoMensalidade("2026-10-21", HOJE), "2026-10-26");
});

test("turma que começa dentro do prazo de cobrança usa o prazo", () => {
  // Começa em 3 dias, mas o piso são 5: vence no piso.
  assert.equal(primeiroVencimentoMensalidade("2026-10-24", HOJE), "2026-10-26");
});

test("turma que começa logo depois do prazo usa a data dela", () => {
  assert.equal(primeiroVencimentoMensalidade("2026-10-27", HOJE), "2026-10-27");
});

test("exatamente no piso, qualquer um dos dois serve — e é o piso", () => {
  assert.equal(primeiroVencimentoMensalidade("2026-10-26", HOJE), "2026-10-26");
});

/* ------------------------------------------------------------------ *
 * O resultado é sempre utilizável
 * ------------------------------------------------------------------ */

test("a data nunca sai no passado, para nenhuma entrada", () => {
  const piso = new Date(HOJE);
  piso.setDate(piso.getDate() + DIAS_ATE_COBRAR);
  const pisoIso = piso.toISOString().slice(0, 10);

  for (const entrada of [null, "", "1900-01-01", "2020-06-15", "2026-10-20"]) {
    const r = primeiroVencimentoMensalidade(entrada, HOJE);
    assert.ok(r >= pisoIso, `${entrada} devolveu ${r}, antes do piso ${pisoIso}`);
  }
});

test("a data sai em ISO, que é o que o plano espera", () => {
  const r = primeiroVencimentoMensalidade("2027-02-08", HOJE);
  assert.match(r, /^\d{4}-\d{2}-\d{2}$/);
});
