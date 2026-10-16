/**
 * Servidor de desenvolvimento.
 *
 *     npm run dev          (node --env-file=.env scripts/servidor-local.ts)
 *     → http://localhost:5173/admin-turmas.html
 *
 * Faz o papel das Edge Functions sem Docker, reaproveitando os mesmos módulos
 * de `supabase/functions/_shared/` que rodarão em produção — então o
 * comportamento da integração com o Sponte é o real.
 *
 * ⚠️ **Só para desenvolvimento.** Duas diferenças propositais em relação à
 * Edge Function: não exige autenticação e libera CORS. Os dados, porém, já são
 * os de verdade: a persistência é o Supabase, não mais `.dev-data/dados.json`.
 */

import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

import {
  chamarSoap, credenciais, credenciaisDoAmbiente, SponteError,
} from "../supabase/functions/_shared/soap.ts";
import {
  dataBrParaIso, filtrarMatriculaveis, getTurmas, turmaEncerrada,
} from "../supabase/functions/_shared/turmas.ts";
import {
  aplicarBolsa, type Bolsa, getBolsas, getPlanosCurso,
  type PlanoCurso, planoPreferido,
} from "../supabase/functions/_shared/planos.ts";
import {
  type FormaCobranca, formaParaLink, formasOferecidas, getFormasCobranca,
  parcelasPermitidas,
} from "../supabase/functions/_shared/pagamento.ts";
import {
  executarMatricula, pagamentoConfirmado, progressoVazio,
  promoverMatricula, type ProgressoMatricula, ROTULO_PASSO,
} from "../supabase/functions/_shared/matricula.ts";
import {
  avaliarAlerta, type EstadoCobranca, resumirCriterios, verificarCobranca,
} from "../supabase/functions/_shared/cobranca.ts";
import {
  type AlunoParaAtivar, ativarAluno, desativarAluno, resolverTurma,
} from "../supabase/functions/_shared/ativacao.ts";
import { ClienteLeague, configDoAmbiente } from "../supabase/functions/_shared/league.ts";
import { ClientePresenca } from "../supabase/functions/_shared/presenca.ts";
import {
  credenciaisWebDoAmbiente, gerarLinkPagamento, SponteWeb,
} from "./sponte-web.ts";
import {
  cascataDeAlunos, definirSituacaoTurma, propagarTurma, sincronizarTurma,
  vincularTurmaAMao, type MapaTurma, type ResultadoTurma, type TurmaOrigem,
} from "../supabase/functions/_shared/turma-plataformas.ts";
import { lerNomeTurma } from "../supabase/functions/_shared/turma-nome.ts";
import { Autenticacao, rotaPublica } from "./autenticacao.ts";
import { RepoSupabase } from "./repo-supabase.ts";

/**
 * Trava de escrita no ERP. `SPONTE_ESCRITA=1` libera a gravação real.
 *
 * O padrão é simular porque o token é de produção e nenhuma das 138 operações
 * do WSAPIEdu apaga o que for criado por engano.
 */
const ESCRITA_LIBERADA = process.env.SPONTE_ESCRITA === "1";

/**
 * Marca o que for criado no ERP como teste. Ligado sempre que a escrita
 * estiver liberada; só desliga com `SPONTE_MODO_TESTE=0`, explicitamente.
 */
const MODO_TESTE = ESCRITA_LIBERADA && process.env.SPONTE_MODO_TESTE !== "0";

const PORTA = Number(process.env.PORTA ?? 5173);
const RAIZ = resolve(import.meta.dirname, "..");

const cred = credenciaisDoAmbiente({ get: (c: string) => process.env[c] });

const auth = new Autenticacao({
  url: process.env.SUPABASE_URL!,
  publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY!,
  serviceKey: process.env.SUPABASE_SECRET_KEY!,
});

const repo = new RepoSupabase({
  url: process.env.SUPABASE_URL!,
  serviceKey: process.env.SUPABASE_SECRET_KEY!,
});

/**
 * Presença é este mesmo banco — gravação direta, sem API no meio.
 * LeagueInvest é de terceiros e só existe se as credenciais estiverem no
 * `.env`; sem elas o painel ativa no Presença e avisa o que ficou pendente,
 * em vez de recusar a ativação inteira.
 */
const presenca = new ClientePresenca({
  url: process.env.SUPABASE_URL!,
  serviceKey: process.env.SUPABASE_SECRET_KEY!,
  // Cada gravação no Presença vira uma linha de auditoria, com a tabela e o
  // que foi enviado. `cadastroAtual` liga o registro à ficha de quem o
  // provocou — o cliente não conhece a fila, então o servidor diz.
  aoRegistrar: (r) => repo.registrar({
    tipo: "presenca", operacao: r.operacao, cadastroId: cadastroAtual,
    ok: r.ok, duracaoMs: r.duracaoMs, erro: r.erro,
    detalhe: { tabela: r.tabela, ...r.detalhe },
  }),
});

const cfgLeague = configDoAmbiente({ get: (c: string) => process.env[c] });
const league = cfgLeague
  ? new ClienteLeague({
      ...cfgLeague,
      aoRegistrar: (r) => repo.registrar({
        tipo: "league", operacao: r.operacao, cadastroId: cadastroAtual,
        ok: r.ok, duracaoMs: r.duracaoMs, erro: r.erro,
        detalhe: { recurso: r.recurso, ...r.detalhe },
      }),
    })
  : null;

/**
 * Qual ficha está sendo processada agora.
 *
 * Os clientes do Presença e do League não sabem de cadastro — nem deveriam.
 * Mas um registro de auditoria sem o aluno a que se refere é quase inútil na
 * hora de investigar. Como o Node roda uma coisa de cada vez e as ativações
 * passam por uma função só, esta variável basta para costurar os dois.
 *
 * ⚠️ Se um dia houver ativação em paralelo, isto embaralha: aí o caminho é
 * passar o id por parâmetro em vez de guardá-lo aqui fora.
 */
let cadastroAtual: number | null = null;

/**
 * Sessão na interface web do Sponte, para gerar o link de pagamento.
 *
 * É a única etapa do fluxo sem API (ver `docs/API-SPONTE.md` §9.9). A sessão
 * é reaproveitada entre os cadastros: cada login custa dois carregamentos de
 * página, e refazer isso a cada aluno seria desperdício.
 */
const cfgWeb = credenciaisWebDoAmbiente({ get: (c: string) => process.env[c] });
const sponteWeb = cfgWeb ? new SponteWeb(cfgWeb) : null;

/* ------------------------------------------------------------------ *
 * Cache do catálogo do Sponte
 *
 * Turmas, planos, bolsas e formas mudam raramente e custam uma chamada SOAP
 * cada — que é lenta. Sem cache a tela de turmas ficaria inutilizável.
 * ------------------------------------------------------------------ */

const CACHE_MS = 60_000;
const CACHE_COMERCIAL_MS = 300_000;

let cacheTurmas: { quando: number; dados: Awaited<ReturnType<typeof getTurmas>> } | null = null;
const cachePlanos = new Map<number, { quando: number; dados: PlanoCurso[] }>();
let cacheBolsas: { quando: number; dados: Bolsa[] } | null = null;
let cacheFormas: { quando: number; dados: FormaCobranca[] } | null = null;

async function turmasComCache() {
  if (cacheTurmas && Date.now() - cacheTurmas.quando < CACHE_MS) return cacheTurmas.dados;
  const dados = await getTurmas(cred, {}, { timeoutMs: 90_000 });
  cacheTurmas = { quando: Date.now(), dados };
  return dados;
}

async function planosComCache(cursoId: number): Promise<PlanoCurso[]> {
  const hit = cachePlanos.get(cursoId);
  if (hit && Date.now() - hit.quando < CACHE_COMERCIAL_MS) return hit.dados;
  const dados = await getPlanosCurso(cred, cursoId, { timeoutMs: 60_000 });
  cachePlanos.set(cursoId, { quando: Date.now(), dados });
  return dados;
}

async function bolsasComCache(): Promise<Bolsa[]> {
  if (cacheBolsas && Date.now() - cacheBolsas.quando < CACHE_COMERCIAL_MS) return cacheBolsas.dados;
  const dados = await getBolsas(cred, { timeoutMs: 60_000 });
  cacheBolsas = { quando: Date.now(), dados };
  return dados;
}

async function formasComCache(): Promise<FormaCobranca[]> {
  if (cacheFormas && Date.now() - cacheFormas.quando < CACHE_COMERCIAL_MS) return cacheFormas.dados;
  const dados = formasOferecidas(await getFormasCobranca(cred, { timeoutMs: 60_000 }));
  cacheFormas = { quando: Date.now(), dados };
  return dados;
}

