/**
 * Testes da orquestração de matrícula.
 *
 *     node --test supabase/functions/_shared/matricula.test.ts
 *
 * Nenhum teste toca a rede. O que importa aqui é a **idempotência**: sem
 * `Delete*` na API do Sponte, repetir um passo cria duplicata que ninguém
 * consegue apagar.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  contatoNoSponte,
  type DadosMatricula,
  executarMatricula,
  pagamentoConfirmado,
  PASSOS,
  progressoVazio,
  promoverMatricula,
  ROTULO_PASSO,
  SITUACAO_ALUNO,
  SITUACAO_TURMA,
} from "./matricula.ts";

const CRED = { codigoCliente: 489528, token: "tokenfalso12" };

const DADOS: DadosMatricula = {
  nome: "Maria da Silva Souza",
  cpf: "529.982.247-25",
  dataNascimento: "1995-05-20",
  email: "maria@exemplo.com",
  celular: "(11) 98765-4321",
  sponteTurmaId: 135,
  sponteCursoId: 18,
  planoCursoId: 14,
  bolsaId: null,
  valorParcela: 129,
  parcelas: 10,
  formaCobrancaId: -29,   // Pix Sponte Pay 2.0
  parcelasCartao: 1,
};

/** `fetch` falso que devolve um envelope SOAP por operação. */
function fetchFalso(porOperacao: Record<string, string>) {
  const chamadas: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const corpo = String(init.body);
    const op = corpo.match(/<(\w+) xmlns="http:\/\/api\.sponteeducacional\.net\.br\/">/)?.[1] ?? "?";
    chamadas.push(op);
    const interno = porOperacao[op] ?? "<wsVazio><RetornoOperacao>01 - OK</RetornoOperacao></wsVazio>";
    const escapado = interno
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return new Response(
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
      `<${op}Response xmlns="http://api.sponteeducacional.net.br/">` +
      `<${op}Result>${escapado}</${op}Result></${op}Response></soap:Body></soap:Envelope>`,
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, chamadas };
}

const CPF_LIVRE =
  "<wsAluno><RetornoOperacao>43 - Nenhum registro foi encontrado para os parâmetros de busca informados.</RetornoOperacao><AlunoID>0</AlunoID></wsAluno>";

/* ------------------------------------------------------------------ *
 * Situações
 * ------------------------------------------------------------------ */

test("as situações usadas batem com a base real", () => {
  // Levantadas de GetSituacoesAlunosTurma e GetSituacoesAlunos em 05/10/2026.
  assert.equal(SITUACAO_TURMA.PRE_MATRICULA, -11);
  assert.equal(SITUACAO_TURMA.CURSANDO, -3);
  assert.equal(SITUACAO_ALUNO.INTERESSADO, -3);
  assert.equal(SITUACAO_ALUNO.ATIVO, -1);
});

test("todo passo tem rótulo para a tela", () => {
  for (const p of PASSOS) {
    assert.ok(ROTULO_PASSO[p], `passo ${p} sem rótulo`);
  }
});

/* ------------------------------------------------------------------ *
 * Simulação — o padrão
 * ------------------------------------------------------------------ */

test("simular é o padrão: nada é escrito sem pedir", async () => {
  // A trava existe porque o token é de produção e não há Delete* na API.
  const { fetchImpl, chamadas } = fetchFalso({ GetAlunos4: CPF_LIVRE });
  await executarMatricula(CRED, DADOS, progressoVazio(), { fetchImpl });

  assert.equal(chamadas.includes("InsertAlunos3"), false);
  assert.equal(chamadas.includes("InsertMatricula"), false);
  assert.equal(chamadas.includes("InsertPlano"), false);
});

test("simulação percorre todos os passos e devolve link", async () => {
  const { fetchImpl } = fetchFalso({ GetAlunos4: CPF_LIVRE });
  const p = await executarMatricula(CRED, DADOS, progressoVazio(), { fetchImpl });

  assert.equal(p.erro, null);
  assert.equal(p.ultimoPasso, "gerar_link");
  assert.ok(p.sponteAlunoId);
  assert.ok(p.contratoId);
  assert.ok(p.contaReceberId);
  assert.ok(p.linkPagamento);
});

