/**
 * Testes do parser de turmas.
 *
 *     node --test supabase/functions/_shared/turmas.test.ts
 *
 * As amostras de XML aqui são **cópias literais** da resposta de produção
 * capturada em 24/09/2026 — não exemplos inventados. Quando o Sponte mudar o
 * formato, é aqui que a mudança aparece primeiro.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  dataBrParaIso,
  filtrarMatriculaveis,
  montarFiltroTurmas,
  parsearTurmas,
  turmaEncerrada,
  type TurmaSponte,
} from "./turmas.ts";

/** Turma real, copiada da resposta de produção. */
const TURMA_REAL = `<wsTurma>
<RetornoOperacao>01 - Operação Realizada com Sucesso.</RetornoOperacao>
<Nome>Avançado ( Segunda 18:00) - Módulo 4 - Educação Financeira - 2021</Nome>
<TurmaID>67</TurmaID>
<Sigla>Avançado (</Sigla>
<Situacao>Encerrada</Situacao>
<Turno>Noturno</Turno>
<ModuloAtual>1</ModuloAtual>
<CursoID>4</CursoID>
<Curso>Módulo 4 - Educação Financeira</Curso>
<AnoLetivo>2021</AnoLetivo>
<DataInicio>01/01/2021</DataInicio>
<DataTermino>31/12/2021</DataTermino>
<MaxAlunos>40</MaxAlunos>
<VagasOcupadas>1</VagasOcupadas>
<MatrizCurricular>Matriz Do Curso Educação Financeira</MatrizCurricular>
<Observacao />
<Horario>(Migração)</Horario>
<ProfessorRegente />
<ProfessorRegenteID>0</ProfessorRegenteID>
</wsTurma>`;

/** Resposta de busca sem resultados, como o Sponte devolve de verdade. */
const RESPOSTA_VAZIA = `<wsTurma><RetornoOperacao>43 - Nenhum registro foi encontrado para os parâmetros de busca informados.</RetornoOperacao><TurmaID>0</TurmaID><ModuloAtual>0</ModuloAtual><CursoID>0</CursoID><AnoLetivo>0</AnoLetivo><MaxAlunos>0</MaxAlunos><VagasOcupadas>0</VagasOcupadas><ProfessorRegenteID>0</ProfessorRegenteID></wsTurma>`;

/* ------------------------------------------------------------------ *
 * Datas
 * ------------------------------------------------------------------ */

test("dataBrParaIso converte dd/mm/aaaa", () => {
  assert.equal(dataBrParaIso("01/01/2021"), "2021-01-01");
  assert.equal(dataBrParaIso("31/12/2021"), "2021-12-31");
});

test("dataBrParaIso recusa dia que não existe no mês", () => {
  // new Date(2021, 1, 31) devolveria 3 de março sem reclamar — dado inválido
  // virando dado plausível é pior que erro.
  assert.equal(dataBrParaIso("31/02/2021"), null);
  assert.equal(dataBrParaIso("31/04/2021"), null);
});

test("dataBrParaIso aceita 29 de fevereiro em ano bissexto", () => {
  assert.equal(dataBrParaIso("29/02/2024"), "2024-02-29");
  assert.equal(dataBrParaIso("29/02/2023"), null);
});

test("dataBrParaIso recusa formato estranho ou vazio", () => {
  for (const v of ["", "2021-01-01", "1/1/2021", "abc", "13/13/2021"]) {
    assert.equal(dataBrParaIso(v), null, `deveria recusar ${JSON.stringify(v)}`);
  }
});

/* ------------------------------------------------------------------ *
 * Parse
 * ------------------------------------------------------------------ */

test("parsearTurmas lê todos os campos da turma real", () => {
  const [t] = parsearTurmas(TURMA_REAL);

  assert.equal(t.turmaId, 67);
  assert.equal(t.nome, "Avançado ( Segunda 18:00) - Módulo 4 - Educação Financeira - 2021");
  assert.equal(t.situacao, "Encerrada");
  assert.equal(t.turno, "Noturno");
  assert.equal(t.moduloAtual, 1);
  assert.equal(t.cursoId, 4);
  assert.equal(t.curso, "Módulo 4 - Educação Financeira");
  assert.equal(t.anoLetivo, 2021);
  assert.equal(t.dataInicio, "2021-01-01");
  assert.equal(t.dataTermino, "2021-12-31");
  assert.equal(t.maxAlunos, 40);
  assert.equal(t.vagasOcupadas, 1);
  assert.equal(t.horario, "(Migração)");
});

test("parsearTurmas calcula vagas livres", () => {
  const [t] = parsearTurmas(TURMA_REAL);
  assert.equal(t.vagasLivres, 39);
});

test("parsearTurmas nunca devolve vagas livres negativas", () => {
  const lotada = TURMA_REAL.replace("<VagasOcupadas>1<", "<VagasOcupadas>45<");
  assert.equal(parsearTurmas(lotada)[0].vagasLivres, 0);
});