/** Retrato comercial a partir de um plano e uma bolsa escolhidos. */
function montarCondicao(plano: PlanoCurso | null, bolsa: Bolsa | null) {
  if (!plano) {
    return {
      planoCursoId: null, planoDescricao: null, bolsaId: null, bolsaDescricao: null,
      valorParcela: null, parcelas: null, valorTotal: null, valorParcelaCheia: null,
    };
  }
  const c = aplicarBolsa(plano, bolsa);
  return {
    planoCursoId: plano.planoCursoId,
    planoDescricao: plano.descricao,
    bolsaId: bolsa?.bolsaId ?? null,
    bolsaDescricao: bolsa?.descricao ?? null,
    valorParcela: c.valorParcela,
    parcelas: c.parcelas,
    valorTotal: c.total,
    valorParcelaCheia: c.descontoAplicado > 0 ? c.valorParcelaCheia : null,
  };
}

/* ------------------------------------------------------------------ *
 * Checkout no Sponte
 * ------------------------------------------------------------------ */

/**
 * Executa a sequência de matrícula e grava o progresso.
 *
 * Idempotente: o progresso vive nas colunas `sponte_*` do cadastro e uma
 * segunda chamada retoma de onde parou, em vez de recriar no ERP — onde nada
 * pode ser apagado.
 */
async function iniciarCheckout(id: number) {
  const c = await repo.buscarCadastro(id);
  if (!c) return { ok: false, motivo: "nao_encontrado" };
  // Sem guarda de meio de pagamento: o aluno não escolhe mais. Toda
  // cobrança sai em "Link de Pagamento Sponte Pay", e Pix/boleto/cartão ele
  // decide na página do Sponte Pay.

  // Já tem link: devolve o mesmo. Gerar outro criaria uma segunda cobrança.
  if (c.pagamentoLink) {
    return { ok: true, link: c.pagamentoLink, simulado: !ESCRITA_LIBERADA, jaExistia: true };
  }

  // A forma de cobrança é resolvida no catálogo real a partir do meio que o
  // aluno escolheu; o navegador manda o rótulo, nunca um id de cobrança.
  // A cobrança no Sponte vai SEMPRE em "Link de Pagamento Sponte Pay": é a
  // única forma que a tela de geração enxerga. O meio que o aluno escolheu
  // (Pix, cartão, boleto) ele confirma na página do Sponte Pay — guardamos
  // só para a escola saber a intenção.
  const todas = await getFormasCobranca(cred, { timeoutMs: 60_000 });
  const forma = formaParaLink(todas);
  if (!forma) {
    return {
      ok: false, motivo: "sem_forma_de_link",
      erro: "o Sponte não tem a forma \"Link de Pagamento Sponte Pay\" cadastrada",
    };
  }
  const formaCobrancaId = forma.formaCobrancaId;

  const iniciouEm = Date.now();
  const turma = (await turmasComCache()).find((t) => t.turmaId === c.turmaId);

  const p = await executarMatricula(
    cred,
    {
      nome: c.nome, cpf: c.cpf, dataNascimento: c.dataNascimento,
      email: c.email, celular: c.celular, sexo: c.sexo,
      rg: c.rg, estadoCivil: c.estadoCivil, nacionalidade: c.nacionalidade,
      cidadeNatal: c.cidadeNatal, profissao: c.profissao, telefone: c.telefone,
      cep: c.cep, endereco: c.endereco, numeroEndereco: c.numeroEndereco,
      complemento: c.complemento, bairro: c.bairro, cidade: c.cidade, uf: c.uf,
      origemVenda: c.origemVenda,
      responsavelNome: c.responsavelNome, responsavelCpf: c.responsavelCpf,
      responsavelEmail: c.responsavelEmail, responsavelCelular: c.responsavelCelular,
      sponteTurmaId: c.turmaId, sponteCursoId: c.cursoId,
      turmaDataTermino: turma?.dataTermino ?? null,
      planoCursoId: c.planoCursoId, bolsaId: c.bolsaId,
      valorParcela: c.valorParcela ?? 0, parcelas: c.parcelas ?? 1,
      // O que será cobrado de fato: o total do contrato, numa cobrança só.
      valorTotal: c.valorTotal,
      formaCobrancaId,
      parcelasCartao: c.parcelasCartao ?? 1,
      observacao: `Cadastro online · link ${c.linkId}`,
    },
    (c.progresso as ProgressoMatricula | null) ?? progressoVazio(),
    { simular: !ESCRITA_LIBERADA, marcarComoTeste: MODO_TESTE, timeoutMs: 120_000 },
  );

  // Os ids do ERP são gravados mesmo em caso de erro: sem eles a retentativa
  // recriaria aluno e contrato que já existem.
  const campos: Record<string, unknown> = {
    sponte_aluno_id: p.sponteAlunoId,
    sponte_responsavel_id: p.responsavelId,
    sponte_contrato_id: p.contratoId,
    sponte_conta_receber_id: p.contaReceberId,
    sponte_numero_parcela: p.numeroParcela,
    forma_cobranca_id: formaCobrancaId || null,
    forma_cobranca_nome: forma?.descricao ?? c.formaCobrancaNome ?? null,
  };

  // Os ids ficam registrados mesmo no erro: são eles que dizem até onde a
  // sequência chegou no ERP, e é a única forma de saber o que já existe lá
  // antes de tentar de novo.
  repo.registrar({
    tipo: "sponte",
    operacao: "matricula",
    cadastroId: id,
    ok: !p.erro,
    duracaoMs: Date.now() - iniciouEm,
    erro: p.erro ? `${p.erroPasso ?? ""}: ${p.erro}` : null,
    detalhe: {
      alunoId: p.sponteAlunoId, alunoJaExistia: p.alunoJaExistia,
      responsavelId: p.responsavelId, contratoId: p.contratoId,
      contaReceberId: p.contaReceberId, numeroParcela: p.numeroParcela,
      parcelas: c.parcelas, valorParcela: c.valorParcela, valorTotal: c.valorTotal,
      formaCobrancaId, ultimoPasso: p.ultimoPasso,
    },
  });

  if (p.erro) {
    campos.status = "erro";
    campos.sponte_erro = `${p.erroPasso ? ROTULO_PASSO[p.erroPasso] + ": " : ""}${p.erro}`;
    await repo.atualizarCadastro(id, campos);
    return { ok: false, motivo: "falha_sponte", passo: p.erroPasso, erro: campos.sponte_erro };
  }

  // 8º passo, fora da API: gerar o link na tela do Sponte.
  //
  // Vem depois de tudo porque depende da parcela existir, e é a única etapa
  // que pode falhar sem invalidar o resto — o aluno já está matriculado e a
  // cobrança já existe. Falhando aqui, o cadastro segue para o alerta, que é
  // o caminho que havia antes de existir automação.
  let linkPagamento = p.linkPagamento;
  if (!linkPagamento && p.contaReceberId && sponteWeb) {
    try {
      const estado = await verificarCobranca(
        cred, p.sponteAlunoId!, p.contaReceberId, p.numeroParcela ?? "1",
        { timeoutMs: 90_000 },
      );
      linkPagamento = estado.linkPagamento;

      if (!linkPagamento && estado.vencimento) {
        const t0 = Date.now();
        const g = await gerarLinkPagamento(sponteWeb, {
          contaReceberId: p.contaReceberId,
          numeroParcela: p.numeroParcela ?? "1",
          vencimento: estado.vencimento,
        });

        // Um link é uma cobrança: fica registrado quem nasceu, quando e com
        // que número, mesmo quando o Sponte recusa.
        repo.registrar({
          tipo: "link", operacao: "gerarLinkPagamento", cadastroId: id,
          ok: g.ok, duracaoMs: Date.now() - t0, erro: g.ok ? null : g.motivo,
          detalhe: {
            contaReceberId: p.contaReceberId, parcela: p.numeroParcela ?? "1",
            vencimento: estado.vencimento,
            numeroLink: g.numeroLink, jaExistia: g.jaExistia,
          },
        });

        if (g.ok) linkPagamento = g.url;
        else console.error(`  ✖ geração do link (cadastro ${id}): ${g.motivo}`);
      }
    } catch (e) {
      // Registra e segue: o alerta avisa o time, e a matrícula não se perde
      // por causa de uma tela que mudou de lugar.
      console.error(`  ✖ geração do link (cadastro ${id}): ${(e as Error).message}`);
    }
  }

  campos.sponte_erro = null;
  campos.status = "enviado";
  campos.sponte_enviado_em = new Date().toISOString();
  campos.pagamento_link = linkPagamento;
  // Sem link ainda é sucesso: o aluno está matriculado e a cobrança existe.
  // O que falta é a fatura, que só a régua do Sponte (ou alguém na tela) gera.
  campos.pagamento_status = linkPagamento ? "link_gerado" : "aguardando";
  if (linkPagamento) campos.pagamento_link_gerado_em = new Date().toISOString();

  await repo.atualizarCadastro(id, campos);

  return {
    ok: true,
    link: linkPagamento,
    aguardandoFatura: !linkPagamento,
    simulado: !ESCRITA_LIBERADA,
    jaExistia: false,
  };
}

