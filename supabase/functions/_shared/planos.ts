/**
 * Planos de curso e bolsas do Sponte — `GetPlanosCursos` e `GetBolsas`.
 *
 * O que estes dados são, na prática (levantado da base real em 25/09/2026):
 * um plano descreve quanto custa um curso, dividido em quatro rubricas
 * independentes — mensalidade, matrícula, material e "outros" — cada uma com
 * seu valor de parcela e sua quantidade de parcelas.
 *
 * Duas observações da base desta escola que moldam o código:
 *
 *   1. **Nenhum plano tem bolsa vinculada.** `BolsaIDMensalidade` vem vazio nos
 *      cinco planos ativos, embora existam três bolsas cadastradas (5%, 7%,
 *      10%). O desconto aparece no *nome* do plano (`2026 Elas 3%`), o que
 *      sugere valor já líquido. Por isso `aplicarBolsa()` não é chamado
 *      automaticamente em lugar nenhum: quem decide aplicar é uma pessoa.
 *
 *   2. **Só os cursos ativos têm plano.** Os 14 inativos devolvem código 43.
 */

import {
  chamarSoap,
  type CredenciaisSponte,
  credenciais,
  desescaparXml,
  lerRetornoOperacao,
  type OpcoesChamada,
  RETORNO_SEM_REGISTROS,
} from "./soap.ts";

/** Uma das quatro rubricas de cobrança de um plano. */
export interface Rubrica {
  valorParcela: number;
  parcelas: number;
  /** `valorParcela × parcelas`. */
  total: number;
}

export interface PlanoCurso {
  planoCursoId: number;
  cursoId: number;
  descricao: string;
  /** `true` quando o Sponte marca este como o plano padrão do curso. */
  padrao: boolean;
  ativo: boolean;

  mensalidade: Rubrica;
  /** Primeira mensalidade, quando difere das demais (entrada). */
  primeiraMensalidade: number | null;
  matricula: Rubrica;
  material: Rubrica;
  outros: Rubrica;

  /** Soma das quatro rubricas — o valor cheio do contrato. */
  total: number;

  bolsaId: number | null;
  bolsaDescricao: string | null;
}

export interface Bolsa {
  bolsaId: number;
  descricao: string;
  /** `"%"` para percentual. Outros valores não foram observados nesta base. */
  tipoDesconto: string;
  /** Percentual (ou valor) do desconto. */
  desconto: number;
  /**
   * Dias associados ao desconto. `0` em todas as bolsas desta escola, o que
   * indica desconto fixo — e não desconto por antecedência de pagamento.
   */
  dias: number;
}

/* ------------------------------------------------------------------ *
 * Leitura de campos
 * ------------------------------------------------------------------ */

function lerCampo(bloco: string, nome: string): string {
  if (new RegExp(`<${nome}(?:\\s[^>]*)?/>`).test(bloco)) return "";
  const m = bloco.match(new RegExp(`<${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</${nome}>`));
  return m ? desescaparXml(m[1]).trim() : "";
}

