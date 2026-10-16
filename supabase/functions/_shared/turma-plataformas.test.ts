/**
 * Testes do espelho da turma nas outras plataformas.
 *
 *     node --test supabase/functions/_shared/turma-plataformas.test.ts
 *
 * Os clientes são dublês: o que está em jogo aqui é a **decisão** — criar,
 * vincular ou parar —, não a ida à rede. A ida à rede foi conferida contra
 * as plataformas de verdade, com turma de teste criada e apagada.
 *
 * O caso que mais importa é a ambiguidade. Vincular à turma errada mistura a
 * chamada e o conteúdo de duas turmas, e o estrago só aparece semanas
 * depois, quando alguém repara que o aluno está na lista errada.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  definirSituacaoTurma, propagarTurma, totalDeAulas,
} from "./turma-plataformas.ts";

/* ------------------------------------------------------------------ *
 * Dublês
 * ------------------------------------------------------------------ */

function fingirPresenca(respostas: {
  achar?: { turma: any; candidatos: string[] };
  criar?: any;
  falharAoCriar?: string;
}) {
  const feito: string[] = [];
  return {
    feito,
    cliente: {
      async acharTurma() {
        feito.push("acharTurma");
        return respostas.achar ?? { turma: null, candidatos: [] };
      },
      async criarTurma(t: any) {
        feito.push(`criarTurma(${t.nome})`);
        if (respostas.falharAoCriar) throw new Error(respostas.falharAoCriar);
        return respostas.criar ?? { id: 10, turma: t.nome, curso: t.curso, ativa: false };
      },
      async atualizarTurma(id: number, t: any) {
        feito.push(`atualizarTurma(${id},${JSON.stringify(t)})`);
      },
      async buscarTurma(id: number) {
        feito.push(`buscarTurma(${id})`);
        return { id, turma: "x", curso: "y", ativa: true };
      },
    } as any,
  };
}

function fingirLeague(respostas: {
  achar?: { classId: string | null; nome: string | null; candidatos: string[] };
  liga?: { id: string; nome: string; turmasVistas: number } | null;
  criar?: string;
}) {
  const feito: string[] = [];
  return {
    feito,
    cliente: {
      async acharTurmaPorNome() {
        feito.push("acharTurmaPorNome");
        return respostas.achar ?? { classId: null, nome: null, candidatos: [] };
      },
      async ligaDoPrograma(p: string) {
        feito.push(`ligaDoPrograma(${p})`);
        return respostas.liga === undefined
          ? { id: "liga-1", nome: "Liga", turmasVistas: 3 }
          : respostas.liga;
      },
      async criarTurma(t: any) {
        feito.push(`criarTurma(${t.nome},liga=${t.ligaId},ativa=${t.ativa})`);
        return respostas.criar ?? "classe-1";
      },
      async atualizarTurma(id: string, t: any) {
        feito.push(`atualizarTurma(${id},${JSON.stringify(t)})`);
      },
      async ligaDaTurma() {
        return "liga-1";
      },
    } as any,
  };
}

const TURMA = {
  turmaId: 1,
  nome: "ELAS Quarta 14:00 PR 2/26",
  curso: "Finanças para Elas",
  cursoId: 7,
  dataInicio: "2026-08-17",
  dataTermino: "2026-12-31",
  professorRegente: "Ana",
};
const VAZIO = { presencaTurmaId: null, leagueClassId: null };

/* ------------------------------------------------------------------ *
 * Vincular antes de criar
 * ------------------------------------------------------------------ */

test("acha pelo nome e vincula, sem criar nada", async () => {
  const p = fingirPresenca({
    achar: { turma: { id: 42, turma: TURMA.nome, curso: "", ativa: true }, candidatos: [] },
  });
  const l = fingirLeague({
    achar: { classId: "uuid-9", nome: TURMA.nome, candidatos: [] },
  });

  const r = await propagarTurma(TURMA, VAZIO, { presenca: p.cliente, league: l.cliente });

  assert.equal(r.mapa.presencaTurmaId, 42);
  assert.equal(r.mapa.leagueClassId, "uuid-9");
  assert.ok(r.resultados.every((x) => x.acao === "vinculada"));
  assert.ok(!p.feito.some((f) => f.startsWith("criarTurma")), "não devia criar no Presença");
  assert.ok(!l.feito.some((f) => f.startsWith("criarTurma")), "não devia criar no League");
});