/**
 * Verifica se a parcela foi paga e promove a matrícula.
 *
 * Polling porque o WSDL não expõe webhook — está na lista de perguntas para a
 * Sponte. É o que faz o aluno esperar entre pagar e entrar na turma.
 */
async function conferirPagamento(id: number) {
  const c = await repo.buscarCadastro(id);
  if (!c) return { ok: false, motivo: "nao_encontrado" };
  if (c.pagamentoStatus === "pago") {
    return { ok: true, pago: true, confirmadoEm: c.pagamentoConfirmadoEm };
  }

  const p = c.progresso;
  if (!p?.contaReceberId) return { ok: true, pago: false };

  // Em simulação não há parcela real para consultar.
  if (!ESCRITA_LIBERADA) return { ok: true, pago: false, simulado: true };

  // O link pode ter nascido depois do cadastro: quem o gera é alguém na tela
  // do Sponte. A página de espera pergunta de tempos em tempos, e é aqui que
  // a resposta aparece.
  //
  // Uma consulta ao Sponte a cada 30s por cadastro, no máximo: a página
  // pergunta mais que isso, e cada consulta custa duas chamadas SOAP.
  const checadoHa = c.cobrancaVerificadaEm
    ? Date.now() - new Date(c.cobrancaVerificadaEm).getTime()
    : Infinity;

  if (!c.pagamentoLink && checadoHa > 30_000) {
    await verificarCobrancas();
    const atual = await repo.buscarCadastro(id);
    if (atual?.pagamentoLink) {
      return { ok: true, pago: false, link: atual.pagamentoLink };
    }
  } else if (c.pagamentoLink) {
    return { ok: true, pago: false, link: c.pagamentoLink };
  }

  const r = await pagamentoConfirmado(
    cred, p.contaReceberId, p.numeroParcela ?? "1", p.sponteAlunoId ?? 0,
    { timeoutMs: 90_000 },
  );
  if (!r.pago) return { ok: true, pago: false, link: c.pagamentoLink ?? null };

  const campos: Record<string, unknown> = {
    pagamento_status: "pago",
    pagamento_confirmado_em: new Date().toISOString(),
  };

  // Pago: promove a pré-matrícula para Cursando. Se a promoção falhar, o
  // pagamento continua registrado — perder isso seria pior que o erro.
  if (p.contratoId) {
    try {
      await promoverMatricula(cred, p.contratoId, { simular: !ESCRITA_LIBERADA });
    } catch (e) {
      campos.sponte_erro =
        `Pagamento confirmado, mas a matrícula não foi ativada: ${(e as Error).message}`;
    }
  }

  await repo.atualizarCadastro(id, campos);
  return {
    ok: true, pago: true,
    confirmadoEm: campos.pagamento_confirmado_em,
    dataPagamento: r.dataPagamento,
  };
}

/**
 * Percorre os cadastros com cobrança em aberto e atualiza o estado.
 *
 * Roda sozinho de tempos em tempos (ver o agendamento no fim do arquivo) e
 * também sob demanda. É aqui que se decide chamar o time: a régua do Sponte
 * tem um prazo, e passado o prazo sem fatura alguém precisa gerar à mão.
 */
async function verificarCobrancas() {
  const emAberto = await repo.cobrancasEmAberto();
  let verificados = 0, pagos = 0, novosAlertas = 0;

  for (const c of emAberto) {
    const p = c.progresso;
    if (!p?.contaReceberId) continue;

    const campos: Record<string, unknown> = {};
    let estado: EstadoCobranca | null = null;

    try {
      if (ESCRITA_LIBERADA) {
        estado = await verificarCobranca(
          cred, p.sponteAlunoId!, p.contaReceberId, p.numeroParcela ?? "1",
          { timeoutMs: 90_000 },
        );
        campos.cobranca_verificada_em = estado.verificadoEm;
        if (estado.faturaId) campos.sponte_fatura_id = estado.faturaId;

        // O vencimento vem como dd/mm/aaaa e era descartado. É ele que
        // separa "aguardando" de "vencida": sem data, a tela não tem como
        // dizer quem está atrasado.
        const venc = dataBrParaIso(estado.vencimento ?? "");
        if (venc) campos.pagamento_vencimento = venc;
        if (estado.valorPago) {
          const v = Number(String(estado.valorPago).replace(",", "."));
          if (Number.isFinite(v) && v > 0) campos.pagamento_valor_pago = v;
        }
        if (estado.linkPagamento) {
          campos.pagamento_link = estado.linkPagamento;
          campos.pagamento_status = "link_gerado";
          if (!c.pagamentoLink) campos.pagamento_link_gerado_em = new Date().toISOString();
        }
        if (estado.situacao === "paga") {
          campos.pagamento_status = "pago";
          campos.pagamento_confirmado_em = new Date().toISOString();
          pagos++;
        }
      }
      verificados++;
    } catch (e) {
      // Falha de leitura não pode apagar o estado anterior nem travar o laço.
      console.error(`  ✖ cobrança do cadastro ${c.id}: ${(e as Error).message}`);
    }

    const alerta = avaliarAlerta({
      nomeAluno: c.nome,
      turmaNome: c.turmaNome,
      criadoEm: c.criadoEm,
      criterios: resumirCriterios({
        sponteAlunoId: p.sponteAlunoId,
        responsavelId: p.responsavelId ?? null,
        contratoId: p.contratoId,
        contaReceberId: p.contaReceberId,
        email: c.email, celular: c.celular, cpf: c.cpf,
        formaCobrancaId: c.formaCobrancaId,
        valorParcela: c.valorParcela, parcelas: c.parcelas,
      }),
      estado,
    });

    if (alerta) {
      if (alerta.motivo !== c.alerta?.motivo) novosAlertas++;
      Object.assign(campos, {
        alerta_motivo: alerta.motivo, alerta_urgente: alerta.urgente,
        alerta_titulo: alerta.titulo, alerta_descricao: alerta.descricao,
        alerta_acao: alerta.acao, alerta_em: new Date().toISOString(),
        alerta_resolvido_em: null,
      });
    } else if (c.alerta) {
      // Resolveu sozinho (a régua gerou, ou foi pago): fecha o alerta em vez
      // de apagá-lo, para o histórico mostrar que ele existiu.
      campos.alerta_resolvido_em = new Date().toISOString();
    }

    if (Object.keys(campos).length) await repo.atualizarCadastro(c.id, campos);
  }

  repo.registrar({
    tipo: "vigia", operacao: "verificarCobrancas", ok: true,
    detalhe: { verificados, pagos, novosAlertas, emAberto: emAberto.length },
  });

  return { verificados, pagos, novosAlertas, emAberto: emAberto.length };
}

/* ------------------------------------------------------------------ *
 * Ativação no Presença e no LeagueInvest
 * ------------------------------------------------------------------ */

/**
 * Espelha o aluno nas outras duas plataformas.
 *
 * `acao` "ativar" cria ou reativa; "desativar" inativa no Presença e cancela
 * a matrícula no LeagueInvest, sem jamais tocar na turma.
 */
