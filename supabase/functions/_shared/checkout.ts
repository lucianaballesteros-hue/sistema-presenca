/**
 * O checkout: a única escrita irreversível do sistema.
 *
 * Aqui dentro acontece a sequência que cria aluno, responsável, contrato,
 * plano e mensalidades no Sponte, e então gera o link de pagamento. **O
 * Sponte não tem exclusão por API** — o que entra errado sai a mão, pela
 * interface, um registro por vez.
 *
 * Por isso este módulo existe separado e mora do lado do Supabase: ele é
 * chamado por **uma** porta, a Edge Function `sponte-checkout`, que é o
 * único lugar onde a chave do ERP é lida. Nem o painel nem o formulário
 * falam com o Sponte diretamente; eles pedem à porta, e a porta decide.
 *
 * A autorização **não** mora aqui: quem chama já decidiu que pode. Este
 * módulo cuida da sequência e de registrar até onde ela chegou — que é o
 * que permite repetir sem duplicar.
 */

import {
  executarMatricula, progressoVazio, ROTULO_PASSO,
  type ProgressoMatricula,
} from "./matricula.ts";
import { formaParaLink, getFormasCobranca } from "./pagamento.ts";
import { verificarCobranca } from "./cobranca.ts";
import { gerarLinkPagamento, type SponteWeb } from "./sponte-web.ts";
import type { CredenciaisSponte } from "./soap.ts";

/** O que o checkout precisa saber da ficha. */
export interface FichaParaCheckout {
  id: number;
  status: string;
  nome: string;
  cpf: string | null;
  dataNascimento: string | null;
  email: string | null;
  celular: string | null;
  sexo: string | null;
  rg: string | null;
  estadoCivil: string | null;
  nacionalidade: string | null;
  cidadeNatal: string | null;
  profissao: string | null;
  telefone: string | null;
  cep: string | null;
  endereco: string | null;
  numeroEndereco: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  origemVenda: string | null;
  responsavelNome: string | null;
  responsavelCpf: string | null;
  responsavelEmail: string | null;
  responsavelCelular: string | null;
  turmaId: number | null;
  cursoId: number | null;
  planoCursoId: number | null;
  bolsaId: number | null;
  valorParcela: number | null;
  parcelas: number | null;
  valorTotal: number | null;
  parcelasCartao: number | null;
  formaCobrancaNome: string | null;
  pagamentoLink: string | null;
  linkId: number | null;
  progresso: ProgressoMatricula | null;
}

/** O que o checkout precisa do mundo em volta. */
export interface DependenciasCheckout {
  cred: CredenciaisSponte;
  /** `null` quando a automação da tela não está configurada. */
  web: SponteWeb | null;
  /** Grava campos na ficha. */
  atualizar(id: number, campos: Record<string, unknown>): Promise<unknown>;
  /** Registra na auditoria. Não pode lançar. */
  registrar(e: {
    tipo: "sponte" | "link";
    operacao: string;
    cadastroId?: number | null;
    ok?: boolean | null;
    duracaoMs?: number | null;
    detalhe?: Record<string, unknown>;
    erro?: string | null;
  }): void;
  /** A data de término da turma, para o contrato. `null` se desconhecida. */
  dataTerminoDaTurma(turmaId: number | null): Promise<string | null>;
  /** Com `false`, nada é escrito no ERP — a sequência roda em simulação. */
  escritaLiberada: boolean;
  /** Prefixa os nomes criados com "TESTE-SISTEMA". */
  modoTeste: boolean;
}

export interface ResultadoCheckout {
  ok: boolean;
  motivo?: string;
  mensagem?: string;
  erro?: string;
  passo?: string | null;
  link?: string | null;
  aguardandoFatura?: boolean;
  simulado?: boolean;
  jaExistia?: boolean;
  progresso?: ProgressoMatricula;
}

/**
 * Situações em que a ficha pode virar matrícula no Sponte.
 *
 * `pendente` é o estado logo após o envio do formulário — o caso normal.
 * `aprovado` é a conferência manual. Fora disso não se grava no ERP:
 * `rejeitado` foi recusado por alguém, `rascunho` nem foi enviado, e
 * `enviado`/`erro` já passaram por aqui.
 */
export const STATUS_PODE_MATRICULAR = new Set(["pendente", "aprovado"]);

