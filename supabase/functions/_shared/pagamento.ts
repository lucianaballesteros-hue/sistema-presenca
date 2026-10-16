/**
 * Formas de cobrança e link de pagamento do Sponte Pay.
 *
 * Decisão do projeto: a escola opera com **Pix, Cartão e Boleto** — os três
 * meios que o formulário de matrícula atual já usa. As outras 23 formas
 * cadastradas (cheque, dinheiro, PagSeguro, Vindi, Educbank…) continuam no ERP
 * para lançamento manual, mas não aparecem no cadastro online.
 *
 * Três coisas aprendidas na base real (05/10/2026) que o código precisa honrar:
 *
 *   1. **Os ids são negativos.** `-29` é Pix, `-30` é Cartão. Qualquer
 *      validação de "inteiro positivo" recusa todos eles.
 *
 *   2. **O retorno é aninhado e com nome enganoso:** `<wsFormasCobrancas>`
 *      (plural) contendo uma lista `<FormasCobrancas>` de itens
 *      `<FormasCobrancas>`. Procurar `<wsFormaCobranca>` não acha nada — e
 *      devolve "zero formas cadastradas", que foi exatamente o engano
 *      registrado em `docs/API-SPONTE.md` §5.
 *
 *   3. **O checkout é pós-pago.** `GetLinkPagamentoSpontePay` exige um
 *      `nContaReceberID` que já exista. Ver `docs/API-SPONTE.md` §5.1.
 */

import {
  chamarSoap,
  type CredenciaisSponte,
  credenciais,
  desescaparXml,
  type OpcoesChamada,
} from "./soap.ts";

export type MeioPagamento = "pix" | "cartao" | "boleto" | "cartao_recorrente";

export interface FormaCobranca {
  formaCobrancaId: number;
  descricao: string;
  /** Classificação nossa, derivada da descrição. `null` = fora do escopo. */
  meio: MeioPagamento | null;
  /** `true` para as formas Sponte Pay 2.0, que são as que geram link online. */
  spontePay2: boolean;
}

/**
 * Extrai a URL de pagamento da resposta.
 *
 * Descarta URLs de namespace XML (`w3.org`, `microsoft.com`, `tempuri.org`),
 * que aparecem no schema de toda resposta do Sponte. Pegar a primeira URL da
 * string fazia o código devolver "http://www.w3.org/2001/XMLSchema" como se
 * fosse um checkout — um sucesso falso, pior que um erro.
 */