async function ativacao(id: number, acao: "ativar" | "desativar", motivo?: string) {
  const c = await repo.buscarCadastro(id);
  if (!c) return { ok: false, motivo: "nao_encontrado" };

  // Costura os registros das duas plataformas a esta ficha.
  cadastroAtual = id;
  try {

  const aluno: AlunoParaAtivar = {
    id: c.id, nome: c.nome, email: c.email,
    turmaNome: c.turmaNome ?? "", sponteTurmaId: c.turmaId,
    presencaAlunoId: c.presencaAlunoId, leagueUserId: c.leagueUserId,
  };

  if (acao === "desativar") {
    const t0 = Date.now();
    const r = await desativarAluno(aluno, { presenca, league }, motivo);
    await repo.atualizarCadastro(id, r.campos);
    for (const x of r.resultados) {
      repo.registrar({
        tipo: x.plataforma === "presenca" ? "presenca" : "league",
        operacao: "desativar", cadastroId: id, ok: x.ok,
        duracaoMs: Date.now() - t0, erro: x.ok ? null : x.mensagem,
        detalhe: { mensagem: x.mensagem, motivo: motivo ?? null },
      });
    }
    return { ...r, avisos: [] };
  }

  /* --- Turma encerrada no Sponte não dá acesso, nem a quem pagou --- *
   *
   * O Sponte é a fonte: se a turma está encerrada lá, o aluno não pode
   * aparecer como ativo na chamada nem conseguir entrar no LeagueInvest.
   * Pagamento não muda isso — pagou por uma turma que a escola fechou, e o
   * que resolve é devolver ou remanejar, não liberar o acesso.
   *
   * Recusar aqui, e não só esconder a turma no formulário, porque a
   * ativação também é disparada à mão pelo painel e em lote.
   *
   * Quem veio da planilha não tem turma do Sponte (`turmaId` nulo) e passa
   * direto: não há situação para consultar.
   */
  if (c.turmaId) {
    const daTurma = (await turmasComCache()).find((t) => t.turmaId === c.turmaId);
    if (daTurma && turmaEncerrada(daTurma)) {
      const motivo =
        `A turma "${daTurma.nome}" está encerrada no Sponte. Enquanto estiver ` +
        `assim, o aluno não é ativado no Presença nem no LeagueInvest — ` +
        `mesmo tendo pago. Reabra a turma no Sponte ou mude o aluno de turma.`;

      repo.registrar({
        tipo: "sponte", operacao: "ativar recusado (turma encerrada)",
        cadastroId: id, ok: false, erro: motivo,
        detalhe: { turmaId: c.turmaId, turma: daTurma.nome, situacao: daTurma.situacao },
      });
      return { ok: false, motivo: "turma_encerrada", mensagem: motivo, resultados: [], avisos: [motivo] };
    }
  }

  // Três fontes para os ids da turma, da mais confiável para a menos:
  // o que a própria ficha traz (veio da planilha, conferido por gente), o
  // mapa já aprendido, e por último o casamento de nome.
  const doMapa = c.turmaId ? await repo.mapaTurma(c.turmaId) : null;
  const conhecido = {
    presencaTurmaId: c.presencaTurmaId ?? doMapa?.presencaTurmaId ?? null,
    leagueClassId: c.leagueClassId ?? doMapa?.leagueClassId ?? null,
  };

  const { mapa, aprender, avisos } = await resolverTurma(
    aluno.turmaNome, conhecido, { presenca, league });

  // O mapa por turma do Sponte só existe para quem veio do formulário; o
  // aluno da planilha não tem turma no Sponte e guarda os ids na própria ficha.
  if (c.turmaId && (aprender.presencaTurmaId || aprender.leagueClassId)) {
    await repo.gravarMapaTurma(c.turmaId, aprender, {
      turmaNome: aluno.turmaNome, cursoNome: c.cursoNome, sponteCursoId: c.cursoId,
    });
  } else if (!c.turmaId && (aprender.presencaTurmaId || aprender.leagueClassId)) {
    await repo.atualizarCadastro(id, {
      ...(aprender.presencaTurmaId ? { presenca_turma_id: aprender.presencaTurmaId } : {}),
      ...(aprender.leagueClassId ? { league_class_id: aprender.leagueClassId } : {}),
    });
  }

  const t0 = Date.now();
  const r = await ativarAluno(aluno, mapa, { presenca, league });
  await repo.atualizarCadastro(id, r.campos);

  for (const x of r.resultados) {
    repo.registrar({
      tipo: x.plataforma === "presenca" ? "presenca" : "league",
      operacao: "ativar (resumo)", cadastroId: id, ok: x.ok,
      duracaoMs: Date.now() - t0, erro: x.ok ? null : x.mensagem,
      detalhe: {
        mensagem: x.mensagem, turma: aluno.turmaNome,
        presencaTurmaId: mapa.presencaTurmaId, leagueClassId: mapa.leagueClassId,
        ...x.campos,
      },
    });
  }
  return { ...r, avisos };
  } finally {
    cadastroAtual = null;
  }
}

/**
 * Cadastra pelo painel e leva até o fim: Sponte, Presença e LeagueInvest.
 *
 * O formulário público para a cada passo e deixa o resto para depois, porque
 * do outro lado há um aluno esperando. Aqui é o contrário: quem está
 * digitando é da escola, e interromper no meio só geraria uma ficha pela
 * metade para alguém terminar à mão mais tarde.
 *
 * Mesmo assim **nada é desfeito em caso de falha parcial**. Se o Sponte
 * aceitar e o Presença recusar, a matrícula vale e a pendência fica visível
 * na ficha — desfazer no Sponte não é possível por API, e fingir que o
 * cadastro não aconteceu seria pior que mostrar o que falta.
 */
