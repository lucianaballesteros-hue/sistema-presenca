/**
 * Critérios de cobrança e vigia da fatura Sponte Pay.
 *
 * -------------------------------------------------------------------
 * POR QUE ISTO EXISTE
 * -------------------------------------------------------------------
 * O Sponte **não expõe API para gerar a fatura** do Sponte Pay. Verificado em
 * 08/10/2026: as cinco operações de pagamento entre as 138 do WSAPIEdu são de
 * leitura; a API REST do portal do aluno só consulta; e trocar a forma de
 * cobrança da parcela para Pix, Boleto ou Link (−29, −28, −27) por
 * `UpdateParcela` não muda nada — as três continuam devolvendo
 * `313 - Parcela não vinculada ao Sponte Pay`.
 *
 * A fatura nasce de duas formas, ambas dentro do Sponte:
 *   1. **Régua de cobrança** — automação configurada no ERP, que gera e envia
 *      o link por SMS, e-mail ou WhatsApp.
 *   2. **Manualmente**, na tela Financeiro → Geração de Link.
 *
 * Este módulo cobre as duas: confere se o cadastro cumpre tudo que a régua
 * precisa para disparar, vigia se o link apareceu, e aciona o time quando o
 * prazo passa sem fatura.
 */

import {
  chamarSoap,
  type CredenciaisSponte,
  credenciais,
  desescaparXml,
  type OpcoesChamada,
} from "./soap.ts";

/* ------------------------------------------------------------------ *
 * Critérios
 * ------------------------------------------------------------------ */

export type SeveridadeCriterio = "bloqueia" | "atrasa" | "informa";

export interface Criterio {
  id: string;
  rotulo: string;
  /**
   * `bloqueia` — sem isto a cobrança não existe.
   * `atrasa`   — a cobrança existe, mas o link não chega ao aluno.
   * `informa`  — não impede nada; aparece para quem for conferir.
   */
  severidade: SeveridadeCriterio;
  atendido: boolean;
  detalhe: string;
}

export interface DadosParaCobranca {
  sponteAlunoId: number | null;
  responsavelId: number | null;
  contratoId: number | null;
  contaReceberId: number | null;
  email: string | null;
  celular: string | null;
  cpf: string | null;
  formaCobrancaId: number | null;
  valorParcela: number | null;
  parcelas: number | null;
  /** Vencimento da primeira parcela, ISO. */
  primeiroVencimento?: string | null;
}

/**
 * Confere tudo que o Sponte precisa para emitir e enviar a cobrança.
 *
 * A ordem é a do fluxo: um critério que falha cedo costuma explicar os de
 * baixo, e mostrar os dois juntos ajuda quem for corrigir.
 */
export function conferirCriterios(d: DadosParaCobranca): Criterio[] {
  const c: Criterio[] = [];
  const add = (
    id: string, rotulo: string, severidade: SeveridadeCriterio,
    atendido: boolean, detalhe: string,
  ) => c.push({ id, rotulo, severidade, atendido, detalhe });

  add("aluno", "Aluno cadastrado no Sponte", "bloqueia",
    !!d.sponteAlunoId && d.sponteAlunoId > 0,
    d.sponteAlunoId ? `AlunoID ${d.sponteAlunoId}` : "não criado");

  // Sem sacado não há a quem cobrar: ResponsavelFinanceiroID fica 0 e nenhuma
  // fatura pode ser emitida em nome do aluno.
  add("responsavel", "Responsável financeiro definido", "bloqueia",
    !!d.responsavelId && d.responsavelId > 0,
    d.responsavelId ? `ResponsavelID ${d.responsavelId}` : "sem sacado — a cobrança não tem destinatário");

  add("contrato", "Matrícula com contrato vigente", "bloqueia",
    !!d.contratoId && d.contratoId > 0,
    d.contratoId ? `Contrato ${d.contratoId}` : "não criado");

  add("parcelas", "Plano financeiro gerado", "bloqueia",
    !!d.contaReceberId && d.contaReceberId > 0,
    d.contaReceberId
      ? `ContaReceberID ${d.contaReceberId} · ${d.parcelas ?? "?"} parcela(s)`
      : "sem parcelas a cobrar");

  // Negativo é o normal: os ids de forma de cobrança do Sponte são negativos.
  const formaOk = d.formaCobrancaId !== null && d.formaCobrancaId < 0;
  add("forma", "Forma de cobrança Sponte Pay", "bloqueia", formaOk,
    formaOk ? `forma ${d.formaCobrancaId}` : "forma não é do Sponte Pay 2.0");

  // A régua envia por e-mail, SMS ou WhatsApp. Sem nenhum canal, a fatura até
  // é gerada, mas não chega a ninguém.
  const temCanal = !!d.email?.trim() || !!d.celular?.trim();
  add("canal", "Canal de contato para receber o link", "atrasa", temCanal,
    temCanal
      ? [d.email, d.celular].filter(Boolean).join(" · ")
      : "sem e-mail nem celular — a régua não tem para onde enviar");

  add("cpf", "CPF do sacado", "atrasa", !!d.cpf && d.cpf.replace(/\D/g, "").length === 11,
    d.cpf ? "informado" : "ausente — exigido pela maioria dos meios de pagamento");

  add("valor", "Valor da parcela definido", "bloqueia",
    !!d.valorParcela && d.valorParcela > 0,
    d.valorParcela ? `R$ ${d.valorParcela.toFixed(2)}` : "sem valor");

  if (d.primeiroVencimento) {
    const venc = new Date(`${d.primeiroVencimento}T00:00:00`);
    const futuro = venc.getTime() > Date.now();
    add("vencimento", "Primeiro vencimento no futuro", "informa", futuro,
      futuro ? d.primeiroVencimento : `${d.primeiroVencimento} — já venceu`);
  }

  return c;
}

