/**
 * Testes da situação financeira.
 *
 *     node --test supabase/functions/_shared/financeiro.test.ts
 *
 * O que está em jogo: acusar de inadimplente quem está em dia. A escola age
 * sobre isso — cobra, liga, tranca acesso —, então o erro custa a relação com
 * o aluno, não só um rótulo torto na tela.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  corDaSituacao, resumoCurto, situacaoFinanceira,
} from "./financeiro.ts";

const HOJE = new Date("2026-10-15T09:00:00");

/* ------------------------------------------------------------------ *
 * Os estados que não dependem de data
 * ------------------------------------------------------------------ */

test("pago é pago, com ou sem vencimento", () => {
  assert.equal(situacaoFinanceira({ pagamentoStatus: "pago" }, HOJE).situacao, "pago");
  assert.equal(
    situacaoFinanceira(
      { pagamentoStatus: "pago", pagamentoVencimento: "2026-01-01" }, HOJE).situacao,
    "pago",
    "parcela paga com atraso continua paga",
  );
});

test("quem não tem cobrança por aqui não é inadimplente", () => {
  // São os 503 vindos da planilha: a cobrança deles nunca passou por este
  // sistema. Marcá-los de vencido encheria a tela de alarme falso.
  for (const s of ["nao_aplicavel", null, undefined, ""]) {
    const e = situacaoFinanceira({ pagamentoStatus: s as any }, HOJE);
    assert.equal(e.situacao, "sem_cobranca", `status ${s}`);
    assert.equal(e.pendente, false);
  }
});

test("cancelado e falhou têm estado próprio", () => {
  assert.equal(situacaoFinanceira({ pagamentoStatus: "cancelado" }, HOJE).situacao, "cancelado");
  assert.equal(situacaoFinanceira({ pagamentoStatus: "falhou" }, HOJE).situacao, "falhou");
  assert.equal(situacaoFinanceira({ pagamentoStatus: "falhou" }, HOJE).pendente, true);
});

/* ------------------------------------------------------------------ *
 * O atraso
 * ------------------------------------------------------------------ */

test("venceu ontem é vencido, com um dia", () => {
  const e = situacaoFinanceira(
    { pagamentoStatus: "link_gerado", pagamentoVencimento: "2026-10-14" }, HOJE);
  assert.equal(e.situacao, "vencido");
  assert.equal(e.diasAtraso, 1);
  assert.equal(e.pendente, true);
});

test("vence hoje ainda NÃO é atraso", () => {
  // O aluno tem o dia inteiro para pagar. Cobrar às 9h de quem tem até as
  // 23h59 é o erro mais fácil de cometer aqui.
  const e = situacaoFinanceira(
    { pagamentoStatus: "link_gerado", pagamentoVencimento: "2026-10-15" }, HOJE);
  assert.equal(e.situacao, "a_vencer");
  assert.equal(e.diasAtraso, 0);
  assert.equal(e.diasAteVencer, 0);
  assert.equal(resumoCurto(e), "Vence hoje");
});

test("vence amanhã conta os dias que faltam", () => {
  const e = situacaoFinanceira(
    { pagamentoStatus: "link_gerado", pagamentoVencimento: "2026-10-20" }, HOJE);
  assert.equal(e.situacao, "a_vencer");
  assert.equal(e.diasAteVencer, 5);
  assert.equal(resumoCurto(e), "Vence em 5 dias");
});

test("o atraso é contado em dias de calendário", () => {
  const e = situacaoFinanceira(
    { pagamentoStatus: "link_gerado", pagamentoVencimento: "2026-09-15" }, HOJE);
  assert.equal(e.diasAtraso, 30);
  assert.equal(resumoCurto(e), "Vencida há 30 dias");
});

test("um dia de atraso fala no singular", () => {
  const e = situacaoFinanceira(
    { pagamentoStatus: "link_gerado", pagamentoVencimento: "2026-10-14" }, HOJE);
  assert.equal(resumoCurto(e), "Vencida há 1 dia");
});

test("a virada do horário de verão não inventa um dia", () => {
  // Vencimento e "hoje" em lados opostos de uma virada: a conta é por data
  // de calendário, não por milissegundos.
  const e = situacaoFinanceira(
    { pagamentoStatus: "link_gerado", pagamentoVencimento: "2026-02-20" },
    new Date("2026-02-22T23:30:00"));
  assert.equal(e.diasAtraso, 2);
});

/* ------------------------------------------------------------------ *
 * Sem vencimento conhecido
 * ------------------------------------------------------------------ */

test("aguardando sem vencimento é link que não saiu", () => {
  const e = situacaoFinanceira({ pagamentoStatus: "aguardando" }, HOJE);
  assert.equal(e.situacao, "sem_link");
  assert.equal(e.pendente, true, "alguém precisa gerar o link");
});

test("link gerado sem vencimento não acusa atraso", () => {
  // Leitura incompleta do Sponte não pode virar acusação: o aluno pode estar
  // em dia e o sistema é que não leu a data.
  const e = situacaoFinanceira({ pagamentoStatus: "link_gerado" }, HOJE);
  assert.equal(e.situacao, "a_vencer");
  assert.equal(e.pendente, false);
});

/* ------------------------------------------------------------------ *
 * Cores
 * ------------------------------------------------------------------ */

test("as cores separam o que pede ação do que não pede", () => {
  assert.equal(corDaSituacao("pago"), "verde");
  assert.equal(corDaSituacao("vencido"), "vermelho");
  assert.equal(corDaSituacao("falhou"), "vermelho");
  assert.equal(corDaSituacao("a_vencer"), "ambar");
  assert.equal(corDaSituacao("sem_link"), "ambar");
  // Maioria da base: não é problema, não pode parecer problema.
  assert.equal(corDaSituacao("sem_cobranca"), "neutro");
  assert.equal(corDaSituacao("cancelado"), "neutro");
});

/* ------------------------------------------------------------------ *
 * O rótulo não promete o que não sabe
 * ------------------------------------------------------------------ */

test("o rótulo de pago fala da PRIMEIRA mensalidade", () => {
  // O sistema só acompanha a parcela 1. Dizer "em dia" faria a escola achar
  // que o aluno não deve nada no ano.
  const e = situacaoFinanceira({ pagamentoStatus: "pago" }, HOJE);
  assert.match(e.rotulo, /1ª mensalidade/);
  assert.ok(!/em dia|adimplente/i.test(e.rotulo));
});