async function cadastrarManual(c: Record<string, any>, ip: string | null) {
  const nome = String(c.nome ?? "").trim();
  const cpf = String(c.cpf ?? "").replace(/\D/g, "");
  const turmaId = Number(c.turmaId);

  if (nome.length < 3) return { ok: false, motivo: "nome_invalido" };
  if (cpf.length !== 11) return { ok: false, motivo: "cpf_invalido" };
  if (!Number.isInteger(turmaId) || turmaId <= 0) return { ok: false, motivo: "turma_invalida" };

  const turma = (await turmasComCache()).find((t) => t.turmaId === turmaId);
  if (!turma) return { ok: false, motivo: "turma_nao_encontrada" };

  // Mesma regra do formulário público: o mesmo CPF não entra duas vezes na
  // mesma turma. Em turma diferente pode — são duas matrículas de verdade.
  const repetido = await repo.cpfJaNaTurma(cpf, turmaId);
  if (repetido) {
    return { ok: false, motivo: "duplicado", cadastroId: repetido.id, nome: repetido.nome };
  }

  // O preço sai do plano, não do que foi digitado.
  const planos = await planosComCache(turma.cursoId);
  const bolsas = await bolsasComCache();
  const plano = c.planoCursoId
    ? planos.find((p) => p.planoCursoId === Number(c.planoCursoId)) ?? null
    : planoPreferido(planos);
  if (!plano) return { ok: false, motivo: "sem_plano" };

  const bolsa = c.bolsaId ? bolsas.find((b) => b.bolsaId === Number(c.bolsaId)) ?? null : null;
  const condicao = montarCondicao(plano, bolsa);

  const maximo = Math.max(Number(condicao.parcelas) || 1, 1);
  const parcelas = Math.min(Math.max(Number(c.parcelas) || maximo, 1), maximo);

  const ficha = await repo.criarCadastroManual({
    nome, cpf,
    dataNascimento: c.dataNascimento || null,
    email: c.email ?? null, celular: c.celular ?? null,
    cep: c.cep, endereco: c.endereco, numeroEndereco: c.numeroEndereco,
    complemento: c.complemento, bairro: c.bairro, cidade: c.cidade, uf: c.uf,
    origemVenda: c.origemVenda, observacao: c.observacao,
    turmaId, cursoId: turma.cursoId,
    turmaNome: turma.nome, cursoNome: turma.curso ?? "",
    condicao, parcelas,
  });
  if (!ficha) return { ok: false, motivo: "nao_gravou" };

  repo.registrar({
    tipo: "http", operacao: "cadastro manual", cadastroId: ficha.id, ok: true, ip,
    detalhe: { nome, turma: turma.nome, parcelas, valorTotal: condicao.valorTotal },
  });

  // Daqui em diante é o mesmo caminho do cadastro público.
  const checkout = await iniciarCheckout(ficha.id);
  const ativacao_ = checkout.ok ? await ativacao(ficha.id, "ativar") : null;

  return {
    ok: true,
    id: ficha.id,
    sponte: checkout,
    plataformas: ativacao_,
    link: (checkout as { link?: string | null }).link ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Busca e vínculo manual
 *
 * O casamento automático acerta a maioria e erra alguns: homônimo no
 * Presença (8 nomes repetidos entre 411 alunos), e-mail diferente no
 * LeagueInvest, CPF digitado errado no Sponte. Quando erra, o conserto não
 * pode depender de alguém com acesso ao banco.
 * ------------------------------------------------------------------ */

export type Plataforma = "sponte" | "presenca" | "league";

/** Resultado de busca, no mesmo formato para as três plataformas. */
interface Achado {
  id: string;
  rotulo: string;
  /** A linha de baixo: o que distingue dois resultados parecidos. */
  detalhe: string;
}

async function procurar(plataforma: Plataforma, termo: string): Promise<Achado[]> {
  const q = termo.trim();
  if (q.length < 2) return [];

  if (plataforma === "sponte") {
    // Só dígitos vira busca por CPF; o resto, por nome. É o que alguém
    // esperaria ao colar um CPF no campo.
    const digitos = q.replace(/\D/g, "");
    const filtro = digitos.length === 11 ? `CPF=${digitos}` : `Nome=${q}`;
    const xml = await chamarSoap("GetAlunos4",
      [...credenciais(cred), ["sParametrosBusca", filtro]],
      { timeoutMs: 90_000, ignorarRetornoOperacao: true });

    return xml.split("<wsAluno>").slice(1).slice(0, 20).map((b) => {
      const f = (t: string) => b.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1] ?? "";
      return {
        id: f("AlunoID"),
        rotulo: f("Nome"),
        detalhe: [f("CPF"), f("TurmaAtual"), f("Situacao")].filter(Boolean).join(" · "),
      };
    }).filter((a) => a.id && a.id !== "0");
  }

  if (plataforma === "presenca") {
    const r = await presenca.procurarAlunos(q);
    return r.map((a) => ({
      id: String(a.id),
      rotulo: a.nome,
      detalhe: [a.turmaNome ?? "sem turma", a.ativo ? "ativo" : "inativo"].join(" · "),
    }));
  }

  if (!league) return [];
  const r = await league.procurarPerfis(q);
  return r.map((p) => ({
    id: p.id,
    rotulo: p.nome ?? "(sem nome)",
    detalhe: p.email ?? "sem e-mail",
  }));
}

/** Em que coluna da ficha mora o id de cada plataforma. */
const COLUNA_ID: Record<Plataforma, string> = {
  sponte: "sponte_aluno_id",
  presenca: "presenca_aluno_id",
  league: "league_user_id",
};

/**
 * Aponta a ficha para outro registro — ou desfaz o vínculo.
 *
 * **Não mexe nas plataformas.** Trocar o vínculo é dizer "era outra pessoa",
 * não "mude aquela pessoa": o aluno vinculado por engano continua como está
 * do outro lado. Desfazer o que foi escrito nele, se for o caso, é
 * "Desativar" — uma decisão separada e que precisa ser consciente.
 */
async function vincular(
  id: number, plataforma: Plataforma, alvo: string | null, ip: string | null,
) {
  const c = await repo.buscarCadastro(id);
  if (!c) return { ok: false, motivo: "nao_encontrado" };

  const coluna = COLUNA_ID[plataforma];
  const anterior = plataforma === "sponte" ? c.sponteAlunoId
    : plataforma === "presenca" ? c.presencaAlunoId
    : c.leagueUserId;

  // Numérico no Sponte e no Presença, uuid no League.
  let valor: string | number | null = null;
  if (alvo) {
    if (plataforma === "league") valor = alvo;
    else {
      const n = Number(alvo);
      if (!Number.isInteger(n) || n <= 0) return { ok: false, motivo: "id_invalido" };
      valor = n;
    }
  }

  const atualizado = await repo.atualizarCadastro(id, {
    [coluna]: valor,
    // O erro antigo deixa de valer: ele falava do vínculo que acabou de sair.
    ...(plataforma === "presenca" ? { presenca_erro: null } : {}),
    ...(plataforma === "league" ? { league_erro: null } : {}),
    ...(plataforma === "sponte" ? { sponte_erro: null } : {}),
  });

  repo.registrar({
    tipo: plataforma === "sponte" ? "sponte" : plataforma,
    operacao: valor ? "vincular" : "desvincular",
    cadastroId: id, ok: !!atualizado, ip,
    detalhe: { de: anterior ?? null, para: valor },
  });

  return { ok: !!atualizado, cadastro: atualizado, de: anterior ?? null, para: valor };
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

/**
 * Lê o corpo como JSON.
 *
 * Junta os pedaços como bytes e só então decodifica: concatenar em string
 * decodifica cada pedaço isolado, e um caractere acentuado que caia na
 * emenda entre dois pedaços vira lixo. Uma observação longa com "ação" no
 * lugar errado bastaria.
 */
function lerCorpo(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((res) => {
    const pedacos: Buffer[] = [];
    req.on("data", (c: Buffer) => pedacos.push(c));
    req.on("end", () => {
      const texto = Buffer.concat(pedacos).toString("utf8");
      try { res(JSON.parse(texto || "{}")); } catch { res({}); }
    });
  });
}

/* ------------------------------------------------------------------ *
 * Turma: do Sponte para as outras duas
 *
 * A turma existe primeiro no Sponte — é lá que a escola a cria, com curso,
 * plano e matrícula. Daqui ela é **espelhada** no Presença e no
 * LeagueInvest; nenhuma destas funções escreve no Sponte.
 * ------------------------------------------------------------------ */

/**
 * Leva ao Presença e ao LeagueInvest as turmas que o Sponte encerrou.
 *
 * O Sponte é a fonte da situação, mas não avisa ninguém quando ela muda —
 * não há webhook. Sem esta varredura, encerrar a turma lá não produzia
 * efeito nenhum até alguém lembrar de clicar no painel, e nesse meio-tempo
 * o aluno continuava na chamada e com o conteúdo liberado.
 *
 * **Só desliga, nunca religa.** Reabrir a turma no Sponte não reativa
 * sozinho: a turma pode ter sido desativada no Presença por outro motivo
 * — professor trocado, sala indefinida — e devolver o acesso por conta
 * própria desfaria uma decisão que alguém tomou de propósito. Religar é um
 * clique no painel, que já existe.
 *
 * A cascata sobre os alunos vem junto: desligar a turma e deixá-los ativos
 * dá o pior dos dois mundos — fora da chamada, mas ainda com o conteúdo.
 */
async function refletirTurmasEncerradas() {
  const encerradas = (await turmasComCache()).filter(turmaEncerrada);
  const mapa = await repo.mapaTurmas();

  let vistas = 0, desligadas = 0, alunos = 0;

  for (const t of encerradas) {
    const m = mapa[t.turmaId];
    // Turma encerrada que nunca foi espelhada não tem o que desligar.
    if (!m || (!m.presencaTurmaId && !m.leagueClassId)) continue;
    vistas++;

    // Ler antes de escrever: a esmagadora maioria já está desligada lá, e
    // reenviar a desativação a cada ciclo seria gastar duas chamadas por
    // turma para não mudar nada.
    const estado = await situacaoNasPlataformas(m);
    const precisa = estado.presenca.ativa === true || estado.league.ativa === true;
    if (!precisa) continue;

    const origem: TurmaOrigem = {
      turmaId: t.turmaId, nome: t.nome, curso: t.curso, cursoId: t.cursoId,
      dataInicio: t.dataInicio, dataTermino: t.dataTermino,
      professorRegente: t.professorRegente, situacao: t.situacao,
    };

    const r = await definirSituacaoTurma(origem, {
      presencaTurmaId: m.presencaTurmaId, leagueClassId: m.leagueClassId,
    }, false, { presenca, league });
    await gravarResultadoTurma(origem, r);
    desligadas++;

    const daTurma = await repo.alunosDaTurma(t.turmaId, "desativar");
    if (daTurma.length) {
      const c = await repo.registrarCascata(await cascataDeAlunos(
        daTurma, r.mapa, false, { presenca, league },
        `turma encerrada no Sponte`));
      alunos += c.ok;
    }

    repo.registrar({
      tipo: "sponte", operacao: "turma encerrada refletida", ok: r.ok,
      detalhe: {
        turmaId: t.turmaId, turma: t.nome,
        alunos: daTurma.length,
        resultados: r.resultados.map((x) => `${x.plataforma}: ${x.mensagem}`),
      },
      erro: r.ok ? null : r.resultados.filter((x) => !x.ok).map((x) => x.mensagem).join(" · "),
    });
  }

  return { encerradas: encerradas.length, vistas, desligadas, alunos };
}

/** Erro de pedido, para o 400/404 sair com a mensagem certa. */
class ErroDePedido extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ErroDePedido";
    this.status = status;
  }
}

/**
 * A turma do Sponte mais o que já sabemos dela, pelo id do Sponte.
 *
 * Vem do cache de turmas, não de uma chamada nova: a lista inteira custa uma
 * chamada SOAP e acabou de ser carregada para desenhar a tela.
 */