export interface ResumoCriterios {
  pronto: boolean;
  bloqueios: Criterio[];
  atrasos: Criterio[];
  criterios: Criterio[];
}

export function resumirCriterios(d: DadosParaCobranca): ResumoCriterios {
  const criterios = conferirCriterios(d);
  const bloqueios = criterios.filter((c) => c.severidade === "bloqueia" && !c.atendido);
  const atrasos = criterios.filter((c) => c.severidade === "atrasa" && !c.atendido);
  return { pronto: bloqueios.length === 0, bloqueios, atrasos, criterios };
}

/* ------------------------------------------------------------------ *
 * Vigia da fatura
 * ------------------------------------------------------------------ */

export type SituacaoFatura = "sem_fatura" | "fatura_gerada" | "paga" | "erro";

export interface EstadoCobranca {
  situacao: SituacaoFatura;
  faturaId: number | null;
  linkPagamento: string | null;
  dataPagamento: string | null;
  valorPago: string | null;
  formaCobranca: string | null;
  vencimento: string | null;
  verificadoEm: string;
}

/** Descarta URLs de namespace XML, que aparecem no schema de toda resposta. */
function extrairUrlPagamento(xml: string): string | null {
  for (const [url] of xml.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    if (/w3\.org|microsoft\.com|tempuri\.org|xmlsoap\.org|schemas\./i.test(url)) continue;
    return url;
  }
  return null;
}

/**
 * Verifica se a fatura já existe e se foi paga.
 *
 * Duas leituras: `GetParcelas` (que traz `FaturaID` e `DataPagamento`) e
 * `GetLinkPagamentoSpontePay`. Enquanto a fatura não existe, a segunda devolve
 * `313 - Parcela não vinculada ao Sponte Pay` — e é exatamente esse código que
 * distingue "ainda não geraram" de "deu errado".
 */
