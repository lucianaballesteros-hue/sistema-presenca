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
  DIAS_UTEIS_ATE_COBRAR,
  somarDiasUteis,
  inicioDasDemaisMensalidades,
  vencimentoDaAdiantada,
} from "./checkout.ts";
import { planejarCobranca } from "./matricula.ts";

const HOJE = new Date("2026-10-21T09:00:00");

/* ------------------------------------------------------------------ *
 * A parcela que o aluno paga agora
 * ------------------------------------------------------------------ */

test("a parcela de agora vence em 3 dias úteis", () => {
  assert.equal(vencimentoDaAdiantada(HOJE), "2026-10-26");
});

test("o vencimento de agora não depende da turma", () => {
  // É o ponto da regra nova: seja a turma de fevereiro ou a de ontem, o
  // aluno paga a primeira parcela no mesmo prazo.
  assert.equal(vencimentoDaAdiantada(HOJE), "2026-10-26");
  assert.equal(DIAS_UTEIS_ATE_COBRAR, 3);
});

test("a data sai em ISO, que é o que o plano espera", () => {
  assert.match(vencimentoDaAdiantada(HOJE), /^\d{4}-\d{2}-\d{2}$/);
});

/* ------------------------------------------------------------------ *
 * A contagem em dias úteis
 *
 * Contar corrido fazia quem se cadastrava na quinta vencer no domingo,
 * sem banco aberto no meio. Estes casos percorrem a semana inteira.
 * ------------------------------------------------------------------ */

test("a contagem pula sábado e domingo", () => {
  const casos: Array<[string, string]> = [
    ["2026-10-26", "2026-10-29"],   // segunda  → quinta
    ["2026-10-27", "2026-10-30"],   // terça    → sexta
    ["2026-10-28", "2026-11-02"],   // quarta   → segunda
    ["2026-10-29", "2026-11-03"],   // quinta   → terça
    ["2026-10-30", "2026-11-04"],   // sexta    → quarta
  ];
  for (const [de, esperado] of casos) {
    assert.equal(
      vencimentoDaAdiantada(new Date(`${de}T09:00:00`)), esperado,
      `partindo de ${de}`,
    );
  }
});

test("cadastro no fim de semana conta a partir da segunda", () => {
  // Sábado e domingo caem na mesma quarta: os primeiros dias úteis depois
  // deles são segunda, terça e quarta, nos dois casos.
  assert.equal(vencimentoDaAdiantada(new Date("2026-10-31T09:00:00")), "2026-11-04");
  assert.equal(vencimentoDaAdiantada(new Date("2026-11-01T09:00:00")), "2026-11-04");
});

test("o vencimento nunca cai em sábado ou domingo", () => {
  // Um ano inteiro de datas de cadastro.
  const d = new Date("2026-01-01T09:00:00");
  for (let i = 0; i < 365; i++) {
    const venc = new Date(`${vencimentoDaAdiantada(d)}T12:00:00`);
    const semana = venc.getDay();
    assert.ok(
      semana !== 0 && semana !== 6,
      `cadastro em ${d.toISOString().slice(0, 10)} venceria num fim de semana`,
    );
    d.setDate(d.getDate() + 1);
  }
});

