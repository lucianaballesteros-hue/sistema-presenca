/**
 * O cérebro do cadastro online: configuração, regras e o tratador HTTP.
 *
 * Este módulo **não escolhe onde roda**. Ele exporta `tratar(req, res)`, e
 * quem o chama decide: o servidor de desenvolvimento (`servidor-local.ts`)
 * ou a função da Vercel (`api/[...rota].ts`). Os dois caminhos executam
 * exatamente o mesmo código — foi para isso que ele saiu de dentro do
 * `createServer`.
 *
 * ⚠️ O estado de módulo (caches do catálogo, sessão do Sponte, fila) vive
 * enquanto o processo viver. No servidor local isso é a execução inteira;
 * em função sem servidor, é só enquanto a instância estiver quente. Nada
 * aqui depende disso para estar **correto** — só para ser rápido.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  chamarSoap, credenciais, credenciaisDoAmbiente, type CredenciaisSponte,
  SponteError,
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
  pagamentoConfirmado, type ProgressoMatricula,
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
  cascataDeAlunos, definirSituacaoTurma, propagarTurma, sincronizarTurma,
  TETO_CASCATA_AUTOMATICA, vincularTurmaAMao,
  type MapaTurma, type ResultadoTurma, type TurmaOrigem,
} from "../supabase/functions/_shared/turma-plataformas.ts";
import { lerNomeTurma } from "../supabase/functions/_shared/turma-nome.ts";
import { Autenticacao, cronAutorizado, rotaPublica } from "./autenticacao.ts";
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

/**
 * Base para montar o `URL` do pedido. O host não importa: só os caminhos e
 * a query são lidos. Um valor fixo evita depender de cabeçalho de proxy.
 */
const BASE_URL = "http://interno";

/**
 * A Edge Function que fala com o Sponte.
 *
 * Montada a partir da URL do projeto, não configurada à parte: são o
 * mesmo projeto, e duas variáveis que precisam concordar acabam
 * discordando.
 */
const URL_CHECKOUT = process.env.SUPABASE_URL
  ? `${process.env.SUPABASE_URL}/functions/v1/sponte-checkout`
  : null;

/**
 * As credenciais do Sponte, resolvidas só quando alguém precisa delas.
 *
 * Antes isto era uma `const` no topo do módulo, e `credenciaisDoAmbiente`
 * **lança** quando falta a chave. O efeito em produção era total: a função
 * inteira morria na importação, e `/api/config-auth` — que nem toca no
 * Sponte — respondia `FUNCTION_INVOCATION_FAILED`. Ou seja, uma variável
 * de ambiente esquecida tirava a tela de login do ar junto.
 *
 * Adiando para o uso, quem não depende do Sponte funciona; quem depende
 * falha sozinho, com a mensagem certa, e só naquela rota.
 */
let credCache: CredenciaisSponte | null = null;
function credSponte(): CredenciaisSponte {
  credCache ??= credenciaisDoAmbiente({ get: (c: string) => process.env[c] });
  return credCache;
}

/** Há chave do Sponte configurada? Para a tela avisar em vez de quebrar. */
const SPONTE_CONFIGURADO = !!process.env.SPONTE_KEY && !!process.env.SPONTE_CODIGO_CLIENTE;

/**
 * O que falta no ambiente para o sistema sequer começar.
 *
 * Sem o Supabase não há login, não há banco, não há nada — e uma lista
 * vazia devolvida pelo `/api/config-auth` faria o navegador falhar depois,
 * em outro lugar, com outra mensagem. Melhor dizer aqui, com nome e
 * sobrenome, o que precisa ser configurado.
 *
 * Calculado uma vez, sem lançar: este módulo não pode morrer na importação
 * por causa de configuração — foi assim que a tela de login caiu junto.
 */
const ESSENCIAIS = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
] as const;
const FALTANDO = ESSENCIAIS.filter((v) => !process.env[v]);

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