function lerInteiro(bloco: string, nome: string): number {
  const n = Number.parseInt(lerCampo(bloco, nome), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Lê um valor monetário.
 *
 * O Sponte devolve `double` serializado com ponto decimal (`129.00`), mas
 * aceita-se vírgula por precaução — um valor mal lido aqui vira preço errado
 * na tela do aluno, que é o pior tipo de erro desta integração.
 */
function lerDecimal(bloco: string, nome: string): number {
  const bruto = lerCampo(bloco, nome).replace(/\s/g, "");
  if (!bruto) return 0;

  // "1.234,56" → formato brasileiro; "1234.56" → serialização padrão.
  const normalizado = /,\d{1,2}$/.test(bruto)
    ? bruto.replace(/\./g, "").replace(",", ".")
    : bruto;

  const n = Number(normalizado);
  return Number.isFinite(n) ? n : 0;
}

function lerRubrica(bloco: string, sufixo: string): Rubrica {
  const valorParcela = lerDecimal(bloco, `ValorParcela${sufixo}`);
  const parcelas = lerInteiro(bloco, `NumeroParcelas${sufixo}`);
  return {
    valorParcela,
    parcelas,
    total: arredondar(valorParcela * parcelas),
  };
}

/** Arredonda para centavos, evitando o arrasto de ponto flutuante. */
export function arredondar(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/* ------------------------------------------------------------------ *
 * Planos
 * ------------------------------------------------------------------ */

export function parsearPlanos(xmlInterno: string): PlanoCurso[] {
  if (lerRetornoOperacao(xmlInterno)?.codigo === RETORNO_SEM_REGISTROS) return [];

  const blocos = xmlInterno.match(/<wsPlanoCurso>[\s\S]*?<\/wsPlanoCurso>/g) ?? [];

  return blocos
    .map((b): PlanoCurso => {
      const mensalidade = lerRubrica(b, "Mensalidade");
      const matricula = lerRubrica(b, "Matricula");
      const material = lerRubrica(b, "Material");
      const outros = lerRubrica(b, "Outros");

      const primeira = lerDecimal(b, "ValorPrimeiraParcelaMensalidade");
      const bolsaId = lerInteiro(b, "BolsaIDMensalidade");

      return {
        planoCursoId: lerInteiro(b, "PlanoCursoID"),
        cursoId: lerInteiro(b, "CursoID"),
        descricao: lerCampo(b, "DescricaoPlano"),
        padrao: lerCampo(b, "Padrao") === "1",
        // Situacao 1 = ativo. Plano sem o campo é tratado como ativo, para não
        // sumir da tela por causa de um campo que a origem pode não enviar.
        ativo: lerCampo(b, "Situacao") !== "0",

        mensalidade,
        primeiraMensalidade:
          primeira > 0 && primeira !== mensalidade.valorParcela ? primeira : null,
        matricula,
        material,
        outros,

        total: arredondar(
          mensalidade.total + matricula.total + material.total + outros.total,
        ),

        bolsaId: bolsaId > 0 ? bolsaId : null,
        bolsaDescricao: lerCampo(b, "DescricaoBolsaMensalidade") || null,
      };
    })
    .filter((p) => p.planoCursoId > 0);
}

export async function getPlanosCurso(
  cred: CredenciaisSponte,
  cursoId: number,
  opcoes: OpcoesChamada = {},
): Promise<PlanoCurso[]> {
  const xml = await chamarSoap(
    "GetPlanosCursos",
    [...credenciais(cred), ["nCursoID", cursoId], ["sParametrosBusca", ""]],
    opcoes,
  );
  return parsearPlanos(xml);
}

/**
 * Escolhe o plano a exibir quando há mais de um.
 *
 * Prefere o marcado como padrão; havendo empate, o de descrição que cita o ano
 * corrente. Esse desempate existe por um caso real: `Financial Evolution` tem
 * como padrão um plano chamado `2027`, enquanto os demais cursos usam planos de
 * 2026. Sem o critério de ano, a tela do aluno mostraria o preço do ano que vem.
 */
export function planoPreferido(planos: PlanoCurso[], ano = new Date().getFullYear()): PlanoCurso | null {
  const ativos = planos.filter((p) => p.ativo);
  if (!ativos.length) return null;

  const doAno = ativos.filter((p) => p.descricao.includes(String(ano)));
  const candidatos = doAno.length ? doAno : ativos;

  return candidatos.find((p) => p.padrao) ?? candidatos[0];
}

/* ------------------------------------------------------------------ *
 * Bolsas
 * ------------------------------------------------------------------ */

export function parsearBolsas(xmlInterno: string): Bolsa[] {
  if (lerRetornoOperacao(xmlInterno)?.codigo === RETORNO_SEM_REGISTROS) return [];

  const blocos = xmlInterno.match(/<wsBolsa>[\s\S]*?<\/wsBolsa>/g) ?? [];

  return blocos
    .map((b): Bolsa => {
      // Os descontos vêm numa lista aninhada; nesta base cada bolsa tem um só.
      const primeiro = b.match(/<wsDescontos>[\s\S]*?<\/wsDescontos>/)?.[0] ?? "";
      return {
        bolsaId: lerInteiro(b, "BolsaID"),
        descricao: lerCampo(b, "Descricao"),
        tipoDesconto: lerCampo(b, "TipoDesconto"),
        desconto: lerDecimal(primeiro, "Desconto"),
        dias: lerInteiro(primeiro, "Dias"),
      };
    })
    .filter((b) => b.bolsaId > 0);
}

export async function getBolsas(
  cred: CredenciaisSponte,
  opcoes: OpcoesChamada = {},
): Promise<Bolsa[]> {
  const xml = await chamarSoap(
    "GetBolsas",
    [...credenciais(cred), ["sTipoDesconto", ""]],
    opcoes,
  );
  return parsearBolsas(xml);
}

/* ------------------------------------------------------------------ *
 * Cálculo
 * ------------------------------------------------------------------ */

export interface ValorCalculado {
  valorParcela: number;
  parcelas: number;
  total: number;
  /** Quanto foi abatido pela bolsa. `0` quando não há bolsa. */
  descontoAplicado: number;
  /** Valor de parcela antes da bolsa. */
  valorParcelaCheia: number;
}

/**
 * Aplica uma bolsa sobre a mensalidade de um plano.
 *
 * ⚠️ **O alcance da bolsa é uma suposição, não um fato verificado.** Aplica-se
 * só sobre a mensalidade, porque o campo do plano se chama
 * `BolsaIDMensalidade` — mas nenhum plano desta escola tem bolsa vinculada, e
 * não há como conferir contra um caso real. Antes de usar isto para gerar
 * cobrança de verdade (`InsertPlano`), confirme com a Sponte se o desconto
 * incide sobre matrícula e material também.
 *
 * Enquanto isso, serve para a tela: mostra o efeito estimado de uma bolsa, sem
 * que ninguém tenha calculado à mão.
 */
export function aplicarBolsa(plano: PlanoCurso, bolsa: Bolsa | null): ValorCalculado {
  const cheia = plano.mensalidade.valorParcela;
  const parcelas = plano.mensalidade.parcelas;

  if (!bolsa || bolsa.desconto <= 0) {
    return {
      valorParcela: cheia,
      parcelas,
      total: plano.total,
      descontoAplicado: 0,
      valorParcelaCheia: cheia,
    };
  }

  const comDesconto = bolsa.tipoDesconto === "%"
    ? arredondar(cheia * (1 - bolsa.desconto / 100))
    : arredondar(Math.max(0, cheia - bolsa.desconto));

  const abatido = arredondar((cheia - comDesconto) * parcelas);

  return {
    valorParcela: comDesconto,
    parcelas,
    total: arredondar(plano.total - abatido),
    descontoAplicado: abatido,
    valorParcelaCheia: cheia,
  };
}

/** Formata em reais. Centralizado para a mesma moeda aparecer igual em toda tela. */
export function formatarBRL(valor: number): string {
  return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