test("id já gravado não provoca nem busca", async () => {
  const p = fingirPresenca({});
  const l = fingirLeague({});

  const r = await propagarTurma(
    TURMA, { presencaTurmaId: 42, leagueClassId: "uuid-9" },
    { presenca: p.cliente, league: l.cliente });

  assert.deepEqual(p.feito, [], "o vínculo é definitivo: nada a procurar");
  assert.deepEqual(l.feito, []);
  assert.ok(r.resultados.every((x) => x.acao === "nada"));
  assert.deepEqual(r.campos, {}, "nada mudou, nada a gravar");
});

/* ------------------------------------------------------------------ *
 * Ambiguidade: para e devolve os candidatos
 * ------------------------------------------------------------------ */

test("vários candidatos: não escolhe, não cria", async () => {
  const p = fingirPresenca({
    achar: { turma: null, candidatos: ["ELAS Quarta 14:00 (#11)", "ELAS Quarta 14:00 (#12)"] },
  });
  const l = fingirLeague({});

  const r = await propagarTurma(TURMA, VAZIO, { presenca: p.cliente, league: l.cliente });
  const res = r.resultados.find((x) => x.plataforma === "presenca")!;

  assert.equal(res.acao, "ambigua");
  assert.equal(res.ok, false);
  assert.equal(res.candidatos?.length, 2);
  assert.equal(r.mapa.presencaTurmaId, null, "nada de palpite");
  assert.ok(!p.feito.some((f) => f.startsWith("criarTurma")));
  assert.deepEqual(res.campos, {}, "ambiguidade não grava id nenhum");
});

test("programa sem liga conhecida: não cria às cegas", async () => {
  // Criar na liga errada esconde o conteúdo do aluno sem dar erro nenhum.
  const l = fingirLeague({ liga: null });
  const r = await propagarTurma(
    { ...TURMA, nome: "TEENS Quarta 14:00 PR 2/26" }, VAZIO,
    { presenca: fingirPresenca({}).cliente, league: l.cliente });

  const res = r.resultados.find((x) => x.plataforma === "league")!;
  assert.equal(res.acao, "ambigua");
  assert.match(res.mensagem, /liga/i);
  assert.ok(!l.feito.some((f) => f.startsWith("criarTurma")));
  // É este sinal que faz a tela abrir o seletor de liga. Sem ele, a mensagem
  // manda escolher a liga e a tela não oferece onde — foi o que aconteceu.
  assert.equal(res.precisaLiga, true);
});

/* ------------------------------------------------------------------ *
 * Criar
 * ------------------------------------------------------------------ */

test("não existe em lugar nenhum: cria nas duas, desativada", async () => {
  const p = fingirPresenca({});
  const l = fingirLeague({});

  const r = await propagarTurma(TURMA, VAZIO, { presenca: p.cliente, league: l.cliente });

  assert.ok(r.ok);
  assert.ok(p.feito.includes(`criarTurma(${TURMA.nome})`), "cria com o nome do Sponte");
  assert.ok(
    l.feito.some((f) => f.includes("ativa=false")),
    "turma nova não deve aparecer para o aluno antes de alguém conferir",
  );
  assert.equal(r.campos.presenca_turma_id, 10);
  assert.equal(r.campos.league_class_id, "classe-1");
});

test("criar: false só procura", async () => {
  const p = fingirPresenca({});
  const l = fingirLeague({});

  const r = await propagarTurma(
    TURMA, VAZIO, { presenca: p.cliente, league: l.cliente }, { criar: false });

  assert.ok(!p.feito.some((f) => f.startsWith("criarTurma")));
  assert.ok(!l.feito.some((f) => f.startsWith("criarTurma")));
  assert.ok(r.resultados.every((x) => x.acao === "nada"));
});

test("liga escolhida à mão vence a dedução", async () => {
  const l = fingirLeague({ liga: null });
  await propagarTurma(
    { ...TURMA, nome: "TEENS Quarta 14:00 PR 2/26" }, VAZIO,
    { presenca: fingirPresenca({}).cliente, league: l.cliente },
    { ligaId: "liga-nova" });

  assert.ok(l.feito.some((f) => f.includes("liga=liga-nova")));
});

/* ------------------------------------------------------------------ *
 * Falha numa plataforma não derruba a outra
 * ------------------------------------------------------------------ */

test("erro no Presença não impede o LeagueInvest", async () => {
  const p = fingirPresenca({ falharAoCriar: "sem permissão na tabela turmas" });
  const l = fingirLeague({});

  const r = await propagarTurma(TURMA, VAZIO, { presenca: p.cliente, league: l.cliente });

  assert.equal(r.ok, false);
  assert.equal(r.resultados.find((x) => x.plataforma === "presenca")!.acao, "erro");
  assert.equal(r.resultados.find((x) => x.plataforma === "league")!.acao, "criada");
  // O id do League é gravado mesmo com o Presença falhando: repetir depois
  // só tenta o que faltou.
  assert.equal(r.campos.league_class_id, "classe-1");
  assert.match(String(r.campos.presenca_erro), /permissão/);
});