/*
 * A sessão da interface web do Sponte **não** mora mais aqui.
 *
 * Ela vive na Edge Function `sponte-checkout`, junto com a chave do ERP:
 * esta aplicação não escreve no Sponte, e por isso não precisa — nem deve
 * — ter credencial para isso. Ver `docs/API-SPONTE.md` §9.9 sobre por que
 * a geração do link depende da tela.
 */

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
  const dados = await getTurmas(credSponte(), {}, { timeoutMs: 90_000 });
  cacheTurmas = { quando: Date.now(), dados };
  return dados;
}

async function planosComCache(cursoId: number): Promise<PlanoCurso[]> {
  const hit = cachePlanos.get(cursoId);
  if (hit && Date.now() - hit.quando < CACHE_COMERCIAL_MS) return hit.dados;
  const dados = await getPlanosCurso(credSponte(), cursoId, { timeoutMs: 60_000 });
  cachePlanos.set(cursoId, { quando: Date.now(), dados });
  return dados;
}

async function bolsasComCache(): Promise<Bolsa[]> {
  if (cacheBolsas && Date.now() - cacheBolsas.quando < CACHE_COMERCIAL_MS) return cacheBolsas.dados;
  const dados = await getBolsas(credSponte(), { timeoutMs: 60_000 });
  cacheBolsas = { quando: Date.now(), dados };
  return dados;
}

async function formasComCache(): Promise<FormaCobranca[]> {
  if (cacheFormas && Date.now() - cacheFormas.quando < CACHE_COMERCIAL_MS) return cacheFormas.dados;
  const dados = formasOferecidas(await getFormasCobranca(credSponte(), { timeoutMs: 60_000 }));
  cacheFormas = { quando: Date.now(), dados };
  return dados;
}

/**
 * Retrato comercial a partir de um plano e uma bolsa escolhidos.
 *
 * ⚠️ `valorTotal` é **só a mensalidade**, não o contrato inteiro.
 *
 * Quem consome esse campo o divide pelo número de parcelas para chegar ao
 * valor de cada mensalidade — a função SQL do envio, o repositório e o
 * formulário, todos. Enquanto ele carregava `plano.total`, as outras três
 * rubricas entravam nessa divisão: uma taxa de matrícula de R$ 300 virava
 * R$ 25 a mais em cada uma das 12 mensalidades, sem erro e sem aviso.
 *
 * Nunca mordeu porque os cinco planos da escola estão com matrícula,
 * material e "outros" zerados. SPEC-002 RN-06.
 */
