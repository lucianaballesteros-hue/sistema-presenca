/**
 * `sponte-checkout` — a **única** porta que escreve no ERP.
 *
 * Matrícula, contrato, plano, mensalidades e link de pagamento nascem
 * daqui e de nenhum outro lugar. O Sponte não tem exclusão por API: o que
 * entra errado sai a mão, pela interface deles, um registro por vez. Uma
 * operação assim merece uma porta só, e esta é ela.
 *
 * O que isso muda, na prática:
 *
 *   - `SPONTE_KEY` e o login da interface web vivem **só** nos secrets do
 *     Supabase. A aplicação na Vercel não os tem e não pode falar com o
 *     ERP por conta própria;
 *   - a autorização é refeita **aqui**, com o banco à mão, e não confiada
 *     a quem chamou. Mesmo que a aplicação da frente fosse comprometida,
 *     ela não consegue matricular uma ficha que não pode ser matriculada.
 *
 * Contrato:
 *
 *     POST /functions/v1/sponte-checkout
 *     { "cadastroId": 123, "tokenAcesso": "a1b2…" }   ← o aluno
 *     Authorization: Bearer <jwt de admin>            ← ou o painel
 *
 *     200 → { ok, link, aguardandoFatura, jaExistia, … }
 *     401 → sem credencial válida para esta ficha
 *     409 → a ficha não está em situação de ser cobrada
 *     502 → o Sponte recusou ou não respondeu
 *
 * ⚠️ Esta função **não** usa `verify_jwt` da plataforma: o aluno chega
 * sem sessão, com o segredo da própria ficha. A verificação é feita no
 * corpo da função, e nunca é dispensada.
 */

import {
  AutorizacaoError,
  cabecalhosCors,
  exigirPapel,
  origensDoAmbiente,
  respostaJson,
} from "../_shared/auth.ts";
import { credenciaisDoAmbiente, SponteError } from "../_shared/soap.ts";
import { promoverMatricula } from "../_shared/matricula.ts";
import { executarCheckout, type FichaParaCheckout } from "../_shared/checkout.ts";
import { getTurmas } from "../_shared/turmas.ts";
import { credenciaisWebDoAmbiente, SponteWeb } from "../_shared/sponte-web.ts";

const env = { get: (c: string) => Deno.env.get(c) };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ESCRITA_LIBERADA = Deno.env.get("SPONTE_ESCRITA") === "1";
const MODO_TESTE = ESCRITA_LIBERADA && Deno.env.get("SPONTE_MODO_TESTE") !== "0";

/**
 * Sessão da interface web, reaproveitada enquanto a instância viver.
 *
 * Cada login custa duas páginas. Em função sem servidor a instância é
 * reciclada sozinha, então isto é só uma economia oportunista — nada
 * depende dela para estar correto.
 */
const cfgWeb = credenciaisWebDoAmbiente(env);
const web = cfgWeb ? new SponteWeb(cfgWeb) : null;

/* ------------------------------------------------------------------ *
 * Banco, com a chave de serviço
 * ------------------------------------------------------------------ */

