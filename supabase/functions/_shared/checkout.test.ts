/**
 * Testes do checkout.
 *
 *     node --test supabase/functions/_shared/checkout.test.ts
 *
 * O que está em jogo aqui é quando o aluno paga. Errar para frente adia
 * receita; errar para trás manda cobrança vencida para quem acabou de se
 * matricular, e aciona a régua no mesmo dia.
 *
 * A regra, decidida em 22/10/2026: a **primeira** mensalidade é adiantada
 * para agora, porque é ela que reserva a vaga, e as **demais** começam
 * quando o curso começa. Antes disso, todas as mensalidades eram empurradas
 * para o início da turma — o que deixava a escola sem nada a receber na
 * venda de uma turma do ano seguinte.
 *
 * `hoje` entra por parâmetro para o teste poder fixá-lo — a resposta muda
 * sozinha com o passar dos dias, que é justamente o motivo de ela não ser
 * guardada em lugar nenhum.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DIAS_ATE_COBRAR,
  inicioDasDemaisMensalidades,
  vencimentoDaAdiantada,
} from "./checkout.ts";
import { dividirMensalidades } from "./matricula.ts";

const HOJE = new Date("2026-10-21T09:00:00");

/* ------------------------------------------------------------------ *
 * A parcela que o aluno paga agora
 * ------------------------------------------------------------------ */

test("a parcela de agora vence em 5 dias", () => {
  assert.equal(vencimentoDaAdiantada(HOJE), "2026-10-26");
});

test("o vencimento de agora não depende da turma", () => {
  // É o ponto da regra nova: seja a turma de fevereiro ou a de ontem, o
  // aluno paga a primeira parcela no mesmo prazo.
  assert.equal(vencimentoDaAdiantada(HOJE), "2026-10-26");
  assert.equal(DIAS_ATE_COBRAR, 5);
});

test("a data sai em ISO, que é o que o plano espera", () => {
  assert.match(vencimentoDaAdiantada(HOJE), /^\d{4}-\d{2}-\d{2}$/);
});

/* ------------------------------------------------------------------ *
 * Quando as demais começam
 * ------------------------------------------------------------------ */

test("turma do ano que vem: as demais esperam o curso começar", () => {
  // É o caso real: EVOL Terça 14:00 PR 1/27 começa em 08/02/2027, e
  // estava sendo vendida em outubro de 2026.
  assert.equal(inicioDasDemaisMensalidades("2027-02-08", HOJE), "2027-02-08");
});

test("turma que já começou não tem nada a adiar", () => {
  assert.equal(inicioDasDemaisMensalidades("2026-03-01", HOJE), null);
});

test("turma sem data de início não tem nada a adiar", () => {
  // As de 2027 ainda não têm término preenchido; algumas podem não ter
  // início. Sem o dado, o comportamento antigo é o seguro.
  for (const vazio of [null, undefined, ""]) {
    assert.equal(
      inicioDasDemaisMensalidades(vazio, HOJE),
      null,
      `entrada ${JSON.stringify(vazio)}`,
    );
  }
});

test("turma que começa HOJE não adia nada", () => {
  assert.equal(inicioDasDemaisMensalidades("2026-10-21", HOJE), null);
});

test("turma que começa dentro do prazo de cobrança não adia nada", () => {
  // Começa em 3 dias, mas a parcela de agora vence em 5: as duas datas
  // cairiam praticamente juntas, e dois planos para isso só poluiriam o
  // contrato.
  assert.equal(inicioDasDemaisMensalidades("2026-10-24", HOJE), null);
});

test("exatamente no dia do vencimento de agora, não adia", () => {
  assert.equal(inicioDasDemaisMensalidades("2026-10-26", HOJE), null);
});

test("um dia depois do vencimento, mas no mesmo mês, não adia", () => {
  // A regra do mês do curso é mais forte que o piso de 5 dias: turma que
  // começa em 27/10 para quem se cadastra em 21/10 cobra tudo seguido.
  assert.equal(inicioDasDemaisMensalidades("2026-10-27", HOJE), null);
});

test("no mês seguinte, adia", () => {
  assert.equal(inicioDasDemaisMensalidades("2026-11-03", HOJE), "2026-11-03");
});

test("fim do mês corrente não adia, por longe que esteja", () => {
  // 21/10 para 31/10: dez dias, e ainda assim mesmo mês. É a regra pedida
  // em 22/10/2026 — dentro do próprio mês, partir o plano em dois não paga
  // o custo de um segundo plano no contrato.
  assert.equal(inicioDasDemaisMensalidades("2026-10-31", HOJE), null);
});

test("a data das demais nunca sai no passado", () => {
  const piso = vencimentoDaAdiantada(HOJE);
  for (const entrada of [null, "", "1900-01-01", "2020-06-15", "2026-10-20"]) {
    const r = inicioDasDemaisMensalidades(entrada, HOJE);
    assert.ok(r === null || r > piso, `${entrada} devolveu ${r}`);
  }
});

/* ------------------------------------------------------------------ *
 * A escolha de quem gerou o link
 * ------------------------------------------------------------------ */

test("sequencial não adia nada, mesmo em turma de 2027", () => {
  assert.equal(
    inicioDasDemaisMensalidades("2027-02-08", HOJE, "sequencial"),
    null,
  );
});