function montarCondicao(plano: PlanoCurso | null, bolsa: Bolsa | null) {
  if (!plano) {
    return {
      planoCursoId: null, planoDescricao: null, bolsaId: null, bolsaDescricao: null,
      valorParcela: null, parcelas: null, valorTotal: null, valorParcelaCheia: null,
      valorTaxa: null, parcelasTaxa: null,
    };
  }
  const c = aplicarBolsa(plano, bolsa);
  const temTaxa = plano.matricula.valorParcela > 0 && plano.matricula.parcelas > 0;

  return {
    planoCursoId: plano.planoCursoId,
    planoDescricao: plano.descricao,
    bolsaId: bolsa?.bolsaId ?? null,
    bolsaDescricao: bolsa?.descricao ?? null,
    valorParcela: c.valorParcela,
    parcelas: c.parcelas,
    valorTotal: c.totalMensalidades,
    valorParcelaCheia: c.descontoAplicado > 0 ? c.valorParcelaCheia : null,

    // A taxa vem do plano do Sponte, nunca da tela (SPEC-002 RN-02). A
    // bolsa não a toca: incide sobre a mensalidade, e mesmo isso é
    // suposição não confirmada — ver a nota em `aplicarBolsa`.
    valorTaxa: temTaxa ? plano.matricula.valorParcela : null,
    parcelasTaxa: temTaxa ? plano.matricula.parcelas : null,
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
/**
 * A recusa do checkout: a mesma, sempre.
 *
 * Idêntica exista a ficha ou não, seja o segredo inválido ou de outra
 * ficha. Distinguir os casos entregaria um oráculo para descobrir quais
 * ids existem — e eles são sequenciais.
 */
const RECUSA_CHECKOUT = { ok: false, motivo: "nao_encontrado" } as const;

/**
 * Esta requisição deve ser barrada? `true` recusa.
 *
 * Devolve só a decisão, não a resposta: `json` é uma closure de `tratar`
 * e não existe aqui fora.
 *
 * O id sozinho nunca basta. `alunos_staging.id` é sequencial: com ele
 * valendo como credencial, um laço de `curl` sobre 1..2000 disparava a
 * matrícula de fichas alheias no Sponte — inclusive das **rejeitadas** —,
 * e o Sponte não tem exclusão por API. Duas chaves são aceitas:
 *
 *   - `token_acesso`, o segredo que o envio do formulário devolveu uma vez
 *     àquele navegador (cabeçalho `X-Cadastro-Token` ou `?t=`);
 *   - uma sessão de administrador, para o painel disparar à mão.
 *
 * A recusa é sempre a mesma, com o mesmo texto, exista a ficha ou não:
 * distinguir "não existe" de "não é seu" entregaria um oráculo para
 * enumerar quais ids existem.
 */
async function barrarCheckout(
  req: IncomingMessage,
  id: number,
): Promise<boolean> {
  if (!Number.isInteger(id) || id <= 0) return true;

  const url = new URL(req.url ?? "/", BASE_URL);
  const apresentado = (
    (req.headers["x-cadastro-token"] as string | undefined)
    ?? url.searchParams.get("t")
    ?? ""
  ).trim();

  if (apresentado) {
    const dono = await repo.cadastroDoToken(apresentado);
    // Token válido de OUTRA ficha não vale aqui — e não ganha resposta
    // diferente de token inválido.
    return dono !== id;
  }

  // Sem segredo, só com sessão de admin.
  const quem = await auth.identificar(Autenticacao.tokenDe(req.headers.authorization));
  return !quem?.admin;
}

/**
 * Encaminha o checkout à Edge Function, que é quem fala com o ERP.
 *
 * Esta aplicação **não** escreve no Sponte. Ela confere quem está pedindo
 * (`barrarCheckout`) e repassa; a Edge Function confere de novo, com o
 * banco à mão, e só então escreve. A dupla conferência é de propósito:
 * se esta camada fosse comprometida, ainda assim não conseguiria
 * matricular uma ficha que não pode ser matriculada.
 *
 * O segredo da ficha viaja no corpo porque é o que a função espera; a
 * sessão de admin viaja no cabeçalho, como em qualquer outra chamada.
 */
async function chamarCheckout(
  id: number,
  quem: { autorizacao?: string; tokenFicha?: string; acao?: "promover" },
): Promise<{ status: number; corpo: any }> {
  if (!URL_CHECKOUT) {
    return {
      status: 503,
      corpo: {
        ok: false, motivo: "checkout_indisponivel",
        erro: "SUPABASE_URL não está configurado: sem ele não há como "
          + "alcançar a função que fala com o Sponte.",
      },
    };
  }

  const r = await fetch(URL_CHECKOUT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // A chave pública identifica o projeto; quem autoriza é o que vai
      // abaixo. Sem ela o gateway do Supabase recusa antes da função.
      apikey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
      ...(quem.autorizacao ? { Authorization: quem.autorizacao } : {}),
    },
    body: JSON.stringify({
      cadastroId: id,
      tokenAcesso: quem.tokenFicha || undefined,
      ...(quem.acao ? { acao: quem.acao } : {}),
    }),
    // A sequência no Sponte é longa e ainda abre a tela de geração de link.
    signal: AbortSignal.timeout(280_000),
  });

  const texto = await r.text();
  try {
    return { status: r.status, corpo: JSON.parse(texto) };
  } catch {
    return {
      status: 502,
      corpo: { ok: false, motivo: "resposta_invalida", erro: texto.slice(0, 300) },
    };
  }
}

/**
 * Situações em que a ficha pode virar matrícula no Sponte.
 *
 * `pendente` é o estado logo após o envio do formulário — é o caso normal.
 * `aprovado` é a conferência manual. Fora disso não se grava no ERP:
 * `rejeitado` foi recusado por alguém, `rascunho` nem foi enviado, e
 * `enviado`/`erro` já passaram por aqui.
 *
 * A guarda é no servidor, e não só na tela, porque o checkout é a única
 * escrita irreversível do sistema: o Sponte não apaga por API.
 */