test("ids simulados são negativos — nunca se confundem com reais", async () => {
  const { fetchImpl } = fetchFalso({ GetAlunos4: CPF_LIVRE });
  const p = await executarMatricula(CRED, DADOS, progressoVazio(), { fetchImpl });

  assert.ok(p.sponteAlunoId! < 0, "AlunoID simulado deveria ser negativo");
  assert.ok(p.contratoId! < 0);
  assert.ok(p.contaReceberId! < 0);
});

/* ------------------------------------------------------------------ *
 * Deduplicação
 * ------------------------------------------------------------------ */

test("CPF existente reaproveita o aluno em vez de criar outro", async () => {
  const { fetchImpl, chamadas } = fetchFalso({
    GetAlunos4: "<wsAluno><RetornoOperacao>01 - OK</RetornoOperacao><AlunoID>4321</AlunoID></wsAluno>",
  });
  const p = await executarMatricula(CRED, DADOS, progressoVazio(), { fetchImpl, simular: false });

  assert.equal(p.sponteAlunoId, 4321);
  assert.equal(p.alunoJaExistia, true);
  assert.equal(chamadas.includes("InsertAlunos3"), false);
});

test("código 43 no CPF libera o cadastro — não é erro", async () => {
  // É a resposta desejada: "esse aluno ainda não existe".
  const { fetchImpl } = fetchFalso({ GetAlunos4: CPF_LIVRE });
  const p = await executarMatricula(CRED, DADOS, progressoVazio(), { fetchImpl });

  assert.equal(p.erro, null);
  assert.equal(p.alunoJaExistia, false);
});

/* ------------------------------------------------------------------ *
 * Idempotência — o requisito mais caro
 * ------------------------------------------------------------------ */

test("rodar duas vezes não repete nenhuma escrita", async () => {
  const { fetchImpl } = fetchFalso({ GetAlunos4: CPF_LIVRE });
  const p1 = await executarMatricula(CRED, DADOS, progressoVazio(), { fetchImpl });

  const { fetchImpl: f2, chamadas: c2 } = fetchFalso({ GetAlunos4: CPF_LIVRE });
  const p2 = await executarMatricula(CRED, DADOS, p1, { fetchImpl: f2, simular: false });

  // Nada a fazer: o progresso já está completo.
  assert.deepEqual(c2, []);
  assert.equal(p2.sponteAlunoId, p1.sponteAlunoId);
  assert.equal(p2.contratoId, p1.contratoId);
  assert.equal(p2.linkPagamento, p1.linkPagamento);
});

test("retoma do ponto onde parou, sem refazer o que já passou", async () => {
  // Cenário real: o aluno e a matrícula foram criados, a geração do plano caiu.
  const parcial = {
    ...progressoVazio(),
    sponteAlunoId: 999, contratoId: 777, ultimoPasso: "criar_matricula" as const,
  };
  const { fetchImpl, chamadas } = fetchFalso({ GetAlunos4: CPF_LIVRE });
  const p = await executarMatricula(CRED, DADOS, parcial, { fetchImpl });

  assert.equal(p.sponteAlunoId, 999, "não pode recriar o aluno");
  assert.equal(p.contratoId, 777, "não pode recriar a matrícula");
  assert.equal(chamadas.includes("InsertAlunos3"), false);
  assert.equal(chamadas.includes("InsertMatricula"), false);
  assert.ok(p.linkPagamento);
});

/* ------------------------------------------------------------------ *
 * Falhas
 * ------------------------------------------------------------------ */