test("adiantada adia, como o default", () => {
  assert.equal(
    inicioDasDemaisMensalidades("2027-02-08", HOJE, "adiantada"),
    "2027-02-08",
  );
});

test("sem escolha, decide a turma", () => {
  for (const vazio of [null, undefined]) {
    assert.equal(
      inicioDasDemaisMensalidades("2027-02-08", HOJE, vazio),
      "2027-02-08",
      `modo ${JSON.stringify(vazio)}`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * Chegado o mês do curso, o link passa a cobrar seguido
 *
 * Um link gerado em outubro para uma turma de fevereiro continua válido em
 * fevereiro. Lá, adiantar não quer mais dizer nada: o curso é agora.
 * ------------------------------------------------------------------ */

test("no mês em que o curso começa, vira sequencial sozinho", () => {
  // Link criado em outubro pedindo "adiantada"; o aluno se cadastra em
  // fevereiro, no mês do início.
  const fevereiro = new Date("2027-02-01T09:00:00");
  assert.equal(
    inicioDasDemaisMensalidades("2027-02-08", fevereiro, "adiantada"),
    null,
  );
});

test("vira sequencial mesmo com o curso ainda longe dentro do mês", () => {
  // 1º de fevereiro, curso em 28: quatro semanas de diferença, e ainda
  // assim é o mesmo mês. Foi a regra pedida — partir o plano em dois para
  // ganhar semanas dentro do próprio mês não paga o custo.
  const fevereiro = new Date("2027-02-01T09:00:00");
  assert.equal(
    inicioDasDemaisMensalidades("2027-02-28", fevereiro, "adiantada"),
    null,
  );
});

test("no mês anterior ao do curso, ainda adia", () => {
  const janeiro = new Date("2027-01-20T09:00:00");
  assert.equal(
    inicioDasDemaisMensalidades("2027-02-08", janeiro, "adiantada"),
    "2027-02-08",
  );
});

test("mesmo mês de outro ano não conta como o mês do curso", () => {
  // Fevereiro de 2026 e fevereiro de 2027 são meses iguais em anos
  // diferentes: comparar só o mês faria o link parar de adiantar um ano
  // antes da hora.
  const fev2026 = new Date("2026-02-10T09:00:00");
  assert.equal(
    inicioDasDemaisMensalidades("2027-02-08", fev2026, "adiantada"),
    "2027-02-08",
  );
});

/* ------------------------------------------------------------------ *
 * Como as parcelas se dividem entre os dois planos
 * ------------------------------------------------------------------ */

test("turma futura: uma parcela agora, as demais com o curso", () => {
  assert.deepEqual(
    dividirMensalidades(12, "2027-02-08"),
    { agora: 1, depois: 11 },
  );
});

test("turma já iniciada: um plano só, com tudo", () => {
  assert.deepEqual(dividirMensalidades(12, null), { agora: 12, depois: 0 });
});

test("plano de parcela única não se divide", () => {
  // Não há o que adiar: a única parcela já é a de agora. Criar um segundo
  // plano vazio daria erro no Sponte.
  assert.deepEqual(dividirMensalidades(1, "2027-02-08"), { agora: 1, depois: 0 });
});

test("duas parcelas: uma agora, uma com o curso", () => {
  assert.deepEqual(dividirMensalidades(2, "2027-02-08"), { agora: 1, depois: 1 });
});

test("turma futura com taxa: nada adiantado, tudo com o curso", () => {
  // Quem reserva a vaga é a taxa. Adiantar uma mensalidade junto daria ao
  // aluno duas cobranças vencendo no mesmo dia, e o link de pagamento vai
  // para uma só delas — a outra ficaria para a régua do Sponte cobrar.
  assert.deepEqual(
    dividirMensalidades(12, "2027-02-08", true),
    { agora: 0, depois: 12 },
  );
});

test("com taxa, turma já iniciada segue num plano só", () => {
  assert.deepEqual(dividirMensalidades(12, null, true), { agora: 12, depois: 0 });
});

test("com taxa e parcela única, a mensalidade vai para o início do curso", () => {
  assert.deepEqual(dividirMensalidades(1, "2027-02-08", true), { agora: 0, depois: 1 });
});

test("a soma dos dois planos é sempre o plano do curso", () => {
  // O aluno não pode acabar com mais nem menos mensalidades do que
  // contratou — e num ERP sem exclusão, a mais é o caro de consertar.
  for (const n of [1, 2, 3, 6, 7, 8, 10, 12]) {
    for (const inicio of [null, "2027-02-08"]) {
      for (const taxa of [false, true]) {
        const d = dividirMensalidades(n, inicio, taxa);
        assert.equal(
          d.agora + d.depois, n,
          `${n} parcelas, início ${inicio}, taxa ${taxa}`,
        );
      }
    }
  }
});

test("nenhum plano nasce com zero parcelas", () => {
  for (const n of [0, 1, NaN, -3]) {
    const d = dividirMensalidades(n as number, "2027-02-08");
    assert.ok(d.agora >= 1, `${n} deu agora=${d.agora}`);
    assert.ok(d.depois >= 0, `${n} deu depois=${d.depois}`);
  }
});