const STATUS_PODE_MATRICULAR = new Set(["pendente", "aprovado"]);


/**
 * Verifica se a parcela foi paga e promove a matrícula.
 *
 * Polling porque o WSDL não expõe webhook — está na lista de perguntas para a
 * Sponte. É o que faz o aluno esperar entre pagar e entrar na turma.
 */
async function conferirPagamento(
  id: number, quem: { autorizacao?: string; tokenFicha?: string } = {},
) {
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
    credSponte(), p.contaReceberId, p.numeroParcela ?? "1", p.sponteAlunoId ?? 0,
    { timeoutMs: 90_000 },
  );
  if (!r.pago) return { ok: true, pago: false, link: c.pagamentoLink ?? null };

  const campos: Record<string, unknown> = {
    pagamento_status: "pago",
    pagamento_confirmado_em: new Date().toISOString(),
  };

  // Pago: promove a pré-matrícula para Cursando. É escrita no ERP, então
  // vai pela mesma porta — esta aplicação não tem a chave do Sponte.
  //
  // Se a promoção falhar, o pagamento continua registrado: perder a
  // confirmação por causa disso seria pior que o erro.
  if (p.contratoId) {
    try {
      const r = await chamarCheckout(id, { ...quem, acao: "promover" });
      if (r.corpo?.ok === false && r.corpo?.erro) {
        campos.sponte_erro =
          `Pagamento confirmado, mas a matrícula não foi ativada: ${r.corpo.erro}`;
      }
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
export async function verificarCobrancas() {
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
          credSponte(), p.sponteAlunoId!, p.contaReceberId, p.numeroParcela ?? "1",
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
async function cadastrarManual(
  c: Record<string, any>, ip: string | null, autorizacao?: string,
) {
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
  // Mesma porta do formulário: a escrita no ERP tem um caminho só.
  const checkout = (await chamarCheckout(ficha.id, { autorizacao })).corpo;
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
      [...credenciais(credSponte()), ["sParametrosBusca", filtro]],
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
export async function refletirTurmasEncerradas() {
  const encerradas = (await turmasComCache()).filter(turmaEncerrada);
  const mapa = await repo.mapaTurmas();

  let vistas = 0, desligadas = 0, alunos = 0, barradas = 0;

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
        `turma encerrada no Sponte`,
        // Teto só aqui: isto roda sozinho, sem ninguém olhando.
        { teto: TETO_CASCATA_AUTOMATICA }));

      if (c.barrada) {
        barradas++;
        console.warn(`  [turmas] ⚠ "${t.nome}": ${c.motivo}`);
        repo.registrar({
          tipo: "sponte", operacao: "cascata barrada pelo teto", ok: false,
          erro: c.motivo,
          detalhe: { turmaId: t.turmaId, turma: t.nome, alunos: c.total },
        });
      }
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

  return { encerradas: encerradas.length, vistas, desligadas, alunos, barradas };
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

/**
 * Trata um pedido HTTP. É todo o sistema, menos a decisão de onde rodar.
 *
 * Recebe `req`/`res` do Node porque é o que tanto o `http.createServer`
 * quanto as funções da Vercel entregam — nenhum adaptador no meio.
 */
/**
 * O IP de quem fez o pedido, de verdade.
 *
 * Atrás de proxy — que é como o sistema roda em produção —
 * `socket.remoteAddress` é o endereço do próprio proxy, igual para todo
 * mundo. O IP real vem no cabeçalho, e **o primeiro da lista** é o do
 * cliente: os seguintes são os saltos intermediários.
 *
 * ⚠️ O cabeçalho é falsificável por quem fala direto com a origem. Aqui
 * ele serve para registro e para o aceite dos termos, não para decidir
 * acesso — quem decide acesso é o porteiro, com o token.
 */
function ipDoPedido(req: IncomingMessage): string | null {
  const encaminhado = req.headers["x-forwarded-for"];
  const bruto = Array.isArray(encaminhado) ? encaminhado[0] : encaminhado;
  const primeiro = bruto?.split(",")[0]?.trim();
  return (primeiro || req.socket?.remoteAddress || "").replace(/^::ffff:/, "") || null;
}

export async function tratar(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", BASE_URL);
  const rota = url.pathname;
  const comecou = Date.now();
  const ipCliente = ipDoPedido(req);

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
      // Faltando o essencial, o honesto é dizer o quê. Devolver `undefined`
      // deixaria o navegador quebrar adiante, longe da causa.
      if (FALTANDO.length) {
        return json({
          erro: "O ambiente não está configurado.",
          faltando: FALTANDO,
          comoResolver: "Na Vercel: Settings → Environment Variables, "
            + "ambiente Production. A lista completa está em docs/DEPLOY.md.",
        }, 503);
      }
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

    /* --- Os ciclos periódicos, chamados pelo cron da plataforma --- *
     *
     * Em desenvolvimento quem os dispara é o `setInterval` do
     * `servidor-local.ts`, sem passar por aqui. Em produção é a Vercel,
     * por HTTP, e aí precisa de porta — com segredo próprio, porque o
     * agendador não tem sessão de admin para apresentar.
     */
    // GET porque é como o cron da Vercel chama; POST para disparar à mão.
    if (rota === "/api/ciclos" && (req.method === "GET" || req.method === "POST")) {
      if (!cronAutorizado(req.headers.authorization, process.env.CRON_SECRET)) {
        // Sem detalhe: dizer "falta CRON_SECRET" contaria a quem sondou o
        // endereço exatamente o que falta para ele entrar.
        return json({ erro: "Não autorizado." }, 401);
      }

      const só = url.searchParams.get("ciclo");
      const alvos = só ? ciclos.filter((c) => c.nome === só) : ciclos;
      if (!alvos.length) return json({ erro: `Ciclo "${só}" não existe.` }, 404);

      // Um ciclo que falha não impede o seguinte: são independentes, e
      // perder os dois porque um quebrou seria pior.
      const resultados = await Promise.all(alvos.map(async (c) => {
        const t0 = Date.now();
        try {
          const linha = await c.executar();
          repo.registrar({
            tipo: "vigia", operacao: `ciclo ${c.nome}`, ok: true,
            duracaoMs: Date.now() - t0, detalhe: { resumo: linha },
          });
          return { ciclo: c.nome, ok: true, resumo: linha };
        } catch (e) {
          const erro = (e as Error).message;
          repo.registrar({
            tipo: "vigia", operacao: `ciclo ${c.nome}`, ok: false,
            duracaoMs: Date.now() - t0, erro,
          });
          return { ciclo: c.nome, ok: false, erro };
        }
      }));

      return json({ ok: resultados.every((r) => r.ok), resultados });
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
        codigoCliente: codigoClienteSponte(), persistencia: "supabase",
        sponteConfigurado: SPONTE_CONFIGURADO,
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
      const ip = ipDoPedido(req);
      return json(await repo.receberCadastro(
        token, rascunhoId ? Number(rascunhoId) : null, dados, ip));
    }

    /* --- Checkout: executa a sequência no Sponte e devolve o link --- *
     *
     * Público por necessidade: o aluno chama esta rota logo depois de
     * enviar o formulário, e ele não tem sessão. Mas o id **não autoriza**
     * — é sequencial, e o vizinho está a um número de distância. Quem
     * autoriza é o segredo que o envio devolveu, ou uma sessão de admin.
     */
    if (rota.startsWith("/api/checkout/") && req.method === "POST") {
      const id = Number(rota.split("/")[3]);
      if (await barrarCheckout(req, id)) return json(RECUSA_CHECKOUT, 404);

      // A escrita no ERP não acontece aqui. Esta aplicação encaminha para
      // a Edge Function `sponte-checkout`, que é a única que tem a chave
      // do Sponte — e que refaz a autorização por conta própria.
      const r = await chamarCheckout(id, {
        autorizacao: req.headers.authorization as string | undefined,
        tokenFicha: ((req.headers["x-cadastro-token"] as string | undefined)
          ?? url.searchParams.get("t") ?? "").trim(),
      });
      return json(r.corpo, r.status);
    }

    /* --- Checkout: o aluno já pagou? --- */
    if (rota.startsWith("/api/checkout/") && req.method === "GET") {
      const id = Number(rota.split("/")[3]);
      if (await barrarCheckout(req, id)) return json(RECUSA_CHECKOUT, 404);
      return json(await conferirPagamento(id, {
        autorizacao: req.headers.authorization as string | undefined,
        tokenFicha: ((req.headers["x-cadastro-token"] as string | undefined)
          ?? url.searchParams.get("t") ?? "").trim(),
      }));
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
      const ip = ipDoPedido(req);
      return json(await cadastrarManual(
        c, ip, req.headers.authorization as string | undefined));
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
      if (acao === "enviar") {
        // Pela mesma porta do formulário: a escrita no ERP tem um caminho só.
        const r = await chamarCheckout(id, {
          autorizacao: req.headers.authorization as string | undefined,
        });
        return json(r.corpo, r.status);
      }

      if (acao === "vincular" || acao === "desvincular") {
        const plataforma = corpo.plataforma as Plataforma;
        if (!COLUNA_ID[plataforma]) return json({ erro: "plataforma inválida." }, 400);
        const ip = ipDoPedido(req);
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

    // Chegou aqui: nenhuma rota reconheceu o pedido. Os arquivos da tela
    // não passam por aqui — quem os serve é a plataforma, em produção, e o
    // servidor de desenvolvimento, na máquina.
    return json({ erro: `Rota desconhecida: ${req.method} ${rota}` }, 404);
  } catch (erro) {
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
}

/* ------------------------------------------------------------------ *
 * Ciclos periódicos
 *
 * O Sponte não tem webhook: nem para pagamento, nem para turma encerrada.
 * Tudo que o sistema sabe sobre mudança lá vem de perguntar de tempos em
 * tempos. Esta lista é a única definição desses ciclos — o servidor local
 * os roda em `setInterval`, a produção os chama por cron da Vercel. Dois
 * agendadores, uma lista.
 *
 * `executar` devolve a linha a registrar, ou `null` quando não houve nada
 * digno de nota. Ciclo silencioso é o caso comum e não deve virar ruído.
 * ------------------------------------------------------------------ */

export const INTERVALO_CICLOS_MS = 15 * 60_000;

export interface Ciclo {
  nome: string;
  intervaloMs: number;
  executar(): Promise<string | null>;
}

export const ciclos: Ciclo[] = [
  {
    nome: "vigia",
    intervaloMs: INTERVALO_CICLOS_MS,
    async executar() {
      // Sem escrita liberada não há cobrança para acompanhar: o checkout
      // roda em simulação e nada chegou ao Sponte.
      if (!ESCRITA_LIBERADA) return null;
      const r = await verificarCobrancas();
      if (!r.emAberto) return null;
      return `[vigia] ${r.verificados} verificado(s) · ${r.pagos} pago(s) · ` +
             `${r.novosAlertas} alerta(s)`;
    },
  },
  {
    nome: "turmas",
    intervaloMs: INTERVALO_CICLOS_MS,
    async executar() {
      // Roda mesmo com a escrita no Sponte desligada: isto não escreve lá,
      // só lê e desliga nas outras duas. É justamente o caso em que não
      // agir deixa aluno com acesso que a escola já tirou.
      const r = await refletirTurmasEncerradas();
      if (!r.desligadas && !r.barradas) return null;
      return `[turmas] ${r.desligadas} encerrada(s) desligada(s) · ` +
             `${r.alunos} aluno(s) afetado(s)` +
             (r.barradas ? ` · ${r.barradas} barrada(s) pelo teto` : "");
    },
  },
];

/**
 * O código de cliente em uso, para o banner do servidor local.
 *
 * Função, e não `const`: avaliada na importação, ela lançaria quando a
 * chave do Sponte faltasse — exatamente o que derrubava a função inteira.
 */
export function codigoClienteSponte(): string | null {
  try { return String(credSponte().codigoCliente); } catch { return null; }
}
export const escritaLiberada = ESCRITA_LIBERADA;
export const modoTeste = MODO_TESTE;