async function rest<T>(caminho: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${caminho}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!r.ok) throw new Error(`banco ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const texto = await r.text();
  return (texto ? JSON.parse(texto) : null) as T;
}

/** Registra o que aconteceu. Nunca lança e nunca espera. */
function registrar(e: Record<string, unknown>): void {
  rest("auditoria", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      tipo: e.tipo, operacao: String(e.operacao).slice(0, 200),
      cadastro_id: e.cadastroId ?? null, ok: e.ok ?? null,
      duracao_ms: e.duracaoMs ?? null, detalhe: e.detalhe ?? {},
      erro: e.erro ? String(e.erro).slice(0, 1000) : null,
    }),
  }).catch(() => { /* auditoria que derruba a operação é pior que nenhuma */ });
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function paraFicha(c: Record<string, any>): FichaParaCheckout {
  return {
    id: c.id, status: c.status, nome: c.nome, cpf: c.cpf,
    dataNascimento: c.data_nascimento, email: c.email, celular: c.celular,
    sexo: c.sexo, rg: c.rg, estadoCivil: c.estado_civil,
    nacionalidade: c.nacionalidade, cidadeNatal: c.cidade_natal,
    profissao: c.profissao, telefone: c.telefone,
    cep: c.cep, endereco: c.endereco, numeroEndereco: c.numero_endereco,
    complemento: c.complemento, bairro: c.bairro, cidade: c.cidade, uf: c.uf,
    origemVenda: c.origem_venda,
    responsavelNome: c.responsavel_nome, responsavelCpf: c.responsavel_cpf,
    responsavelEmail: c.responsavel_email, responsavelCelular: c.responsavel_celular,
    turmaId: c.sponte_turma_id, cursoId: c.sponte_curso_id,
    planoCursoId: c.plano_curso_id, bolsaId: c.bolsa_id,
    valorParcela: num(c.valor_parcela), parcelas: c.parcelas,
    valorTotal: num(c.valor_total), parcelasCartao: c.parcelas_cartao,
    formaCobrancaNome: c.forma_cobranca_nome,
    pagamentoLink: c.pagamento_link, linkId: c.link_id,
    progresso: c.sponte_aluno_id || c.sponte_contrato_id
      ? {
          sponteAlunoId: c.sponte_aluno_id, responsavelId: c.sponte_responsavel_id,
          contratoId: c.sponte_contrato_id, contaReceberId: c.sponte_conta_receber_id,
          numeroParcela: c.sponte_numero_parcela, planoCriado: !!c.sponte_contrato_id,
          matriculaCriada: !!c.sponte_contrato_id, alunoJaExistia: false,
          linkPagamento: c.pagamento_link, ultimoPasso: null, erro: null, erroPasso: null,
        } as never
      : null,
  };
}

/**
 * Quem está pedindo, e pode?
 *
 * Duas credenciais são aceitas, nesta ordem: o segredo da própria ficha
 * (o aluno, que não tem sessão) e uma sessão de administrador (o painel).
 * O `cadastroId` sozinho **nunca** autoriza — ele é sequencial.
 */
async function autorizar(
  cadastroId: number,
  tokenAcesso: string | null,
  autorizacao: string | undefined,
): Promise<{ ok: true; ficha: Record<string, any> } | { ok: false; status: number }> {
  if (!Number.isInteger(cadastroId) || cadastroId <= 0) return { ok: false, status: 401 };

  const [ficha] = await rest<Record<string, any>[]>(
    `alunos_staging?id=eq.${cadastroId}&select=*&limit=1`);
  // Mesma resposta para "não existe" e "não é seu": distinguir entregaria
  // um oráculo para descobrir quais ids existem.
  if (!ficha) return { ok: false, status: 401 };

  if (tokenAcesso) {
    // Comparação no banco, pelo próprio valor, e só para esta ficha.
    if (/^[0-9a-f]{32}$/.test(tokenAcesso) && ficha.token_acesso === tokenAcesso) {
      return { ok: true, ficha };
    }
    return { ok: false, status: 401 };
  }

  try {
    await exigirPapel(autorizacao, ["admin"], env);
    return { ok: true, ficha };
  } catch (e) {
    if (e instanceof AutorizacaoError) return { ok: false, status: 401 };
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * A porta
 * ------------------------------------------------------------------ */

Deno.serve(async (req) => {
  const cors = cabecalhosCors(req.headers.get("origin"), origensDoAmbiente(env));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") {
    return respostaJson({ erro: "Use POST." }, 405, cors);
  }

  let corpo: { cadastroId?: unknown; tokenAcesso?: unknown; acao?: unknown };
  try {
    corpo = await req.json();
  } catch {
    return respostaJson({ erro: "Corpo inválido." }, 400, cors);
  }

  const cadastroId = Number(corpo.cadastroId);
  const tokenAcesso = typeof corpo.tokenAcesso === "string" ? corpo.tokenAcesso.trim() : null;

  const quem = await autorizar(
    cadastroId, tokenAcesso || null, req.headers.get("authorization") ?? undefined);
  if (!quem.ok) {
    return respostaJson({ ok: false, motivo: "nao_encontrado" }, quem.status, cors);
  }

  try {
    const cred = credenciaisDoAmbiente(env);

    /* --- Promover a pré-matrícula para "Cursando" --- *
     *
     * A outra escrita no ERP, pequena mas escrita: acontece quando o
     * pagamento é confirmado. Vive aqui pelo mesmo motivo do resto — a
     * aplicação da frente não tem a chave do Sponte, e não deve ter.
     */
    if (corpo.acao === "promover") {
      const contratoId = Number(quem.ficha.sponte_contrato_id);
      if (!contratoId) return respostaJson({ ok: true, semContrato: true }, 200, cors);

      const t0 = Date.now();
      try {
        await promoverMatricula(cred, contratoId, { simular: !ESCRITA_LIBERADA });
        registrar({
          tipo: "sponte", operacao: "promoverMatricula", cadastroId,
          ok: true, duracaoMs: Date.now() - t0, detalhe: { contratoId },
        });
        return respostaJson({ ok: true, promovido: true }, 200, cors);
      } catch (e) {
        const msg = (e as Error).message;
        registrar({
          tipo: "sponte", operacao: "promoverMatricula", cadastroId,
          ok: false, duracaoMs: Date.now() - t0, erro: msg, detalhe: { contratoId },
        });
        // 200 de propósito: o pagamento já foi confirmado e isso não pode
        // se perder porque a promoção falhou. Quem chamou grava o aviso.
        return respostaJson({ ok: false, promovido: false, erro: msg }, 200, cors);
      }
    }

    const r = await executarCheckout(paraFicha(quem.ficha), {
      cred,
      web,
      escritaLiberada: ESCRITA_LIBERADA,
      modoTeste: MODO_TESTE,
      registrar,
      atualizar: (id, campos) =>
        rest(`alunos_staging?id=eq.${id}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ ...campos, atualizado_em: new Date().toISOString() }),
        }),
      // Só a data de término interessa ao contrato; buscar a turma inteira
      // por isso é o preço de uma chamada que o cache do painel não tem aqui.
      async dataTerminoDaTurma(turmaId) {
        if (!turmaId) return null;
        try {
          const todas = await getTurmas(cred, { timeoutMs: 60_000 });
          return todas.find((t) => t.turmaId === turmaId)?.dataTermino ?? null;
        } catch {
          // Sem a data o contrato usa o padrão. Não vale abortar a
          // matrícula inteira por causa dela.
          return null;
        }
      },
    });

    // 409 quando a ficha não está em situação de ser cobrada: é recusa de
    // regra, não falha de sistema, e a tela mostra a mensagem que vem junto.
    const status = r.ok ? 200 : r.motivo === "situacao_invalida" ? 409 : 502;
    return respostaJson(r, status, cors);
  } catch (e) {
    const msg = e instanceof SponteError ? `${e.tipo}: ${e.message}` : (e as Error).message;
    registrar({
      tipo: "sponte", operacao: "checkout (falha inesperada)",
      cadastroId, ok: false, erro: msg,
    });
    return respostaJson({ ok: false, motivo: "falha_sponte", erro: msg }, 502, cors);
  }
});