test("sem LeagueInvest configurado, avisa e segue no Presença", async () => {
  const p = fingirPresenca({});
  const r = await propagarTurma(TURMA, VAZIO, { presenca: p.cliente, league: null });

  assert.ok(r.ok);
  assert.ok(r.avisos.some((a) => /LeagueInvest/.test(a)));
  assert.equal(r.resultados.length, 1);
});

/* ------------------------------------------------------------------ *
 * Nome fora do padrão
 * ------------------------------------------------------------------ */

test("nome fora do padrão avisa, mas não impede", async () => {
  const p = fingirPresenca({});
  const r = await propagarTurma(
    { ...TURMA, nome: "Evolution - Terça (14:00) - Único - 2026" }, VAZIO,
    { presenca: p.cliente, league: null });

  assert.ok(r.ok, "fora do padrão não é motivo para recusar");
  assert.ok(r.avisos.some((a) => /fora da convenção/.test(a)));
  // O nome vai como está: é ele que casa com o Sponte.
  assert.ok(p.feito.includes("criarTurma(Evolution - Terça (14:00) - Único - 2026)"));
});

test("sem padrão no nome, dia e horário ficam em branco", async () => {
  // Gravar palpite num campo `time` é pior que deixar vazio: a chamada
  // passaria a dizer um horário que ninguém combinou.
  const p = fingirPresenca({});
  await propagarTurma(
    { ...TURMA, nome: "Clube Elas" }, VAZIO,
    { presenca: p.cliente, league: null });

  const criada = p.feito.find((f) => f.startsWith("criarTurma"));
  assert.ok(criada, "deve criar mesmo assim");
});

/* ------------------------------------------------------------------ *
 * Ativar e desativar
 * ------------------------------------------------------------------ */

test("ativar cria o que falta e depois liga", async () => {
  const p = fingirPresenca({});
  const l = fingirLeague({});

  const r = await definirSituacaoTurma(
    TURMA, VAZIO, true, { presenca: p.cliente, league: l.cliente });

  assert.ok(r.ok);
  assert.ok(p.feito.some((f) => f.startsWith("criarTurma")));
  assert.ok(p.feito.some((f) => f.includes('atualizarTurma(10,{"ativa":true}')));
  assert.ok(l.feito.some((f) => f.includes('"ativa":true')));
});

test("desativar não cria turma só para desligá-la", async () => {
  const p = fingirPresenca({});
  const l = fingirLeague({});

  const r = await definirSituacaoTurma(
    TURMA, VAZIO, false, { presenca: p.cliente, league: l.cliente });

  assert.ok(r.ok);
  assert.ok(!p.feito.some((f) => f.startsWith("criarTurma")), "nada a criar");
  assert.ok(!p.feito.some((f) => f.startsWith("acharTurma")), "nem a procurar");
  assert.ok(r.resultados.every((x) => x.acao === "nada"));
});

test("desativar onde existe desliga nas duas", async () => {
  const p = fingirPresenca({});
  const l = fingirLeague({});

  await definirSituacaoTurma(
    TURMA, { presencaTurmaId: 42, leagueClassId: "uuid-9" }, false,
    { presenca: p.cliente, league: l.cliente });

  assert.ok(p.feito.some((f) => f.includes('atualizarTurma(42,{"ativa":false}')));
  assert.ok(l.feito.some((f) => f.includes('atualizarTurma(uuid-9,{"ativa":false}')));
});

/* ------------------------------------------------------------------ *
 * Total de aulas
 * ------------------------------------------------------------------ */

test("o total de aulas sai do programa", async () => {
  assert.equal(totalDeAulas("EVOL Segunda 14:00 PR 1/26"), 32);
  assert.equal(totalDeAulas("ELAS Quarta 14:00 PR 2/26"), 14);
  assert.equal(totalDeAulas("MAST Terça 18:30 PR 2/26"), 16);
});

test("programa desconhecido cai no padrão", async () => {
  assert.equal(totalDeAulas("TEENS Quarta 14:00 PR 2/26"), 20);
  assert.equal(totalDeAulas("Clube Elas"), 20);
});

test("nome fora do padrão ainda tenta pela primeira palavra", async () => {
  // "Evol Santa Doroteia - Único - 2026" existe no Sponte de verdade.
  assert.equal(totalDeAulas("Evol Santa Doroteia  - Único - 2026"), 32);
});