test("parsearTurmas traduz professor ausente para null", () => {
  // Na origem vem <ProfessorRegente /> e <ProfessorRegenteID>0</…>, e um id 0
  // usado como número daria "turma do professor zero".
  const [t] = parsearTurmas(TURMA_REAL);
  assert.equal(t.professorRegente, null);
  assert.equal(t.professorRegenteId, null);
});

test("parsearTurmas lê professor quando existe", () => {
  const comProf = TURMA_REAL
    .replace("<ProfessorRegente />", "<ProfessorRegente>Ana Lima</ProfessorRegente>")
    .replace("<ProfessorRegenteID>0<", "<ProfessorRegenteID>12<");
  const [t] = parsearTurmas(comProf);
  assert.equal(t.professorRegente, "Ana Lima");
  assert.equal(t.professorRegenteId, 12);
});

test("parsearTurmas trata campo auto-fechado como string vazia", () => {
  assert.equal(parsearTurmas(TURMA_REAL)[0].observacao, "");
});

test("parsearTurmas devolve lista vazia na resposta de código 43", () => {
  // Sem isso, a busca sem resultados viraria "uma turma de id 0".
  assert.deepEqual(parsearTurmas(RESPOSTA_VAZIA), []);
});

test("parsearTurmas lê várias turmas", () => {
  const duas = TURMA_REAL + TURMA_REAL.replace("<TurmaID>67<", "<TurmaID>68<");
  const r = parsearTurmas(duas);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((t) => t.turmaId), [67, 68]);
});

test("parsearTurmas desescapa entidades no texto", () => {
  const xml = TURMA_REAL.replace(
    "<Curso>Módulo 4 - Educação Financeira</Curso>",
    "<Curso>Pais &amp; Filhos</Curso>",
  );
  assert.equal(parsearTurmas(xml)[0].curso, "Pais & Filhos");
});

test("parsearTurmas devolve lista vazia para XML sem turmas", () => {
  assert.deepEqual(parsearTurmas(""), []);
  assert.deepEqual(parsearTurmas("<Outra />"), []);
});

/* ------------------------------------------------------------------ *
 * Filtro
 * ------------------------------------------------------------------ */

test("montarFiltroTurmas usa ';' como separador", () => {
  // Observado em produção: com '&' o servidor ignora o segundo filtro em
  // silêncio e devolve mais registros que o pedido.
  assert.equal(
    montarFiltroTurmas({ AnoLetivo: 2021, CursoID: 4 }),
    "AnoLetivo=2021;CursoID=4",
  );
});

test("montarFiltroTurmas devolve 'Nome=' quando não há filtro", () => {
  // String vazia é recusada com erro 21; 'Nome=' é o idioma de "tudo".
  assert.equal(montarFiltroTurmas(), "Nome=");
  assert.equal(montarFiltroTurmas({}), "Nome=");
});

test("montarFiltroTurmas descarta valores vazios", () => {
  assert.equal(montarFiltroTurmas({ Nome: "  ", AnoLetivo: 2026 }), "AnoLetivo=2026");
});

test("montarFiltroTurmas nunca devolve string vazia", () => {
  assert.equal(montarFiltroTurmas({ Nome: "", CursoID: undefined }), "Nome=");
});

/* ------------------------------------------------------------------ *
 * Matriculáveis
 * ------------------------------------------------------------------ */

function turma(over: Partial<TurmaSponte> = {}): TurmaSponte {
  return {
    turmaId: 1, nome: "T", situacao: "Ativa", turno: "Noturno", moduloAtual: 1,
    cursoId: 1, curso: "C", anoLetivo: 2026, dataInicio: null, dataTermino: null,
    maxAlunos: 20, vagasOcupadas: 5, vagasLivres: 15, matrizCurricular: "",
    observacao: "", horario: "", professorRegente: null, professorRegenteId: null,
    ...over,
  };
}

test("filtrarMatriculaveis remove turma encerrada", () => {
  const r = filtrarMatriculaveis([turma({ situacao: "Encerrada" }), turma()]);
  assert.equal(r.length, 1);
});

test("filtrarMatriculaveis ignora caixa e espaço na situação", () => {
  const r = filtrarMatriculaveis([turma({ situacao: "  ENCERRADA " })]);
  assert.equal(r.length, 0);
});

test("filtrarMatriculaveis mantém situação desconhecida", () => {
  // Lista de exclusão, não de inclusão: uma situação nova na origem não pode
  // fazer turmas sumirem da tela sem explicação.
  const r = filtrarMatriculaveis([turma({ situacao: "Em formação" })]);
  assert.equal(r.length, 1);
});

test("filtrarMatriculaveis remove turma lotada", () => {
  const r = filtrarMatriculaveis([turma({ vagasLivres: 0 })]);
  assert.equal(r.length, 0);
});

test("filtrarMatriculaveis mantém lotada quando exigirVaga é false", () => {
  const r = filtrarMatriculaveis([turma({ vagasLivres: 0 })], { exigirVaga: false });
  assert.equal(r.length, 1);
});