test("falha preserva o que já foi criado e aponta o passo", async () => {
  // Sem Delete*, perder o rastro do que já existe é o pior desfecho possível.
  const { fetchImpl } = fetchFalso({
    GetAlunos4: CPF_LIVRE,
    InsertAlunos3: "<wsRetorno><RetornoOperacao>99 - Falha inesperada</RetornoOperacao></wsRetorno>",
  });
  const p = await executarMatricula(CRED, DADOS, progressoVazio(), { fetchImpl, simular: false });

  assert.ok(p.erro);
  assert.equal(p.erroPasso, "criar_aluno");
  assert.equal(p.ultimoPasso, "verificar_cpf");
  assert.equal(p.linkPagamento, null);
});

test("aluno criado sem AlunoID legível vira erro explícito", async () => {
  // O pior caso: criou no ERP e não sabemos o id. A mensagem precisa dizer isso.
  const { fetchImpl } = fetchFalso({
    GetAlunos4: CPF_LIVRE,
    InsertAlunos3: "<wsRetorno><RetornoOperacao>01 - OK</RetornoOperacao></wsRetorno>",
  });
  const p = await executarMatricula(CRED, DADOS, progressoVazio(), { fetchImpl, simular: false });

  assert.ok(p.erro?.includes("AlunoID"));
  assert.equal(p.erroPasso, "criar_aluno");
});

/* ------------------------------------------------------------------ *
 * Pagamento
 * ------------------------------------------------------------------ */

const PARCELA = (dataPg: string) =>
  `<wsParcela><RetornoOperacao>01 - OK</RetornoOperacao><ContaReceberID>1060</ContaReceberID>` +
  `<NumeroParcela>1</NumeroParcela><DataPagamento>${dataPg}</DataPagamento>` +
  `<ValorParcela>129,00</ValorParcela><ValorPago>${dataPg ? "129,00" : ""}</ValorPago>` +
  `<AlunoID>999</AlunoID></wsParcela>`;

test("pagamentoConfirmado detecta parcela paga", async () => {
  const { fetchImpl } = fetchFalso({ GetParcelas: PARCELA("04/01/2026") });
  const r = await pagamentoConfirmado(CRED, 1060, "1", 999, { fetchImpl });

  assert.equal(r.pago, true);
  assert.equal(r.dataPagamento, "04/01/2026");
  assert.equal(r.valorPago, "129,00");
});

test("pagamentoConfirmado trata parcela em aberto", async () => {
  const { fetchImpl } = fetchFalso({ GetParcelas: PARCELA("") });
  const r = await pagamentoConfirmado(CRED, 1060, "1", 999, { fetchImpl });

  assert.equal(r.pago, false);
  assert.equal(r.dataPagamento, null);
});

test("pagamentoConfirmado não confunde parcelas de contas diferentes", async () => {
  const { fetchImpl } = fetchFalso({ GetParcelas: PARCELA("04/01/2026") });
  const r = await pagamentoConfirmado(CRED, 9999, "1", 999, { fetchImpl });

  assert.equal(r.pago, false);
});

test("promoverMatricula não escreve em simulação", async () => {
  const { fetchImpl, chamadas } = fetchFalso({});
  await promoverMatricula(CRED, 777, { fetchImpl });
  assert.deepEqual(chamadas, []);
});

test("promoverMatricula usa a situação Cursando quando liberado", async () => {
  const { fetchImpl, chamadas } = fetchFalso({});
  await promoverMatricula(CRED, 777, { fetchImpl, simular: false });
  assert.deepEqual(chamadas, ["UpdateMatriculaV2"]);
});

test("contatoNoSponte usa o contato do responsável quando há um", () => {
  // A régua do Sponte cobra pelo contato do aluno: com o do menor ali, o link
  // ia para a criança (cadastro 566).
  const menor: DadosMatricula = {
    ...DADOS, dataNascimento: "2011-03-10",
    responsavelNome: "Joana Souza", responsavelEmail: " joana@exemplo.com ",
    responsavelCelular: "(31) 99999-1015",
  };
  assert.deepEqual(contatoNoSponte(menor), { email: "joana@exemplo.com", celular: "31999991015" });
});

test("contatoNoSponte usa o contato do próprio aluno sem responsável", () => {
  assert.deepEqual(contatoNoSponte(DADOS), { email: "maria@exemplo.com", celular: "11987654321" });
});