async function turmaParaEspelhar(
  sponteTurmaId: number,
): Promise<{ origem: TurmaOrigem; mapa: MapaTurma }> {
  const turma = (await turmasComCache()).find((t) => t.turmaId === sponteTurmaId);
  if (!turma) {
    throw new ErroDePedido(`A turma ${sponteTurmaId} não existe no Sponte.`, 404);
  }

  const mapa = await repo.mapaTurma(sponteTurmaId);
  return {
    origem: {
      turmaId: turma.turmaId,
      nome: turma.nome,
      curso: turma.curso,
      cursoId: turma.cursoId,
      dataInicio: turma.dataInicio,
      dataTermino: turma.dataTermino,
      professorRegente: turma.professorRegente,
      horario: turma.horario,
      situacao: turma.situacao,
    },
    mapa: {
      presencaTurmaId: mapa.presencaTurmaId,
      leagueClassId: mapa.leagueClassId,
    },
  };
}

/** Guarda o que a operação descobriu, para não ter que descobrir de novo. */
async function gravarResultadoTurma(origem: TurmaOrigem, r: ResultadoTurma) {
  if (!Object.keys(r.campos).length) return;
  await repo.gravarTurma(origem.turmaId, r.campos, {
    turmaNome: origem.nome,
    cursoNome: origem.curso,
    sponteCursoId: origem.cursoId,
  });
}

/**
 * Como a turma está, agora, em cada plataforma.
 *
 * Lê das plataformas em vez de confiar no que gravamos: alguém pode ter
 * desativado a turma direto no Presença, e a tela mostrando "ativa" porque
 * foi o que gravamos no mês passado é pior que não mostrar nada.
 */