export async function executarCheckout(
  c: FichaParaCheckout,
  d: DependenciasCheckout,
): Promise<ResultadoCheckout> {
  const id = c.id;

  // Esta ficha deveria mesmo ir para o Sponte? Repetir um checkout já
  // feito é inofensivo (cai no `jaExistia` abaixo), mas uma ficha
  // rejeitada virando contrato não se desfaz.
  if (!c.pagamentoLink && !STATUS_PODE_MATRICULAR.has(c.status)) {
    d.registrar({
      tipo: "sponte", operacao: "checkout recusado (situação)", cadastroId: id,
      ok: false, erro: `situação "${c.status}"`,
      detalhe: { status: c.status, nome: c.nome },
    });
    return {
      ok: false,
      motivo: "situacao_invalida",
      mensagem: c.status === "rejeitado"
        ? "Este cadastro foi recusado pela escola e não gera cobrança. "
          + "Procure a secretaria."
        : `Este cadastro está em "${c.status}" e ainda não pode ser cobrado.`,
    };
  }

  // Já tem link: devolve o mesmo. Gerar outro criaria uma segunda cobrança.
  if (c.pagamentoLink) {
    return { ok: true, link: c.pagamentoLink, simulado: !d.escritaLiberada, jaExistia: true };
  }

  // A cobrança no Sponte vai SEMPRE em "Link de Pagamento Sponte Pay": é a
  // única forma que a tela de geração enxerga. Pix, cartão ou boleto o
  // aluno escolhe na página do Sponte Pay.
  const todas = await getFormasCobranca(d.cred, { timeoutMs: 60_000 });
  const forma = formaParaLink(todas);
  if (!forma) {
    return {
      ok: false, motivo: "sem_forma_de_link",
      erro: 'o Sponte não tem a forma "Link de Pagamento Sponte Pay" cadastrada',
    };
  }
  const formaCobrancaId = forma.formaCobrancaId;

  const iniciouEm = Date.now();
  const turmaDataTermino = await d.dataTerminoDaTurma(c.turmaId);

  const p = await executarMatricula(
    d.cred,
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
      turmaDataTermino,
      planoCursoId: c.planoCursoId, bolsaId: c.bolsaId,
      valorParcela: c.valorParcela ?? 0, parcelas: c.parcelas ?? 1,
      // O que será cobrado de fato: o total do contrato, numa cobrança só.
      valorTotal: c.valorTotal,
      formaCobrancaId,
      parcelasCartao: c.parcelasCartao ?? 1,
      observacao: `Cadastro online · link ${c.linkId}`,
    } as never,
    c.progresso ?? progressoVazio(),
    { simular: !d.escritaLiberada, marcarComoTeste: d.modoTeste, timeoutMs: 120_000 },
  );

  // Os ids do ERP são gravados mesmo em caso de erro: sem eles a
  // retentativa recriaria aluno e contrato que já existem.
  const campos: Record<string, unknown> = {
    sponte_aluno_id: p.sponteAlunoId,
    sponte_responsavel_id: p.responsavelId,
    sponte_contrato_id: p.contratoId,
    sponte_conta_receber_id: p.contaReceberId,
    sponte_numero_parcela: p.numeroParcela,
    sponte_responsavel_reusado: !!p.responsavelReusado,
    forma_cobranca_id: formaCobrancaId || null,
    forma_cobranca_nome: forma?.descricao ?? c.formaCobrancaNome ?? null,
  };

  d.registrar({
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
    campos.sponte_erro =
      `${p.erroPasso ? ROTULO_PASSO[p.erroPasso] + ": " : ""}${p.erro}`;
    await d.atualizar(id, campos);
    return {
      ok: false, motivo: "falha_sponte", passo: p.erroPasso,
      erro: String(campos.sponte_erro), progresso: p,
    };
  }

  /* --- 8º passo, fora da API: gerar o link na tela do Sponte --- *
   *
   * Vem depois de tudo porque depende de a parcela existir, e é a única
   * etapa que pode falhar sem invalidar o resto: o aluno já está
   * matriculado e a cobrança já existe. Falhando aqui, o cadastro segue
   * para o alerta — o caminho que havia antes de existir automação.
   */
  let linkPagamento = p.linkPagamento;
  if (!linkPagamento && p.contaReceberId && d.web) {
    try {
      const estado = await verificarCobranca(
        d.cred, p.sponteAlunoId!, p.contaReceberId, p.numeroParcela ?? "1",
        { timeoutMs: 90_000 },
      );
      linkPagamento = estado.linkPagamento;

      if (!linkPagamento && estado.vencimento) {
        const t0 = Date.now();
        const g = await gerarLinkPagamento(d.web, {
          contaReceberId: p.contaReceberId,
          numeroParcela: p.numeroParcela ?? "1",
          vencimento: estado.vencimento,
        });

        // Um link é uma cobrança: fica registrado quem nasceu, quando e
        // com que número, mesmo quando o Sponte recusa.
        d.registrar({
          tipo: "link", operacao: "gerarLinkPagamento", cadastroId: id,
          ok: g.ok, duracaoMs: Date.now() - t0, erro: g.ok ? null : g.motivo,
          detalhe: {
            contaReceberId: p.contaReceberId, parcela: p.numeroParcela ?? "1",
            vencimento: estado.vencimento,
            numeroLink: g.numeroLink, jaExistia: g.jaExistia,
          },
        });

        if (g.ok) linkPagamento = g.url;
      }
    } catch (e) {
      // Registra e segue: o alerta avisa o time, e a matrícula não se
      // perde por causa de uma tela que mudou de lugar.
      d.registrar({
        tipo: "link", operacao: "gerarLinkPagamento", cadastroId: id,
        ok: false, erro: (e as Error).message,
      });
    }
  }

  campos.sponte_erro = null;
  campos.status = "enviado";
  campos.sponte_enviado_em = new Date().toISOString();
  campos.pagamento_link = linkPagamento;
  // Sem link ainda é sucesso: o aluno está matriculado e a cobrança
  // existe. O que falta é a fatura, que só a régua do Sponte (ou alguém
  // na tela) gera.
  campos.pagamento_status = linkPagamento ? "link_gerado" : "aguardando";
  if (linkPagamento) campos.pagamento_link_gerado_em = new Date().toISOString();

  await d.atualizar(id, campos);

  return {
    ok: true,
    link: linkPagamento,
    aguardandoFatura: !linkPagamento,
    simulado: !d.escritaLiberada,
    jaExistia: false,
    progresso: p,
  };
}