export async function verificarCobranca(
  cred: CredenciaisSponte,
  alunoId: number,
  contaReceberId: number,
  numeroParcela: string,
  opcoes: OpcoesChamada = {},
): Promise<EstadoCobranca> {
  const agora = new Date().toISOString();
  const vazio: EstadoCobranca = {
    situacao: "sem_fatura", faturaId: null, linkPagamento: null,
    dataPagamento: null, valorPago: null, formaCobranca: null,
    vencimento: null, verificadoEm: agora,
  };

  const xp = await chamarSoap(
    "GetParcelas",
    [...credenciais(cred), ["sParametrosBusca", `AlunoID=${alunoId}`]],
    { ...opcoes, ignorarRetornoOperacao: true },
  );

  const campo = (b: string, n: string) =>
    desescaparXml(b.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`))?.[1] ?? "").trim();

  const parcela = (xp.match(/<wsParcela>[\s\S]*?<\/wsParcela>/g) ?? []).find((b) =>
    Number(campo(b, "ContaReceberID")) === contaReceberId &&
    campo(b, "NumeroParcela") === String(numeroParcela));

  if (!parcela) return vazio;

  const faturaId = Number(campo(parcela, "FaturaID")) || null;
  const dataPagamento = campo(parcela, "DataPagamento") || null;

  const estado: EstadoCobranca = {
    ...vazio,
    faturaId,
    dataPagamento,
    valorPago: campo(parcela, "ValorPago") || null,
    formaCobranca: campo(parcela, "FormaCobranca") || null,
    vencimento: campo(parcela, "Vencimento") || null,
  };

  if (dataPagamento) return { ...estado, situacao: "paga" };

  // ⚠️ Pergunta pelo link **sempre**, mesmo com `FaturaID` em 0.
  //
  // Antes havia aqui um `if (!faturaId) return estado`, supondo que a fatura
  // precedesse o link. É falso: em 09/10/2026 o time gerou o link pela tela
  // Financeiro → Geração de Link e `GetLinkPagamentoSpontePay` passou a
  // devolvê-lo enquanto o `FaturaID` da parcela continuava 0. Com o atalho
  // ligado, o link existia e o sistema nunca o via.
  //
  // Quem decide é a própria chamada: URL = tem link; 313 = ainda não geraram.
  const xl = await chamarSoap(
    "GetLinkPagamentoSpontePay",
    [...credenciais(cred), ["nContaReceberID", contaReceberId], ["nNumeroParcela", String(numeroParcela)]],
    { ...opcoes, ignorarRetornoOperacao: true },
  );

  const link = extrairUrlPagamento(xl);
  return { ...estado, situacao: link ? "fatura_gerada" : "sem_fatura", linkPagamento: link };
}

/* ------------------------------------------------------------------ *
 * Quando acionar o time
 * ------------------------------------------------------------------ */

/**
 * Quanto esperar antes de chamar alguém.
 *
 * Eram 4 horas, escolhidas supondo uma régua que rodasse algumas vezes ao dia.
 * A tela Financeiro → Geração de Link mostrou outra coisa: em 09/10/2026 os
 * links das parcelas que vencem em 12/10 foram todos gerados em 02/10, no
 * mesmo dia — um lote mensal, com dez dias de antecedência.
 *
 * A consequência é que, para quem se cadastra no meio do mês, **o link não
 * sai sozinho**: o lote daquele vencimento já passou. Esperar horas só atrasa
 * uma ação que alguém vai ter de fazer de qualquer jeito.
 *
 * Meia hora, então — o bastante para não alertar sobre um cadastro ainda em
 * andamento, e pouco o suficiente para o aluno não ficar sem resposta.
 */
export const HORAS_ATE_ALERTAR = 0.5;

export type MotivoAlerta =
  | "criterio_bloqueante"
  | "fatura_nao_gerada"
  | "falha_no_envio";

export interface Alerta {
  motivo: MotivoAlerta;
  urgente: boolean;
  titulo: string;
  descricao: string;
  /** O que a pessoa precisa fazer, em uma frase. */
  acao: string;
}

export interface ContextoAlerta {
  nomeAluno: string;
  turmaNome: string;
  criadoEm: string;
  criterios: ResumoCriterios;
  estado: EstadoCobranca | null;
}

/**
 * Decide se o time precisa ser chamado, e por quê.
 *
 * Devolve `null` quando não há nada a fazer — o silêncio é o caso normal, e um
 * alerta que dispara sempre deixa de ser lido.
 */
export function avaliarAlerta(ctx: ContextoAlerta): Alerta | null {
  const { criterios, estado, nomeAluno, turmaNome } = ctx;

  // Pago: nada a cobrar.
  if (estado?.situacao === "paga") return null;

  // Bloqueio é imediato: nem a régua nem a geração manual resolvem sozinhas.
  if (criterios.bloqueios.length > 0) {
    const lista = criterios.bloqueios.map((b) => b.rotulo).join("; ");
    return {
      motivo: "criterio_bloqueante",
      urgente: true,
      titulo: `Cadastro de ${nomeAluno} não pode ser cobrado`,
      descricao: `Faltam requisitos no Sponte: ${lista}.`,
      acao: "Corrigir o cadastro no Sponte antes de gerar a cobrança.",
    };
  }

  // Sem canal de contato, o link pode até ser gerado — e não chega a ninguém.
  if (criterios.atrasos.some((a) => a.id === "canal")) {
    return {
      motivo: "falha_no_envio",
      urgente: true,
      titulo: `${nomeAluno} não tem como receber o link`,
      descricao: `Sem e-mail nem celular cadastrados. A régua não tem para onde enviar.`,
      acao: "Obter um contato com o aluno e cadastrar no Sponte.",
    };
  }

  const horas = (Date.now() - new Date(ctx.criadoEm).getTime()) / 3_600_000;
  if (!estado || estado.situacao === "sem_fatura") {
    if (horas < HORAS_ATE_ALERTAR) return null;   // ainda dentro do prazo da régua
    // "há 0h" não ajuda ninguém: abaixo de uma hora, conta em minutos.
    const quando = horas < 1
      ? `há ${Math.max(1, Math.round(horas * 60))} min`
      : `há ${Math.floor(horas)}h`;

    return {
      motivo: "fatura_nao_gerada",
      urgente: false,
      titulo: `Gerar link de pagamento de ${nomeAluno}`,
      descricao:
        `Cadastro em ${turmaNome} feito ${quando}, sem link de pagamento. ` +
        `O lote mensal da régua não alcança quem se cadastra fora dele.`,
      acao:
        "No Sponte: Financeiro → Geração de Link → filtrar pelo aluno → " +
        "marcar a parcela → Gerar/Enviar Link de Pagamento. " +
        "O sistema captura o link sozinho em até 15 minutos.",
    };
  }

  return null;
}