test("filtrarMatriculaveis mantém turma sem limite declarado", () => {
  // maxAlunos = 0 significa "sem limite cadastrado", não "nenhuma vaga".
  const r = filtrarMatriculaveis([turma({ maxAlunos: 0, vagasLivres: 0 })]);
  assert.equal(r.length, 1);
});

test("filtrarMatriculaveis respeita o ano letivo", () => {
  const r = filtrarMatriculaveis(
    [turma({ anoLetivo: 2021 }), turma({ anoLetivo: 2026 })],
    { anoLetivo: 2026 },
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].anoLetivo, 2026);
});

/* ------------------------------------------------------------------ *
 * Turma encerrada e acesso
 *
 * Regra da escola: turma encerrada no Sponte não dá login no LeagueInvest
 * nem presença ativa, **mesmo que o aluno tenha pago**. `turmaEncerrada` é
 * quem responde essa pergunta, então o que ela erra vira acesso indevido
 * ou aluno pagante trancado para fora.
 * ------------------------------------------------------------------ */

test("turmaEncerrada reconhece os dois valores que o Sponte usa", () => {
  // Conferido na base: o Sponte devolve só "Aberta" (51) e "Encerrada" (123).
  assert.equal(turmaEncerrada({ situacao: "Encerrada" }), true);
  assert.equal(turmaEncerrada({ situacao: "Aberta" }), false);
});

test("turmaEncerrada ignora caixa e espaço", () => {
  for (const s of ["ENCERRADA", "encerrada", "  Encerrada  "]) {
    assert.equal(turmaEncerrada({ situacao: s }), true, s);
  }
});

test("situação desconhecida NÃO tranca o aluno para fora", () => {
  // Se o Sponte passar a devolver "Suspensa", tirar o acesso de todo mundo
  // por uma palavra nova é pior que não agir: trancaria aluno pagante.
  for (const s of ["Suspensa", "Em formação", "", null, undefined]) {
    assert.equal(turmaEncerrada({ situacao: s as never }), false, String(s));
  }
});

test("turma encerrada sai dos matriculáveis", () => {
  const base = {
    turmaId: 1, nome: "x", turno: "", moduloAtual: 1, cursoId: 1, curso: "",
    anoLetivo: 2026, dataInicio: null, dataTermino: null, maxAlunos: 0,
    vagasOcupadas: 0, vagasLivres: 0, matrizCurricular: "", observacao: "",
    horario: "", professorRegente: null, professorRegenteId: null,
  };
  const r = filtrarMatriculaveis([
    { ...base, turmaId: 1, situacao: "Aberta" },
    { ...base, turmaId: 2, situacao: "Encerrada" },
  ] as never);
  assert.deepEqual(r.map((t) => t.turmaId), [1]);
});

/* ------------------------------------------------------------------ *
 * Turma que já terminou não é matriculável
 *
 * A situação no Sponte é preenchida à mão: a turma só vira "Encerrada"
 * quando alguém lembra. A data de término é fato. Entre as duas, a data
 * decide — vender matrícula para um curso que acabou cria contrato morto.
 * ------------------------------------------------------------------ */

const TURMA_BASE = {
  turmaId: 1, nome: "x", situacao: "Aberta", turno: "", moduloAtual: 1,
  cursoId: 1, curso: "", anoLetivo: 2026, dataInicio: null,
  maxAlunos: 0, vagasOcupadas: 0, vagasLivres: 0, matrizCurricular: "",
  observacao: "", horario: "", professorRegente: null, professorRegenteId: null,
};

const emDias = (n: number) =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

test("turma Aberta que já terminou sai da lista", () => {
  const r = filtrarMatriculaveis([
    { ...TURMA_BASE, turmaId: 1, dataTermino: emDias(-30) },
    { ...TURMA_BASE, turmaId: 2, dataTermino: emDias(30) },
  ] as never);
  assert.deepEqual(r.map((t) => t.turmaId), [2]);
});

test("turma que termina hoje ainda vale", () => {
  // O último dia é dia de aula; cortar ao nascer do sol seria um dia a menos.
  const r = filtrarMatriculaveis(
    [{ ...TURMA_BASE, dataTermino: emDias(0) }] as never);
  assert.equal(r.length, 1);
});

test("turma sem data de término continua valendo", () => {
  // As de 2027 ainda não têm término preenchido. Sumir com elas seria pior
  // que o problema: é justamente o que a escola está vendendo.
  const r = filtrarMatriculaveis(
    [{ ...TURMA_BASE, dataTermino: null }] as never);
  assert.equal(r.length, 1);
});

test("turma que começa no futuro é matriculável", () => {
  // O caso do ano que vem: começa em 2027, matrícula vendida agora.
  const r = filtrarMatriculaveis([
    { ...TURMA_BASE, dataInicio: emDias(90), dataTermino: emDias(400) },
  ] as never);
  assert.equal(r.length, 1);
});