test("somarDiasUteis com zero devolve o próprio dia", () => {
  const sexta = new Date("2026-10-30T09:00:00");
  assert.equal(somarDiasUteis(sexta, 0).toISOString().slice(0, 10), "2026-10-30");
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

test("turma que começa no mês seguinte, mas dentro do prazo, não adia", () => {
  // O único caso em que o PISO decide sozinho: mês diferente (a regra do
  // mês do curso não se aplica) e ainda assim perto demais. Numa quinta,
  // 29/10, a cobrança de agora vence na terça 03/11 — uma turma que começa
  // antes disso não justifica partir o plano em dois.
  const quinta = new Date("2026-10-29T09:00:00");
  assert.equal(vencimentoDaAdiantada(quinta), "2026-11-03");

  assert.equal(inicioDasDemaisMensalidades("2026-11-01", quinta), null);
  assert.equal(inicioDasDemaisMensalidades("2026-11-03", quinta), null, "no piso");
  assert.equal(inicioDasDemaisMensalidades("2026-11-04", quinta), "2026-11-04");
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
 * O que é cobrado agora e o que espera o curso
 *
 * Duas cobranças no mesmo contrato só coexistem em tipos de plano
 * diferentes — o Sponte recusa a segunda do mesmo tipo com erro 76,
 * confirmado contra produção em 23/10/2026. Daí o que vence agora ir para
 * a aba de taxa de matrícula e as mensalidades ficarem na sua.
 * ------------------------------------------------------------------ */

const MENSAL = 602.02;

test("turma já iniciada: nada agora, mensalidades seguidas", () => {
  assert.deepEqual(
    planejarCobranca({ parcelas: 12, valorParcela: MENSAL, inicioDasDemais: null }),
    { agora: null, mensalidades: { parcelas: 12, apartirDe: null } },
  );
});

test("turma futura sem taxa: uma parcela agora, as demais com o curso", () => {
  assert.deepEqual(
    planejarCobranca({
      parcelas: 12, valorParcela: MENSAL, inicioDasDemais: "2027-02-08",
    }),
    {
      agora: { valor: MENSAL, parcelas: 1 },
      mensalidades: { parcelas: 11, apartirDe: "2027-02-08" },
    },
  );
});

test("turma futura com taxa: a taxa é a cobrança de agora", () => {
  // Com taxa configurada, nenhuma mensalidade é adiantada: as doze
  // esperam o curso, e quem reserva a vaga é a taxa.
  assert.deepEqual(
    planejarCobranca({
      parcelas: 12, valorParcela: MENSAL, valorTaxa: 300, parcelasTaxa: 1,
      inicioDasDemais: "2027-02-08",
    }),
    {
      agora: { valor: 300, parcelas: 1 },
      mensalidades: { parcelas: 12, apartirDe: "2027-02-08" },
    },
  );
});

test("taxa vale mesmo em turma já iniciada", () => {
  // Taxa é cobrança de matrícula, não de mês: existe havendo ou não o que
  // adiar.
  assert.deepEqual(
    planejarCobranca({
      parcelas: 8, valorParcela: MENSAL, valorTaxa: 300, parcelasTaxa: 1,
      inicioDasDemais: null,
    }),
    {
      agora: { valor: 300, parcelas: 1 },
      mensalidades: { parcelas: 8, apartirDe: null },
    },
  );
});

test("taxa parcelada mantém as suas parcelas", () => {
  const r = planejarCobranca({
    parcelas: 12, valorParcela: MENSAL, valorTaxa: 150, parcelasTaxa: 2,
    inicioDasDemais: "2027-02-08",
  });
  assert.deepEqual(r.agora, { valor: 150, parcelas: 2 });
});

test("parcela única em turma futura não deixa plano de mensalidade vazio", () => {
  // A única parcela já é a de agora. Pedir um plano de zero parcelas seria
  // recusado pelo Sponte.
  const r = planejarCobranca({
    parcelas: 1, valorParcela: MENSAL, inicioDasDemais: "2027-02-08",
  });
  assert.deepEqual(r.agora, { valor: MENSAL, parcelas: 1 });
  assert.equal(r.mensalidades.parcelas, 0);
});

test("o aluno nunca paga mais nem menos do que contratou", () => {
  // Sem taxa, o total tem de fechar: o que sai de mensalidade entra como
  // cobrança de agora. Num ERP sem exclusão, uma parcela a mais é cara.
  for (const n of [1, 2, 3, 6, 8, 12]) {
    for (const inicio of [null, "2027-02-08"]) {
      const r = planejarCobranca({
        parcelas: n, valorParcela: MENSAL, inicioDasDemais: inicio,
      });
      const cobrado = (r.agora?.parcelas ?? 0) + r.mensalidades.parcelas;
      assert.equal(cobrado, n, `${n} parcelas, início ${inicio}`);
    }
  }
});

test("com taxa, as mensalidades ficam todas de pé", () => {
  // A taxa é cobrança a mais, não no lugar de uma mensalidade.
  for (const n of [1, 6, 12]) {
    const r = planejarCobranca({
      parcelas: n, valorParcela: MENSAL, valorTaxa: 300, parcelasTaxa: 1,
      inicioDasDemais: "2027-02-08",
    });
    assert.equal(r.mensalidades.parcelas, n, `${n} parcelas`);
  }
});

test("entrada estranha não produz plano inválido", () => {
  for (const n of [0, NaN, -3]) {
    const r = planejarCobranca({
      parcelas: n as number, valorParcela: MENSAL, inicioDasDemais: "2027-02-08",
    });
    assert.ok((r.agora?.parcelas ?? 0) >= 0);
    assert.ok(r.mensalidades.parcelas >= 0);
  }
});