function extrairUrlPagamento(xml: string): string | null {
  for (const [url] of xml.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    if (/w3\.org|microsoft\.com|tempuri\.org|xmlsoap\.org|schemas\./i.test(url)) continue;
    return url;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Catálogo
 * ------------------------------------------------------------------ */

/**
 * Classifica uma forma pelo texto da descrição.
 *
 * Por descrição, e não por id fixo: os ids são constantes do Sponte, mas nada
 * garante que sejam iguais em outra base, e uma lista de ids mágicos no código
 * quebraria em silêncio. A descrição é estável e legível.
 *
 * A ordem dos testes importa: "Recorrência" precisa ser avaliada antes de
 * "Cartão", porque a recorrência também é cartão e tem comportamento de
 * cobrança diferente.
 */
export function classificarMeio(descricao: string): MeioPagamento | null {
  const d = descricao.toLowerCase();
  if (d.includes("recorrência") || d.includes("recorrencia") || d.includes("recorrente")) {
    return "cartao_recorrente";
  }
  if (d.includes("pix")) return "pix";
  if (d.includes("boleto")) return "boleto";
  if (d.includes("cartão") || d.includes("cartao") || d.includes("crédito") || d.includes("credito")) {
    return "cartao";
  }
  return null;
}

export function parsearFormasCobranca(xmlInterno: string): FormaCobranca[] {
  // Os pares vêm em sequência dentro de cada item da lista aninhada; capturar o
  // par direto é mais robusto que tentar delimitar os itens, já que o nó-pai e
  // o nó-item têm o mesmo nome (`FormasCobrancas`).
  const pares = [...xmlInterno.matchAll(
    /<FormaCobrancaID>(-?\d+)<\/FormaCobrancaID>\s*<Descricao>([\s\S]*?)<\/Descricao>/g,
  )];

  return pares.map(([, id, desc]) => {
    const descricao = desescaparXml(desc).trim();
    return {
      formaCobrancaId: Number(id),
      descricao,
      meio: classificarMeio(descricao),
      spontePay2: /sponte\s*pay\s*2\.0/i.test(descricao),
    };
  });
}

export async function getFormasCobranca(
  cred: CredenciaisSponte,
  opcoes: OpcoesChamada = {},
): Promise<FormaCobranca[]> {
  const xml = await chamarSoap("GetFormasCobrancas", [...credenciais(cred)], opcoes);
  return parsearFormasCobranca(xml);
}

/**
 * As formas oferecidas ao aluno, uma por meio de pagamento.
 *
 * Quando existem as duas gerações da mesma forma, **fica a antiga**, não a
 * 2.0. Isso contraria o que o nome sugere, e o motivo é medido:
 *
 * - Toda cobrança de aluno real desta escola usa a família antiga
 *   (`Recorrência Sponte Pay`, id −18).
 * - A tela Financeiro → Geração de Link **não lista** parcelas em 2.0. Em
 *   09/10/2026, duas parcelas vencendo no mesmo dia: a que estava em
 *   `Link de Pagamento Sponte Pay` (conta 1784) apareceu na grade; a que
 *   estava em `Pix Sponte Pay 2.0` (conta 1785) não apareceu.
 * - Sem aparecer na grade, não há como gerar o link — nem à mão.
 *
 * Ou seja: a 2.0 provavelmente não está habilitada no contrato Sponte Pay
 * desta escola. Se um dia for, basta inverter a comparação abaixo.
 */
/**
 * A forma de cobrança que o plano precisa ter para render um link.
 *
 * **Não é a que o aluno escolheu.** A tela Financeiro → Geração de Link só
 * lista parcelas cuja forma é "Link de Pagamento Sponte Pay" — medido em
 * 09/10/2026: a mesma parcela sumiu da grade em "Pix Sponte Pay" e reapareceu
 * ao voltar para esta. Sem estar na grade, não há link, nem pela automação
 * nem à mão.
 *
 * Pix, cartão ou boleto é decisão que o aluno toma **na página do Sponte
 * Pay** que o link abre. O que ele marca no nosso formulário serve para a
 * escola saber a intenção e para o resumo na tela — não para o ERP.
 */
export function formaParaLink(todas: FormaCobranca[]): FormaCobranca | null {
  return todas.find((f) =>
    !f.spontePay2 && /link\s*de\s*pagamento\s*sponte\s*pay/i.test(f.descricao)) ?? null;
}

export function formasOferecidas(todas: FormaCobranca[]): FormaCobranca[] {
  const aceitos: MeioPagamento[] = ["pix", "cartao", "boleto", "cartao_recorrente"];
  const candidatas = todas.filter((f) => f.meio !== null && aceitos.includes(f.meio));

  const porMeio = new Map<MeioPagamento, FormaCobranca>();
  for (const f of candidatas) {
    const atual = porMeio.get(f.meio!);
    // Sem nada ainda, ou a atual é 2.0 e a nova não: fica a nova.
    if (!atual || (atual.spontePay2 && !f.spontePay2)) porMeio.set(f.meio!, f);
  }

  // Ordem fixa: Pix primeiro (confirmação imediata e sem taxa de adquirente),
  // depois cartão, depois boleto — que compensa só em prazo, não em velocidade.
  const ordem: MeioPagamento[] = ["pix", "cartao", "boleto", "cartao_recorrente"];
  return ordem.map((m) => porMeio.get(m)).filter((f): f is FormaCobranca => !!f);
}

/* ------------------------------------------------------------------ *
 * Parcelamento
 * ------------------------------------------------------------------ */

/**
 * ⚠️ **Dois parcelamentos diferentes convivem aqui, e confundi-los gera
 * cobrança errada.**
 *
 * - **Parcelas do plano** (`NumeroParcelasMensalidade`, em `planos.ts`): são as
 *   mensalidades do curso. Um plano de 6× gera **6 títulos** no Sponte, um por
 *   mês, cada um cobrado na data do seu vencimento.
 *
 * - **Parcelas do cartão** (aqui): é o parcelamento de **um** título na
 *   operadora. O aluno paga uma vez; a administradora divide no cartão dele.
 *
 * Um plano de 6 mensalidades pago "em 3× no cartão" significa 6 títulos, cada
 * um parcelado em 3 — não 3 cobranças no total.
 *
 * Pix não parcela: é à vista, por definição do meio.
 */
export const MAX_PARCELAS_CARTAO = 12;

export function parcelasPermitidas(meio: MeioPagamento): number[] {
  // Pix é à vista por definição. Boleto também: parcelar boleto no Sponte é
  // emitir N boletos, que é o que o plano de mensalidades já faz — dividir de
  // novo geraria cobrança duplicada.
  if (meio === "pix" || meio === "boleto") return [1];
  // A recorrência cobra uma parcela por ciclo; parcelar por cima não faz sentido.
  if (meio === "cartao_recorrente") return [1];
  return Array.from({ length: MAX_PARCELAS_CARTAO }, (_, i) => i + 1);
}

export function parcelamentoValido(meio: MeioPagamento, parcelas: number): boolean {
  return parcelasPermitidas(meio).includes(parcelas);
}

/**
 * Divide um valor em N parcelas sem perder centavos.
 *
 * A última parcela absorve a diferença do arredondamento: R$ 100,00 em 3× vira
 * 33,33 + 33,33 + 33,34, e não três parcelas de 33,33 que somam R$ 99,99.
 */
export function dividirParcelas(total: number, parcelas: number): number[] {
  if (parcelas < 1) throw new RangeError("parcelas deve ser >= 1");

  const centavos = Math.round(total * 100);
  const base = Math.floor(centavos / parcelas);
  const resto = centavos - base * parcelas;

  return Array.from({ length: parcelas }, (_, i) =>
    (base + (i === parcelas - 1 ? resto : 0)) / 100);
}

/* ------------------------------------------------------------------ *
 * Link de pagamento
 * ------------------------------------------------------------------ */

export interface LinkPagamento {
  url: string;
  contaReceberId: number;
  numeroParcela: string;
}

/**
 * Pede ao Sponte o link de pagamento de uma parcela já existente.
 *
 * ⚠️ **Não cria nada.** O título precisa existir antes — é a consequência de o
 * checkout do Sponte ser pós-pago (`docs/API-SPONTE.md` §5.1). A sequência
 * completa é: `InsertAlunos3` → `InsertMatricula` → `InsertPlano` →
 * `GetParcelas` → esta função.
 */
export async function getLinkPagamento(
  cred: CredenciaisSponte,
  contaReceberId: number,
  numeroParcela: string | number = 1,
  opcoes: OpcoesChamada = {},
): Promise<LinkPagamento | null> {
  const xml = await chamarSoap(
    "GetLinkPagamentoSpontePay",
    [
      ...credenciais(cred),
      ["nContaReceberID", contaReceberId],
      ["nNumeroParcela", String(numeroParcela)],
    ],
    opcoes,
  );

  const url = extrairUrlPagamento(xml);
  if (!url) return null;

  return { url, contaReceberId, numeroParcela: String(numeroParcela) };
}

/* ------------------------------------------------------------------ *
 * Exibição
 * ------------------------------------------------------------------ */

export function rotuloMeio(meio: MeioPagamento): string {
  return {
    pix: "Pix", cartao: "Cartão de crédito",
    boleto: "Boleto", cartao_recorrente: "Cartão recorrente",
  }[meio];
}

/** Texto curto da condição, do jeito que o aluno entende. */
export function descreverParcelamento(
  meio: MeioPagamento,
  parcelas: number,
  valorParcela: number,
): string {
  const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  if (meio === "pix") return `${brl(valorParcela)} à vista no Pix`;
  if (meio === "boleto") return `${brl(valorParcela)} por boleto`;
  if (parcelas === 1) return `${brl(valorParcela)} em 1× no cartão`;
  return `${parcelas}× de ${brl(valorParcela / parcelas)} no cartão`;
}