async function situacaoNasPlataformas(mapa: {
  presencaTurmaId: number | null;
  leagueClassId: string | null;
  presencaErro?: string | null;
  leagueErro?: string | null;
}) {
  const [doPresenca, doLeague] = await Promise.all([
    mapa.presencaTurmaId
      ? presenca.buscarTurma(mapa.presencaTurmaId).catch(() => null)
      : Promise.resolve(null),
    mapa.leagueClassId && league
      ? league.buscarTurma(mapa.leagueClassId).catch(() => null)
      : Promise.resolve(null),
  ]);

  return {
    presenca: {
      id: mapa.presencaTurmaId,
      nome: doPresenca?.turma ?? null,
      ativa: doPresenca?.ativa ?? null,
      // Id gravado que não encontra a turma: alguém a apagou de lá.
      ausente: !!mapa.presencaTurmaId && !doPresenca,
      erro: mapa.presencaErro ?? null,
    },
    league: {
      id: mapa.leagueClassId,
      nome: doLeague?.nome ?? null,
      ativa: doLeague?.ativa ?? null,
      ligaNome: doLeague?.ligaNome ?? null,
      ausente: !!mapa.leagueClassId && !!league && !doLeague,
      erro: mapa.leagueErro ?? null,
      configurado: !!league,
    },
  };
}

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORTA}`);
  const rota = url.pathname;
  const comecou = Date.now();
  const ipCliente = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "") || null;

  // Registra ao fechar a resposta, não antes: só aí se sabe o status e o
  // tempo. Arquivo estático fica de fora — encheria a tabela de ruído sem
  // dizer nada sobre o que o sistema fez.
  res.on("finish", () => {
    if (!rota.startsWith("/api/")) return;
    repo.registrar({
      tipo: "http",
      operacao: `${req.method} ${rota}`,
      ok: res.statusCode < 400,
      duracaoMs: Date.now() - comecou,
      ip: ipCliente,
      detalhe: {
        status: res.statusCode,
        ...(url.search ? { consulta: url.search.slice(0, 300) } : {}),
      },
    });
  });

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

  const json = (corpo: unknown, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(corpo));
  };

  try {
    // ===== porteiro =====
    //
    // Tudo em /api que não estiver na lista de rotas do aluno exige um
    // usuário admin. A lista é de permissão explícita: esquecer de proteger
    // uma rota nova é acidente provável, e o custo é expor 500 cadastros.
    if (rota.startsWith("/api/") && !rotaPublica(req.method ?? "GET", rota)) {
      const token = Autenticacao.tokenDe(req.headers.authorization);
      const quem = await auth.identificar(token);

      if (!quem) {
        return json({ erro: "Faça login para continuar.", autenticar: true }, 401);
      }
      if (!quem.admin) {
        repo.registrar({
          tipo: "http", operacao: `NEGADO ${req.method} ${rota}`, ok: false,
          ip: ipCliente, erro: `${quem.email} tem papel "${quem.papel ?? "nenhum"}"`,
        });
        return json({
          erro: "Esta área é restrita a administradores.", papel: quem.papel,
        }, 403);
      }
    }

    /* --- O que o painel precisa para montar a tela de login --- */
    //
    // Só a URL e a chave pública: as duas já viajam para o navegador em
    // qualquer app Supabase, e sem elas o login não teria como acontecer
    // no cliente. A service role nunca sai daqui.
    if (rota === "/api/config-auth" && req.method === "GET") {
      return json({
        url: process.env.SUPABASE_URL,
        publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
      });
    }

    /* --- Quem está logado (o painel pergunta ao abrir) --- */
    if (rota === "/api/eu" && req.method === "GET") {
      const quem = await auth.identificar(Autenticacao.tokenDe(req.headers.authorization));
      return json({ nome: quem!.nome, email: quem!.email, papel: quem!.papel });
    }

    /* --- Estado da integração (o aviso de simulação vem daqui) --- */
    if (rota === "/api/estado") {
      // Esta rota é pública: o formulário do aluno a usa para o aviso de
      // ambiente de teste. Por isso o visitante recebe só o que a tela dele
      // precisa — código de cliente do ERP e estado das integrações são
      // informação interna, e não há motivo para entregá-los a quem abre o
      // link de matrícula.
      const quem = await auth.identificar(Autenticacao.tokenDe(req.headers.authorization));
      if (!quem?.admin) {
        return json({ escritaLiberada: ESCRITA_LIBERADA, modoTeste: MODO_TESTE });
      }
      return json({
        escritaLiberada: ESCRITA_LIBERADA, modoTeste: MODO_TESTE,
        codigoCliente: cred.codigoCliente, persistencia: "supabase",
        // O painel precisa saber: sem credenciais, o botão de ativar faz
        // metade do trabalho, e isso tem que aparecer antes do clique.
        leagueConfigurado: !!league,
      });
    }

    /* --- Catálogo do Sponte --- */
    if (rota === "/api/sponte/turmas") {
      const todas = await turmasComCache();
      const ano = url.searchParams.get("ano");
      const anoLetivo = ano ? Number(ano) : undefined;
      const turmas = url.searchParams.get("todas") === "1"
        ? (anoLetivo ? todas.filter((t) => t.anoLetivo === anoLetivo) : todas)
        : filtrarMatriculaveis(todas, { anoLetivo });

      return json({
        turmas, total: turmas.length, totalGeral: todas.length,
        anos: [...new Set(todas.map((t) => t.anoLetivo))].sort((a, b) => b - a),
        linksPorTurma: await repo.linksPorTurma(),
        // Quais já estão espelhadas nas outras duas. Vem tudo de uma vez: a
        // lista tem 49 turmas e perguntar uma por uma seria 49 idas ao banco.
        mapaTurmas: await repo.mapaTurmas(),
      });
    }

    if (rota === "/api/sponte/planos") {
      const cursoId = Number(url.searchParams.get("cursoId"));
      if (!Number.isInteger(cursoId) || cursoId <= 0) {
        return json({ erro: "cursoId obrigatório." }, 400);
      }
      const planos = await planosComCache(cursoId);
      return json({ planos, preferidoId: planoPreferido(planos)?.planoCursoId ?? null });
    }

    if (rota === "/api/sponte/bolsas") return json({ bolsas: await bolsasComCache() });

    if (rota === "/api/sponte/formas-pagamento") {
      const formas = await formasComCache();
      return json({
        formas: formas.map((f) => ({
          formaCobrancaId: f.formaCobrancaId, meio: f.meio,
          descricao: f.descricao, parcelas: parcelasPermitidas(f.meio!),
        })),
      });
    }

    /* --- O que sabemos de uma turma: links e quem respondeu --- */
    if (/^\/api\/turmas\/\d+\/detalhe$/.test(rota) && req.method === "GET") {
      const id = Number(rota.split("/")[3]);
      const [detalhe, turma] = await Promise.all([
        repo.detalheTurma(id),
        turmasComCache().then((ts) => ts.find((t) => t.turmaId === id) ?? null),
      ]);
      // A turma vem do Sponte e o resto do nosso banco: juntar aqui evita
      // duas chamadas e o risco de a tela mostrar metade de cada.
      const mapa = await repo.mapaTurma(id);
      return json({
        turma, ...detalhe,
        plataformas: await situacaoNasPlataformas(mapa),
        // A tela mostra, em vermelho, nome que não vai casar com as outras.
        nomePadronizado: turma ? !!lerNomeTurma(turma.nome) : null,
      });
    }

    /* --- Espelhar a turma do Sponte nas outras duas --- *
     *
     * O Sponte é a fonte: a turma nasce lá, com curso e plano, e estas
     * rotas só levam a mesma turma para o Presença e o LeagueInvest. Por
     * isso não existe rota que crie turma no Sponte.
     */

    if (/^\/api\/turmas\/\d+\/propagar$/.test(rota) && req.method === "POST") {
      const { origem, mapa } = await turmaParaEspelhar(Number(rota.split("/")[3]));
      const corpo = await lerCorpo(req);

      const r = await propagarTurma(origem, mapa, { presenca, league }, {
        criar: corpo.criar !== false,
        ligaId: typeof corpo.ligaId === "string" ? corpo.ligaId : null,
      });
      await gravarResultadoTurma(origem, r);
      return json(r);
    }

    if (/^\/api\/turmas\/\d+\/situacao$/.test(rota) && req.method === "POST") {
      const { origem, mapa } = await turmaParaEspelhar(Number(rota.split("/")[3]));
      const corpo = await lerCorpo(req);
      if (typeof corpo.ativa !== "boolean") {
        return json({ erro: "Informe `ativa` (true ou false)." }, 400);
      }

      const r = await definirSituacaoTurma(origem, mapa, corpo.ativa, { presenca, league });
      await gravarResultadoTurma(origem, r);

      // A cascata mexe em dezenas de alunos: só acontece quando pedida.
      let cascata = null;
      if (corpo.cascata === true) {
        const modo = corpo.ativa ? "ativar" : "desativar";
        const alunos = await repo.alunosDaTurma(origem.turmaId, modo);
        cascata = await repo.registrarCascata(
          await cascataDeAlunos(alunos, r.mapa, corpo.ativa, { presenca, league },
            corpo.ativa ? undefined : "turma desativada no painel"));
      }

      return json({ ...r, cascata });
    }

    if (/^\/api\/turmas\/\d+\/sincronizar$/.test(rota) && req.method === "POST") {
      const { origem, mapa } = await turmaParaEspelhar(Number(rota.split("/")[3]));
      const r = await sincronizarTurma(origem, mapa, { presenca, league });
      await gravarResultadoTurma(origem, r);
      return json(r);
    }

    /* --- Vincular à mão, quando a busca por nome deu ambígua --- */
    if (/^\/api\/turmas\/\d+\/vincular$/.test(rota) && req.method === "POST") {
      const { origem } = await turmaParaEspelhar(Number(rota.split("/")[3]));
      const corpo = await lerCorpo(req);

      const { campos, mensagens } = await vincularTurmaAMao({
        presencaTurmaId: corpo.presencaTurmaId ? Number(corpo.presencaTurmaId) : null,
        leagueClassId: corpo.leagueClassId ? String(corpo.leagueClassId) : null,
      }, { presenca, league });

      if (!Object.keys(campos).length) {
        return json({ erro: "Informe `presencaTurmaId` ou `leagueClassId`." }, 400);
      }
      await repo.gravarTurma(origem.turmaId, campos, {
        turmaNome: origem.nome, cursoNome: origem.curso, sponteCursoId: origem.cursoId,
      });
      return json({ ok: true, mensagens, campos });
    }

    /* --- Para quem vai escolher o vínculo à mão --- */
    if (rota === "/api/turmas/candidatas" && req.method === "GET") {
      const termo = (url.searchParams.get("termo") ?? "").trim();
      if (termo.length < 2) return json({ erro: "Busque por ao menos 2 letras." }, 400);

      const [doPresenca, doLeague] = await Promise.all([
        presenca.procurarTurmas(termo),
        // Sem League configurado a lista vem vazia, e a tela diz por quê.
        league ? league.procurarTurmas(termo) : Promise.resolve([]),
      ]);
      return json({ presenca: doPresenca, league: doLeague, leagueConfigurado: !!league });
    }

    /**
     * Força agora o reflexo das turmas encerradas no Sponte.
     *
     * O mesmo que o ciclo automático faz de 15 em 15 minutos. Existe para
     * quem acabou de encerrar a turma no Sponte e quer ver o efeito sem
     * esperar — e para conferir, depois, que o efeito aconteceu.
     */
    if (rota === "/api/turmas/refletir-encerradas" && req.method === "POST") {
      return json(await refletirTurmasEncerradas());
    }

    /** As ligas do LeagueInvest, para escolher onde a turma vai nascer. */
    if (rota === "/api/league/ligas" && req.method === "GET") {
      if (!league) return json({ ligas: [], leagueConfigurado: false });
      return json({ ligas: await league.ligas(), leagueConfigurado: true });
    }

    /* --- Links --- */
    if (rota === "/api/links" && req.method === "GET") {
      return json({ links: await repo.listarLinks() });
    }

    if (rota === "/api/links" && req.method === "POST") {
      const c = await lerCorpo(req);
      const cursoId = Number(c.cursoId);
      const planos = cursoId > 0 ? await planosComCache(cursoId) : [];
      const bolsas = await bolsasComCache();

      // Preço resolvido aqui, a partir dos ids: aceitar valor do navegador
      // deixaria o contrato editável pelo DevTools.
      const plano = c.planoCursoId
        ? planos.find((p) => p.planoCursoId === Number(c.planoCursoId)) ?? null
        : planoPreferido(planos);
      const bolsa = c.bolsaId
        ? bolsas.find((b) => b.bolsaId === Number(c.bolsaId)) ?? null
        : null;

      const link = await repo.criarLink({
        turmaId: Number(c.turmaId), cursoId,
        turmaNome: String(c.turmaNome ?? ""), cursoNome: String(c.cursoNome ?? ""),
        turmaTurno: String(c.turmaTurno ?? ""),
        limiteUsos: Math.max(1, Number(c.limiteUsos) || 1),
        diasValidade: Number(c.diasValidade) || 0,
        condicao: montarCondicao(plano, bolsa),
      });
      return json({ link });
    }

    if (rota.startsWith("/api/links/") && rota.endsWith("/revogar") && req.method === "POST") {
      return json({ ok: await repo.revogarLink(Number(rota.split("/")[3])) });
    }

    /* --- Lado público: sempre pelas funções security definer --- */
    if (rota.startsWith("/api/cadastro/") && req.method === "GET") {
      return json(await repo.lerLinkPorToken(decodeURIComponent(rota.split("/")[3] ?? "")));
    }

    // Rascunho: grava o que já foi preenchido, etapa a etapa. A função SQL só
    // lê as chaves que conhece, então o corpo passa direto.
    if (rota.startsWith("/api/rascunho/") && req.method === "POST") {
      const token = decodeURIComponent(rota.split("/")[3] ?? "");
      const { rascunhoId, ...dados } = await lerCorpo(req);
      return json(await repo.salvarRascunho(token, rascunhoId ? Number(rascunhoId) : null, dados));
    }

    if (rota.startsWith("/api/cadastro/") && req.method === "POST") {
      const token = decodeURIComponent(rota.split("/")[3] ?? "");
      const { rascunhoId, ...dados } = await lerCorpo(req);
      const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "") || null;
      return json(await repo.receberCadastro(
        token, rascunhoId ? Number(rascunhoId) : null, dados, ip));
    }

    /* --- Checkout: executa a sequência no Sponte e devolve o link --- */
    if (rota.startsWith("/api/checkout/") && req.method === "POST") {
      return json(await iniciarCheckout(Number(rota.split("/")[3])));
    }

    /* --- Checkout: o aluno já pagou? --- */
    if (rota.startsWith("/api/checkout/") && req.method === "GET") {
      return json(await conferirPagamento(Number(rota.split("/")[3])));
    }

    /* --- Vigia da cobrança: a régua gerou a fatura? --- */
    if (rota === "/api/cobranca/verificar" && req.method === "POST") {
      return json(await verificarCobrancas());
    }

    /* --- Alertas abertos para o time --- */
    if (rota === "/api/alertas" && req.method === "GET") {
      const alertas = await repo.alertasAbertos();
      return json({
        alertas, total: alertas.length,
        urgentes: alertas.filter((a) => a.alerta.urgente).length,
      });
    }

    /* --- Cadastro feito pelo painel, sem link --- */
    if (rota === "/api/cadastros/manual" && req.method === "POST") {
      const c = await lerCorpo(req);
      const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "") || null;
      return json(await cadastrarManual(c, ip));
    }

    /* --- Busca para vincular à mão --- */
    if (rota === "/api/procurar" && req.method === "GET") {
      const plataforma = url.searchParams.get("plataforma") as Plataforma | null;
      const termo = url.searchParams.get("q") ?? "";
      if (!plataforma || !COLUNA_ID[plataforma]) {
        return json({ erro: "plataforma deve ser sponte, presenca ou league." }, 400);
      }
      try {
        return json({ achados: await procurar(plataforma, termo) });
      } catch (e) {
        // Busca que falha não é erro do sistema: pode ser a conta do
        // LeagueInvest sem acesso, ou o Sponte fora do ar.
        return json({ achados: [], erro: (e as Error).message });
      }
    }

    /* --- Fila de validação --- */
    if (rota === "/api/cadastros" && req.method === "GET") {
      const q = url.searchParams;
      return json(await repo.listarCadastros({
        status: q.get("status") ?? undefined,
        turmaId: Number(q.get("turma")) || null,
        financeiro: q.get("financeiro") || null,
        // A ordem passa pelo mapa fechado do repo: o que vier aqui que não
        // estiver nele cai no padrão, em vez de virar `order=` arbitrário.
        ordem: (q.get("ordem") ?? undefined) as never,
        busca: q.get("busca") ?? undefined,
        limite: Number(q.get("limite")) || 200,
      }));
    }

    if (rota.startsWith("/api/cadastros/") && req.method === "POST") {
      const partes = rota.split("/");
      const id = Number(partes[3]);
      const acao = partes[4];
      const corpo = await lerCorpo(req);

      if (acao === "aprovar")  return json(await repo.mudarStatus(id, "aprovado", corpo.observacao));
      if (acao === "rejeitar") return json(await repo.mudarStatus(id, "rejeitado", corpo.observacao));
      if (acao === "reabrir")  return json(await repo.mudarStatus(id, "pendente", corpo.observacao));
      if (acao === "enviar")   return json(await iniciarCheckout(id));

      if (acao === "vincular" || acao === "desvincular") {
        const plataforma = corpo.plataforma as Plataforma;
        if (!COLUNA_ID[plataforma]) return json({ erro: "plataforma inválida." }, 400);
        const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "") || null;
        return json(await vincular(
          id, plataforma, acao === "vincular" ? String(corpo.id ?? "") : null, ip));
      }
      if (acao === "ativar")   return json(await ativacao(id, "ativar"));
      if (acao === "desativar") {
        return json(await ativacao(id, "desativar", corpo.motivo));
      }

      if (acao === "editar") {
        // Só os campos que a tela de validação pode corrigir.
        const campos: Record<string, unknown> = {};
        if (typeof corpo.nome === "string" && corpo.nome.trim()) campos.nome = corpo.nome.trim();
        if (typeof corpo.email === "string") campos.email = corpo.email.trim().toLowerCase() || null;
        if (typeof corpo.celular === "string") campos.celular = corpo.celular.replace(/\D/g, "") || null;
        if (typeof corpo.dataNascimento === "string") campos.data_nascimento = corpo.dataNascimento || null;
        if (typeof corpo.observacao === "string") campos.observacao = corpo.observacao || null;

        // Troca de condição comercial. Recalculada a partir dos ids, pelo mesmo
        // motivo da criação do link: preço não vem do navegador.
        if (corpo.planoCursoId !== undefined || corpo.bolsaId !== undefined) {
          const atual = await repo.buscarCadastro(id);
          if (!atual) return json({ ok: false, motivo: "nao_encontrado" });

          const planos = await planosComCache(atual.cursoId);
          const bolsas = await bolsasComCache();
          const idPlano = corpo.planoCursoId !== undefined
            ? Number(corpo.planoCursoId) : atual.planoCursoId;
          const idBolsa = corpo.bolsaId !== undefined
            ? Number(corpo.bolsaId) : atual.bolsaId;

          const cond = montarCondicao(
            planos.find((p) => p.planoCursoId === idPlano) ?? null,
            bolsas.find((b) => b.bolsaId === idBolsa) ?? null,
          );
          Object.assign(campos, {
            plano_curso_id: cond.planoCursoId, plano_descricao: cond.planoDescricao,
            bolsa_id: cond.bolsaId, bolsa_descricao: cond.bolsaDescricao,
            valor_parcela: cond.valorParcela, parcelas: cond.parcelas,
            valor_total: cond.valorTotal, valor_parcela_cheia: cond.valorParcelaCheia,
          });
        }

        if (!Object.keys(campos).length) return json({ ok: false, motivo: "nada_a_mudar" });
        const c = await repo.atualizarCadastro(id, campos);
        return json({ ok: !!c, cadastro: c });
      }

      return json({ erro: "Ação desconhecida." }, 400);
    }

    /* --- Estáticos --- */
    const pedido = rota === "/" ? "/admin-turmas.html" : rota;
    const alvo = resolve(join(RAIZ, normalize(decodeURIComponent(pedido))));
    // Sem isto, `/../../.env` serviria o arquivo de credenciais.
    if (!alvo.startsWith(RAIZ + sep) && alvo !== RAIZ) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("Fora da raiz");
      return;
    }
    const conteudo = await readFile(alvo);
    res.writeHead(200, {
      "Content-Type": TIPOS[extname(alvo).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(conteudo);
  } catch (erro) {
    if ((erro as NodeJS.ErrnoException)?.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404");
      return;
    }
    // Pedido malformado ou turma que não existe: a culpa não é do Sponte, e
    // responder 502 mandaria a tela dizer "serviço fora" para um id errado.
    if (erro instanceof ErroDePedido) {
      json({ erro: erro.message }, erro.status);
      return;
    }
    const msg = erro instanceof SponteError ? `${erro.tipo}: ${erro.message}` : String(erro);
    console.error("  ✖", msg);
    json({ erro: msg }, 502);
  }
});

/**
 * Vigia periódico.
 *
 * De 15 em 15 minutos: lê o estado das cobranças em aberto no Sponte e decide
 * se alguém precisa ser chamado. É o substituto do webhook que o Sponte não
 * tem — e é por isso que existe uma espera entre o aluno pagar e o sistema
 * saber.
 *
 * ⚠️ Em produção isto vira um cron (Supabase scheduled function), não um
 * setInterval: um processo que cai leva o vigia junto.
 */
const INTERVALO_VIGIA_MS = 15 * 60_000;

if (ESCRITA_LIBERADA) {
  setInterval(() => {
    verificarCobrancas()
      .then((r) => {
        if (!r.emAberto) return;
        console.log(`  [vigia] ${r.verificados} verificado(s) · ${r.pagos} pago(s) · ${r.novosAlertas} alerta(s)`);
      })
      .catch((e) => console.error(`  [vigia] falhou: ${e.message}`));
  }, INTERVALO_VIGIA_MS).unref();
}

/**
 * Reflexo da situação da turma, no mesmo ritmo do vigia.
 *
 * Roda mesmo com a escrita no Sponte desligada: isto **não escreve no
 * Sponte**, só lê de lá e desliga nas outras duas. E é justamente o caso em
 * que não agir deixa aluno com acesso que a escola já tirou.
 */
setInterval(() => {
  refletirTurmasEncerradas()
    .then((r) => {
      if (!r.desligadas) return;
      console.log(`  [turmas] ${r.desligadas} turma(s) encerrada(s) no Sponte ` +
                  `desligada(s) nas plataformas · ${r.alunos} aluno(s) afetado(s)`);
    })
    .catch((e) => console.error(`  [turmas] falhou: ${e.message}`));
}, INTERVALO_VIGIA_MS).unref();

servidor.listen(PORTA, () => {
  console.log(`\n  Servidor de desenvolvimento no ar.\n`);
  console.log(`    Turmas   http://localhost:${PORTA}/admin-turmas.html`);
  console.log(`    Alunos   http://localhost:${PORTA}/admin-alunos.html`);
  console.log(`\n  Dados:   Supabase (${process.env.SUPABASE_URL})`);
  console.log(`  Sponte:  cliente ${cred.codigoCliente}`);

  if (!ESCRITA_LIBERADA) {
    console.log(`\n  Escrita no Sponte DESLIGADA — o checkout roda em simulação.\n`);
    return;
  }
  const barra = "!".repeat(68);
  console.log(`\n  ${barra}`);
  console.log(`  ESCRITA NO SPONTE LIGADA — cliente ${cred.codigoCliente} (PRODUÇÃO)`);
  console.log(MODO_TESTE
    ? `  Registros nascem com o prefixo "TESTE-SISTEMA".`
    : `  *** SEM MARCAÇÃO *** os registros se misturam aos reais.`);
  console.log(`  Não há exclusão na API: o que for criado sai pela interface.`);
  console.log(`  Ao terminar:  node --env-file=.env scripts/limpar-testes.ts`);
  console.log(`  ${barra}\n`);
});
