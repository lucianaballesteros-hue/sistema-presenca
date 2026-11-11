/**
 * Orquestração do cadastro com pagamento no Sponte.
 *
 * -------------------------------------------------------------------
 * A ORDEM É IMPOSTA PELA API, NÃO ESCOLHIDA
 * -------------------------------------------------------------------
 * O ideal seria "paga primeiro, matricula depois". A API não permite:
 * `GetLinkPagamentoSpontePay` exige um `nContaReceberID`, que só nasce de
 * `InsertPlano`, que precisa de um contrato, que vem de `InsertMatricula`.
 *
 * A saída é a mesma do módulo nativo do Sponte: a matrícula é criada em
 * **Pré-Matrícula** (situação -11), o aluno paga, e só então ela é promovida a
 * **Cursando** (-3) por `UpdateMatriculaV2`. O registro existe no ERP desde o
 * começo, mas o aluno não está na turma até pagar.
 *
 *     GetAlunos4 → InsertAlunos3 → InsertMatricula(-11) → InsertPlano
 *       → GetParcelas → GetLinkPagamentoSpontePay → [aluno paga]
 *       → UpdateMatriculaV2(-3)
 *
 * -------------------------------------------------------------------
 * POR QUE CADA PASSO É REGISTRADO
 * -------------------------------------------------------------------
 * São seis chamadas sem transação entre elas. Se a quarta falhar, as três
 * primeiras já aconteceram — e **o WSAPIEdu não tem nenhuma operação de
 * exclusão** entre as suas 138 (`docs/API-SPONTE.md` §8). Não há rollback.
 *
 * Por isso `executarMatricula()` recebe e devolve um `ProgressoMatricula`:
 * retomar de onde parou é a única forma de corrigir uma falha no meio, e
 * repetir um passo já concluído criaria duplicata no ERP.
 */

import {
  chamarSoap,
  type CredenciaisSponte,
  credenciais,
  type OpcoesChamada,
  SponteError,
} from "./soap.ts";

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
 * Situações
 * ------------------------------------------------------------------ */

/**
 * Situações do aluno na turma (`GetSituacoesAlunosTurma`, base real 05/10/2026).
 * São 17; estas são as que o fluxo usa.
 */
export const SITUACAO_TURMA = {
  PRE_MATRICULA: -11,
  CURSANDO: -3,
  DESISTENTE: -8,
  INATIVO: -7,
} as const;

/**
 * Situação do CONTRATO — levantada de matrículas reais via `GetMatriculas`
 * (06/10/2026). É o que `InsertMatricula.nSituacao` espera.
 *
 * ⚠️ **Não confundir com `SITUACAO_TURMA`.** São duas coisas distintas, e a
 * tela do Sponte mostra as duas lado a lado: "Situação do Contrato: Vigente" e
 * "Situação do Aluno: Cursando". O `InsertMatricula` só tem um campo de
 * situação, e os valores observados (1 e 2) batem com os do contrato — não com
 * os −11/−3 da turma.
 */
export const SITUACAO_CONTRATO = {
  VIGENTE: 1,
  ENCERRADO: 2,
} as const;

/**
 * Tipo de contrato. Observados `-1` e `-2` nas matrículas reais; na tela do
 * Sponte o campo aparece como "Tipo de Contrato: Matrícula".
 * ⚠️ Qual dos dois é "Matrícula" e qual é o outro ainda não foi confirmado.
 */
export const TIPO_CONTRATO_PADRAO = -1;

/**
 * Categorias financeiras (`GetCategorias`, base real 07/10/2026).
 *
 * `nCategoriaID` é obrigatório em `InsertPlano` — sem um valor válido o Sponte
 * recusa com "17 - CategoriaID (Inválida)". O zero não serve.
 */
export const CATEGORIA = {
  MENSALIDADE: 3,
  MATERIAL_DIDATICO: 4,
  TAXA_MATRICULA: 6,
} as const;

/**
 * Tipo de plano — é o que decide em qual aba do contrato a cobrança aparece.
 *
 * **Confirmado contra produção em 09/10/2026.** Antes estava `1`, e o Sponte
 * aceitava sem reclamar: as 10 mensalidades do primeiro cadastro real foram
 * lançadas como **Material Didático**, com a aba Mensalidades zerada. Não há
 * mensagem de erro para esse engano — só aparece olhando o contrato.
 *
 * O valor foi descoberto aplicando `UpdatePlano` e relendo o rótulo em
 * `GetFinanceiro3`, que devolve "Mensalidades" ou "Material Didático".
 * O domínio completo segue sem documentação (§10).
 */
/**
 * `nTipoPlano` decide em que **aba do contrato** a cobrança aparece. A
 * categoria decide o que ela é (o rótulo da linha). São eixos diferentes, e
 * confundi-los custou caro.
 *
 * Mapeado contra produção em 23/10/2026, criando um plano de cada tipo no
 * contrato 1160 e olhando a tela:
 *
 * | tipo | aba |
 * |---|---|
 * | 0 | Mensalidades |
 * | 1 | Material Didático |
 * | 2 | Taxa de matrícula |
 * | 3 | Outros Planos |
 *
 * **O tipo também é a chave de unicidade do plano no contrato.** O Sponte
 * recusa o segundo com "76 - Já existe um plano financeiro cadastrado neste
 * contrato para o tipo de plano informado". Duas cobranças no mesmo contrato
 * só coexistem em tipos diferentes — e era por isso que a taxa, que usava o
 * tipo 0 como as mensalidades, teria derrubado uma das duas na primeira
 * matrícula de um plano com taxa configurada.
 */
/**
 * Dias **úteis** entre o preenchimento do formulário e o vencimento da
 * cobrança que o aluno paga agora.
 *
 * É o tempo de receber o link, abrir e pagar antes de vencer. Foi 5 dias
 * corridos até 26/10/2026, depois 4, e no mesmo dia virou 3 úteis: contar
 * corrido fazia quem se cadastrava na quinta vencer no domingo, sem banco
 * aberto no meio.
 *
 * Mora aqui porque é aqui que os planos nascem — `checkout.ts` importa
 * desta constante, e o inverso faria ciclo de importação. O front repete a
 * regra em `admin-turmas.html`; mudando aqui, mude lá.
 */
export const DIAS_UTEIS_ATE_COBRAR = 3;

/**
 * Soma dias úteis a uma data, pulando sábado e domingo.
 *
 * **Não considera feriado.** Levar feriado em conta exigiria um calendário
 * mantido em algum lugar, e um calendário desatualizado erraria com a
 * confiança de quem acha que está certo. Cair num feriado adia o pagamento
 * em um dia; é o erro barato dos dois.
 */
export function somarDiasUteis(inicio: Date, dias: number): Date {
  const d = new Date(inicio);
  let faltam = Math.max(Math.trunc(dias) || 0, 0);

  while (faltam > 0) {
    d.setDate(d.getDate() + 1);
    const semana = d.getDay();
    if (semana !== 0 && semana !== 6) faltam--;
  }
  return d;
}

export const TIPO_PLANO = {
  MENSALIDADE: 0,
  MATERIAL: 1,
  TAXA_MATRICULA: 2,
  OUTROS: 3,
} as const;

/** @deprecated Use `TIPO_PLANO.MENSALIDADE`. */
export const TIPO_PLANO_MENSALIDADE = TIPO_PLANO.MENSALIDADE;

/**
 * Conta bancária que recebe a cobrança (`GetContas`).
 *
 * Estava indo vazia, e vazio vira `ContaID` 0 — nenhuma conta. Toda cobrança
 * de aluno real desta escola usa a conta 2 (Inter), e sem ela é provável que
 * a régua não tenha onde emitir a fatura do Sponte Pay.
 */
export const CONTA_CREDITO_PADRAO = 2;

/** Situações do aluno (`GetSituacoesAlunos`). */
export const SITUACAO_ALUNO = {
  ATIVO: -1,
  INATIVO: -2,
  INTERESSADO: -3,
  FORMADO: -4,
  DESISTENTE: -5,
} as const;

/* ------------------------------------------------------------------ *
 * Progresso
 * ------------------------------------------------------------------ */

export type PassoMatricula =
  | "verificar_cpf"
  | "criar_aluno"
  | "criar_responsavel"
  | "criar_matricula"
  | "criar_taxa"
  | "criar_plano"
  | "criar_plano_demais"
  | "ajustar_vencimentos"
  | "localizar_parcela"
  | "gerar_link";

export const PASSOS: PassoMatricula[] = [
  "verificar_cpf", "criar_aluno", "criar_responsavel", "criar_matricula",
  "criar_taxa", "criar_plano", "criar_plano_demais", "ajustar_vencimentos",
  "localizar_parcela", "gerar_link",
];

/**
 * Tipo de pessoa do responsável. Domínio confirmado pelo próprio erro do
 * Sponte: "35 - Tipo pessoa inválido. (1-Física / 2-Jurídica)".
 */
export const TIPO_PESSOA = { FISICA: 1, JURIDICA: 2 } as const;

/**
 * Parentesco. `0` é o aceito para o próprio aluno como responsável; `1`
 * devolve "31 - Parentesco inválido". Os demais códigos não foram levantados.
 */
export const PARENTESCO_PROPRIO_ALUNO = 0;

/**
 * O que já aconteceu no ERP.
 *
 * Cada campo preenchido é um passo que **não pode ser repetido**. Um
 * `sponteAlunoId` presente significa que o aluno existe lá — refazer
 * `InsertAlunos3` criaria um segundo, sem como apagar o primeiro.
 */
export interface ProgressoMatricula {
  sponteAlunoId: number | null;
  alunoJaExistia: boolean;
  /**
   * Os dados do aluno existente já foram atualizados neste cadastro.
   *
   * Vale dentro de uma execução. Numa retomada o campo volta como `false`
   * e a atualização roda outra vez — inofensivo, porque grava o mesmo
   * conteúdo, e preferível a supor que já aconteceu.
   */
  dadosAtualizados: boolean;
  /**
   * Responsável financeiro — o "sacado" da cobrança.
   *
   * Sem ele o aluno existe mas não há a quem cobrar. Para maior de idade, é o
   * próprio aluno; para menor, o responsável informado no cadastro.
   */
  responsavelId: number | null;
  /**
   * Conta a receber da taxa de matrícula, quando o plano tem uma.
   *
   * Guardada porque o Sponte **não exclui por API**: sem isto, refazer o
   * checkout de uma ficha em erro criaria uma segunda taxa, e a segunda
   * sairia a mão, na tela deles (SPEC-002 RN-09).
   *
   * `null` quando o plano não tem taxa — o caso dos cinco planos da
   * escola em 21/10/2026.
   */
  contaTaxaId: number | null;
  /**
   * Quanto foi cobrado agora, na aba de taxa de matrícula.
   *
   * Nem sempre é o `valorTaxa` do plano: quando o plano não tem taxa e a
   * turma é futura, o que vai para lá é uma parcela da mensalidade. A ficha
   * precisa do valor real para a conferência bater com o extrato do ERP.
   */
  valorCobradoAgora: number | null;
  /**
   * O responsável já existia no ERP e foi reusado pelo CPF.
   *
   * Importa porque a API **não liga** responsável existente a aluno novo
   * (conferido: `UpdateCompartilhaResponsavel` não adiciona,
   * `UpdateResponsaveis2` estoura, `InsertResponsaveis2` recusa CPF
   * repetido). Esse vínculo se faz na tela do Sponte, e esta marca é como
   * a escola descobre quais matrículas precisam disso.
   */
  responsavelReusado: boolean;
  contratoId: number | null;
  /**
   * O plano financeiro já foi gravado.
   *
   * Campo próprio, e não derivado de `contaReceberId`: o plano é criado no
   * passo 4 e a parcela localizada no passo 5. Se o 5 falhar, usar o
   * `contaReceberId` como marcador faria o 4 rodar de novo na retomada — e o
   * Sponte recusa com "76 - Já existe um plano financeiro cadastrado".
   */
  planoCriado: boolean;
  /**
   * O plano das mensalidades que começam com o curso já foi gravado.
   *
   * Quando a turma é futura, as mensalidades saem em **dois** planos: um
   * com a parcela adiantada, que reserva a vaga, e outro com as demais a
   * partir do início do curso — o `InsertPlano` aceita uma data inicial só
   * e espaça as parcelas mês a mês a partir dela.
   *
   * Marcador próprio pelo mesmo motivo de `planoCriado`: o Sponte não
   * exclui por API, e uma retomada que recriasse este plano daria ao aluno
   * um segundo conjunto de mensalidades.
   *
   * `false` sem ser um erro quando não há nada a adiar — turma já iniciada
   * ou plano de parcela única.
   */
  planoDemaisCriado: boolean;
  /**
   * As parcelas 2 a N já foram movidas para o início do curso.
   *
   * Numa retomada volta como `false` e o passo roda de novo — inofensivo:
   * ele só mexe no que ainda está fora da data.
   */
  vencimentosAjustados?: boolean;
  contaReceberId: number | null;
  numeroParcela: string | null;
  linkPagamento: string | null;
  /**
   * A matrícula e a cobrança existem, mas a fatura do Sponte Pay ainda não foi
   * gerada — então não há link para dar ao aluno.
   *
   * É o desfecho esperado, não uma falha: o Sponte não expõe API para gerar a
   * fatura. Quem gera é a régua de cobrança ou alguém na tela de Faturas.
   */
  aguardandoFatura: boolean;
  /** Último passo concluído com sucesso. */
  ultimoPasso: PassoMatricula | null;
  erro: string | null;
  erroPasso: PassoMatricula | null;
}

export function progressoVazio(): ProgressoMatricula {
  return {
    sponteAlunoId: null, alunoJaExistia: false, dadosAtualizados: false,
    responsavelReusado: false,
    responsavelId: null, contaTaxaId: null, valorCobradoAgora: null,
    contratoId: null,
    planoCriado: false, planoDemaisCriado: false, vencimentosAjustados: false,
    contaReceberId: null, numeroParcela: null,
    linkPagamento: null, aguardandoFatura: false,
    ultimoPasso: null, erro: null, erroPasso: null,
  };
}

export interface DadosMatricula {
  nome: string;
  cpf: string;
  dataNascimento: string | null;   // ISO aaaa-mm-dd
  email: string | null;
  celular: string | null;
  sexo?: string | null;
  rg?: string | null;
  estadoCivil?: string | null;
  nacionalidade?: string | null;
  cidadeNatal?: string | null;
  profissao?: string | null;
  telefone?: string | null;

  cep?: string | null;
  endereco?: string | null;
  numeroEndereco?: string | null;
  complemento?: string | null;
  bairro?: string | null;
  cidade?: string | null;
  uf?: string | null;

  origemVenda?: string | null;

  /**
   * Responsável legal, quando o aluno é menor. Vazio para maior de idade — aí
   * o próprio aluno vira o responsável financeiro.
   */
  responsavelNome?: string | null;
  responsavelCpf?: string | null;
  responsavelEmail?: string | null;
  responsavelCelular?: string | null;

  sponteTurmaId: number;
  sponteCursoId: number;
  /**
   * Fim da turma, em ISO. Vira a data de término do contrato — o Sponte recusa
   * `InsertMatricula` sem ela ("36 - Informe a data de término do contrato").
   * Sem este valor, caímos em 31/12 do ano corrente.
   */
  turmaDataTermino?: string | null;
  /**
   * Vencimento da parcela que o aluno paga agora, ISO `aaaa-mm-dd`.
   *
   * Ausente, cai no comportamento antigo: hoje + 5 dias.
   */
  primeiroVencimento?: string | null;
  /**
   * A partir de quando correm as **demais** mensalidades, ISO.
   *
   * Preenchido só para turma que ainda não começou. Então as mensalidades
   * saem em dois planos: a primeira em `primeiroVencimento`, as outras
   * `parcelas - 1` a partir desta data.
   *
   * `null` ou ausente é o caso comum e o antigo: um plano único de
   * `parcelas` parcelas a partir de `primeiroVencimento`.
   */
  inicioDasDemais?: string | null;
  /** Taxa de matrícula por parcela, do plano do Sponte. `null` = sem taxa. */
  valorTaxa?: number | null;
  /** Em quantas vezes a taxa é cobrada. Quase sempre 1. */
  parcelasTaxa?: number | null;

  planoCursoId: number | null;
  bolsaId: number | null;
  /** Mensalidade do plano. Usada para mostrar a condição, não para cobrar. */
  valorParcela: number;
  /** Quantas mensalidades o plano tem. Idem: é informação, não cobrança. */
  parcelas: number;
  /**
   * O que vai ser cobrado, de uma vez só.
   *
   * Quando ausente, vale `valorParcela × parcelas`. Existe como campo próprio
   * porque o total do contrato pode não ser o produto exato — arredondamento
   * de bolsa, primeira parcela diferente — e nesse caso quem manda é o que a
   * escola combinou, não a nossa multiplicação.
   */
  valorTotal?: number | null;

  formaCobrancaId: number;
  parcelasCartao: number;

  observacao?: string;
}

export interface OpcoesMatricula extends OpcoesChamada {
  /**
   * **Trava de escrita.** Enquanto `true`, nada é gravado no ERP: cada passo
   * devolve um valor simulado e o progresso avança.
   *
   * O padrão é `true` de propósito. O token em uso é de **produção**, não há
   * ambiente de teste confirmado (`docs/API-SPONTE.md` §10, pergunta 1), e
   * nenhuma das 138 operações apaga o que for criado por engano. Ligar a
   * escrita é uma decisão consciente, não o comportamento normal.
   */
  simular?: boolean;

  /**
   * Marca o registro como teste no ERP.
   *
   * Existe porque o WSAPIEdu não tem exclusão: um aluno criado por engano sai
   * só na mão, pela interface do Sponte. Com isto ligado, o nome recebe um
   * prefixo e a observação diz o que é — então quem for limpar consegue achar
   * os registros filtrando por nome, em vez de caçar um a um.
   */
  marcarComoTeste?: boolean;
}

/**
 * Prefixo de nome para registros de teste. Buscável no filtro do Sponte.
 *
 * ⚠️ **Sem colchetes.** O Sponte monta SQL concatenando o valor e escapa `[`
 * e `]` como `' + Char(91) + '` — e esse escape vai parar no banco. Um nome
 * com colchete vira "' + Char(91) + 'TESTE' + Char(93) + '" no cadastro.
 * Vale para qualquer texto enviado ao ERP, não só para este prefixo.
 */
export const PREFIXO_TESTE = "TESTE-SISTEMA";

/**
 * Tira do texto os caracteres que o Sponte estraga ao gravar.
 *
 * Colchetes viram `' + Char(91) + '` **dentro do banco** — não é só exibição.
 * O estrago é silencioso no cadastro, mas aparece depois: em 10/10/2026 um
 * aluno chamado "[Teste] Ismael" virou
 * `' + Char(91) + 'Teste' + Char(93) + ' Ismael` e o Sponte Pay **recusou
 * gerar o link de pagamento** para ele, com "Erro ao gerar Link". Outro aluno,
 * mesmo valor e nome limpo, gerou sem problema.
 *
 * Só os colchetes são removidos porque só eles foram confirmados. Apóstrofo
 * fica: é comum em nome brasileiro ("D'Ávila") e o Sponte lida com ele.
 */
export function textoSeguroParaSponte(texto: string): string {
  return texto.replace(/[[\]]/g, "").replace(/\s{2,}/g, " ").trim();
}

/* ------------------------------------------------------------------ *
 * Passos
 * ------------------------------------------------------------------ */

const soDigitos = (s: string) => s.replace(/\D/g, "");

/**
 * Monta a observação do aluno.
 *
 * É aqui que a indicação ("quem indicou / de onde conheceu") é preservada,
 * porque o campo próprio do Sponte não pode ser usado enquanto não houver
 * origens cadastradas — ver o comentário em `sOrigemNome`.
 */
function montarObservacao(d: DadosMatricula, teste: boolean): string {
  const partes: string[] = [];

  if (teste) {
    partes.push(
      `REGISTRO DE TESTE criado em ${new Date().toLocaleString("pt-BR")} ` +
      `pelo sistema de cadastro online. Pode ser excluído.`,
    );
  } else {
    partes.push(d.observacao ?? "Cadastro online");
  }

  if (d.origemVenda?.trim()) {
    partes.push(`Indicação / como conheceu: ${d.origemVenda.trim()}`);
  }

  // O contato do aluno menor sai dos campos próprios (ver contatoNoSponte),
  // mas não some: fica aqui para a escola falar com ele sobre as aulas.
  if (temResponsavel(d)) {
    const proprio = [d.email?.trim(), d.celular ? soDigitos(d.celular) : ""].filter(Boolean);
    if (proprio.length) partes.push(`Contato do aluno: ${proprio.join(" · ")}`);
  }
  return partes.join(" | ");
}

const temResponsavel = (d: DadosMatricula) => !!d.responsavelNome?.trim();

/**
 * E-mail e celular gravados no cadastro do **aluno** no Sponte.
 *
 * A régua de cobrança do Sponte dispara para o contato do aluno, não para o do
 * responsável financeiro. Com o contato do menor ali, o link de pagamento ia
 * para o celular da criança, e não para quem paga (cadastro 566, 30/10/2026).
 * Por isso, havendo responsável, os campos de contato do aluno levam os dele.
 */
export function contatoNoSponte(d: DadosMatricula): { email: string; celular: string } {
  const r = temResponsavel(d);
  return {
    email: ((r ? d.responsavelEmail : d.email) ?? "").trim(),
    celular: soDigitos((r ? d.responsavelCelular : d.celular) ?? ""),
  };
}

/**
 * Junta o complemento com o número quando o número não é numérico.
 *
 * O Sponte exige número numérico (`nNumeroEndereco` vira Double). Quem mora em
 * "s/n" ou "144-A" perderia essa informação — então ela vai para o complemento,
 * que é texto livre.
 */
function complementoComNumero(d: DadosMatricula): string {
  const bruto = (d.numeroEndereco ?? "").trim();
  const soNumero = soDigitos(bruto);
  const base = (d.complemento ?? "").trim();

  // Número puramente numérico já cabe no campo próprio: nada a acrescentar.
  if (!bruto || soNumero === bruto) return base;

  return base ? `${base} — nº ${bruto}` : `nº ${bruto}`;
}

/** `aaaa-mm-dd` → `dd/mm/aaaa`, o formato que o Sponte devolve nas leituras. */
function isoParaBr(iso: string | null): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/**
 * Passo 1 — o aluno já existe?
 *
 * Código 43 ("nenhum registro") é a resposta **desejada**: significa que o CPF
 * não está na base e o cadastro pode seguir. Ver `docs/API-SPONTE.md` §9.3.
 */
async function verificarCpf(
  cred: CredenciaisSponte, cpf: string, opc: OpcoesChamada,
): Promise<number[]> {
  const xml = await chamarSoap(
    "GetAlunos4",
    [...credenciais(cred), ["sParametrosBusca", `CPF=${soDigitos(cpf)}`]],
    opc,
  );

  // Todos, não o primeiro. Um CPF repetido no Sponte (digitação errada, ou
  // cadastro refeito pela tela) faria a escolha silenciosa cair na pessoa
  // errada — e a cobrança iria para ela.
  return [...new Set(
    [...xml.matchAll(/<AlunoID>(\d+)<\/AlunoID>/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n > 0),
  )];
}

/**
 * Atualiza o aluno que já existia com o que o formulário trouxe.
 *
 * Sem isto, quem já está no Sponte fica congelado nos dados antigos: foi o
 * que aconteceu no primeiro cadastro real: o CPF casou com um registro de
 * sondagem e o nome verdadeiro nunca chegou lá.
 *
 * Só sobrescreve campo que veio preenchido. O resto é reenviado com o valor
 * atual, porque `UpdateAlunos3` grava tudo que recebe — mandar vazio
 * apagaria o que já estava certo.
 */
async function atualizarAlunoExistente(
  cred: CredenciaisSponte, d: DadosMatricula, alunoId: number,
  opc: OpcoesChamada, teste = false,
): Promise<void> {
  const atual = await chamarSoap("GetAlunos4",
    [...credenciais(cred), ["sParametrosBusca", `AlunoID=${alunoId}`]], opc);
  const lido = (n: string) => atual.match(new RegExp(`<${n}>([^<]*)</${n}>`))?.[1] ?? "";

  /** O do formulário quando houver; senão o que já está lá. */
  const ou = (novo: string | null | undefined, campo: string) =>
    (novo ?? "").trim() || lido(campo);

  const nome = textoSeguroParaSponte(teste ? `${PREFIXO_TESTE} ${d.nome}` : d.nome);

  await chamarSoap("UpdateAlunos3", [
    ...credenciais(cred),
    ["nAlunoID", alunoId],
    ["sNome", nome],
    ["sMidia", ""],
    ["dDataNascimento", d.dataNascimento ? new Date(`${d.dataNascimento}T00:00:00`) : null],
    ["sCidade", ou(d.cidade, "Cidade")],
    ["sBairro", ou(d.bairro, "Bairro")],
    ["sCEP", soDigitos(ou(d.cep, "CEP"))],
    ["sEndereco", ou(d.endereco, "Endereco")],
    ["nNumeroEndereco", soDigitos(d.numeroEndereco ?? lido("NumeroEndereco")) || "0"],
    ["sComplementoEndereco", complementoComNumero(d)],
    ["sCPF", soDigitos(d.cpf)],
    ["sRG", ou(d.rg, "RG")],
    // Reenviados como estão: zerá-los deixaria a cobrança sem sacado.
    ["nResponsavelFinanceiroID", lido("ResponsavelFinanceiroID")],
    ["nResponsavelDidaticoID", lido("ResponsavelDidaticoID")],
    // Com responsável, o contato dele: é para cá que a régua manda a cobrança.
    ["sEmail", ou(contatoNoSponte(d).email, "Email")],
    ["sTelefone", soDigitos(ou(d.telefone, "Telefone"))],
    ["sCelular", soDigitos(ou(contatoNoSponte(d).celular, "Celular"))],
    ["sObservacao", montarObservacao(d, teste)],
    ["sSexo", ou(d.sexo, "Sexo")],
    ["sProfissao", ou(d.profissao, "Profissao")],
    ["sCidadeNatal", ou(d.cidadeNatal, "CidadeNatal")],
    ["sRa", lido("RA")],
    ["sNumeroMatricula", lido("NumeroMatricula")],
    ["sSituacao", lido("Situacao") || String(SITUACAO_ALUNO.INTERESSADO)],
    ["sCursoInteresse", ""], ["sInfoBloqueada", ""],
    ["sOrigemNome", ""], ["nOrigemID", ""],
  ], opc);
}

async function criarAluno(
  cred: CredenciaisSponte, d: DadosMatricula, opc: OpcoesChamada, teste = false,
): Promise<number> {
  const xml = await chamarSoap(
    "InsertAlunos3",
    [
      ...credenciais(cred),
      ["sNome", textoSeguroParaSponte(teste ? `${PREFIXO_TESTE} ${d.nome}` : d.nome)],
      ["sMidia", ""],
      ["dDataNascimento", d.dataNascimento ? new Date(`${d.dataNascimento}T00:00:00`) : null],
      ["sCidade", d.cidade ?? ""],
      ["sBairro", d.bairro ?? ""],
      ["sCEP", d.cep ? soDigitos(d.cep) : ""],
      ["sEndereco", d.endereco ?? ""],
      // ⚠️ Prefixo `n` e tipo `string` no WSDL, mas o Sponte converte para
      // Double internamente: string vazia ou "s/n" derrubam a chamada com
      // "Conversion from string to type 'Double' is not valid". Mandamos só
      // dígitos, e 0 quando não houver — o texto original vai no complemento.
      ["nNumeroEndereco", soDigitos(d.numeroEndereco ?? "") || "0"],
      ["sComplementoEndereco", complementoComNumero(d)],
      // Com responsável, o contato dele: é para cá que a régua manda a cobrança.
      ["sEmail", contatoNoSponte(d).email],
      ["sTelefone", d.telefone ? soDigitos(d.telefone) : ""],
      ["sCPF", soDigitos(d.cpf)],
      ["sRG", d.rg ?? ""],
      ["sCelular", contatoNoSponte(d).celular],
      ["sObservacao", montarObservacao(d, teste)],
      // ⚠️ O domínio de sSexo não é documentado (§10, pergunta 4). Mandamos o
      // que o formulário coletou; se a Sponte recusar, o erro aparece no retorno.
      ["sSexo", d.sexo ?? ""],
      ["sProfissao", d.profissao ?? ""],
      ["sCidadeNatal", d.cidadeNatal ?? ""],
      ["sRa", ""], ["sNumeroMatricula", ""],
      // Interessado, não Ativo: ele só vira aluno de fato quando o pagamento
      // confirma e a matrícula é promovida.
      ["sSituacao", String(SITUACAO_ALUNO.INTERESSADO)],
      ["sCursoInteresse", ""], ["sInfoBloqueada", ""],
      // ⚠️ **Origem vai SEMPRE vazia, de propósito.**
      //
      // `GetOrigensAlunos` devolve código 43 nesta base: não há nenhuma origem
      // cadastrada. Mandar um nome faz o Sponte buscá-la, não encontrar, e
      // quebrar com "Conversion from string \"\" to type 'Double' is not valid"
      // — um erro que não cita a origem em lugar nenhum e levou a procurar o
      // problema em todos os outros campos.
      //
      // A indicação do aluno não se perde: vai na observação, por
      // `montarObservacao()`. Para usar o campo próprio, a escola precisa antes
      // cadastrar as origens no Sponte (ou usar `InsertOrigem`).
      ["sOrigemNome", ""],
      ["nOrigemID", ""],
    ],
    opc,
  );

  const id = xml.match(/<AlunoID>(\d+)<\/AlunoID>/)?.[1];
  if (!id || Number(id) <= 0) {
    // ⚠️ A estrutura de retorno dos Insert* não é documentada (§10, pergunta 6).
    // Se o aluno foi criado e não conseguimos ler o id, ele fica órfão no ERP —
    // por isso a mensagem precisa carregar a resposta crua para diagnóstico.
    throw new SponteError(
      "resposta_invalida", "InsertAlunos3",
      "Aluno pode ter sido criado, mas o AlunoID não foi encontrado na resposta.",
      xml.slice(0, 1000),
    );
  }
  return Number(id);
}

/**
 * Passo 3 — define quem paga.
 *
 * Sem responsável financeiro o aluno existe mas não há sacado para a cobrança:
 * `ResponsavelFinanceiroID` fica `0`, e nenhuma fatura pode ser emitida em
 * nome dele. Para maior de idade, o próprio aluno assume o papel.
 */
/**
 * Responsável financeiro já vinculado ao aluno, ou `null`.
 *
 * Verificado contra produção: aluno com responsável devolve o id (1002→540,
 * 1004→541); aluno sem responsável devolve `ResponsavelID` 0; aluno
 * inexistente devolve "02 - Parâmetros de busca inválidos", que aqui também
 * significa "não achei" — não é motivo para abortar a matrícula.
 */
async function buscarResponsavelFinanceiro(
  cred: CredenciaisSponte, alunoId: number, opc: OpcoesChamada,
): Promise<number | null> {
  let xml: string;
  try {
    xml = await chamarSoap(
      "GetResponsavelFinanceiro",
      [...credenciais(cred), ["sParametrosBusca", `AlunoID=${alunoId}`]],
      opc,
    );
  } catch (erro) {
    if (erro instanceof SponteError && erro.codigo === 2) return null;
    throw erro;
  }

  const id = xml.match(/<ResponsavelID>(\d+)<\/ResponsavelID>/)?.[1];
  return id && Number(id) > 0 ? Number(id) : null;
}

/**
 * O responsável que já existe no Sponte com este CPF, ou `null`.
 *
 * `buscarResponsavelFinanceiro` responde "este **aluno** já tem
 * responsável?". Esta responde "esta **pessoa** já está cadastrada?" — que
 * é outro caso e o que derrubou a primeira matrícula de menor em produção:
 *
 *     29 - O CPF informado já está associado a outro cadastro.
 *
 * Acontece sempre que o responsável já aparece no ERP por outro motivo:
 * foi aluno, é responsável de um irmão, ou entrou num cadastro anterior.
 * Numa escola, é o caso comum, não a exceção.
 *
 * Conferido contra produção em 16/10/2026: `GetResponsaveis2` com
 * `sParametrosBusca = "CPF=04084316016"` devolve `ResponsavelID=540`.
 * A chave é `CPF`; `CPFResponsavel` não é reconhecida e cai em
 * "21 - Informe pelo menos um parâmetro de busca".
 */
async function buscarResponsavelPorCpf(
  cred: CredenciaisSponte, cpf: string, opc: OpcoesChamada,
): Promise<number | null> {
  const digitos = soDigitos(cpf);
  if (digitos.length !== 11) return null;

  let xml: string;
  try {
    xml = await chamarSoap(
      "GetResponsaveis2",
      [...credenciais(cred), ["sParametrosBusca", `CPF=${digitos}`]],
      { ...opc, ignorarRetornoOperacao: true },
    );
  } catch (erro) {
    // Busca que falha não pode derrubar a matrícula: sem resposta, segue
    // para a criação, que é o caminho que existia antes.
    if (erro instanceof SponteError) return null;
    throw erro;
  }

  const id = xml.match(/<ResponsavelID>(\d+)<\/ResponsavelID>/)?.[1];
  return id && Number(id) > 0 ? Number(id) : null;
}

/**
 * A matrícula precisa de um responsável financeiro separado do aluno?
 *
 * Só quando o cadastro informa **outra pessoa** — o caso do menor. Sem
 * responsável informado, quem paga é o próprio aluno, e ele já está no
 * Sponte: é o que a escola faz à mão com aluno maior de idade.
 *
 * Até 10/11/2026 o aluno maior ganhava um segundo cadastro, de
 * responsável, com o **mesmo CPF** ("O próprio aluno"). Nas matrículas
 * feitas assim o cartão recorrente do Sponte Pay não salvava: o Sponte
 * recebia o cartão, respondia sucesso e não gravava — reproduzido duas
 * vezes, com HAR. As manuais de adulto não têm responsável.
 *
 * Responsável informado com o CPF do próprio aluno conta como "sem
 * responsável": seria a mesma duplicação.
 */
export function precisaDeResponsavel(
  d: { cpf?: string | null; responsavelNome?: string | null; responsavelCpf?: string | null },
): boolean {
  if (!d.responsavelNome?.trim()) return false;
  const doResp = soDigitos(d.responsavelCpf ?? "");
  return !doResp || doResp !== soDigitos(d.cpf ?? "");
}

async function criarResponsavel(
  cred: CredenciaisSponte, d: DadosMatricula, alunoId: number, opc: OpcoesChamada, teste = false,
): Promise<number | null> {
  const temResponsavel = !!d.responsavelNome?.trim();
  const nome = temResponsavel ? d.responsavelNome!.trim() : d.nome;
  const cpf = temResponsavel ? (d.responsavelCpf ?? "") : d.cpf;

  const xml = await chamarSoap(
    "InsertResponsaveis2",
    [
      ...credenciais(cred),
      ["sNome", textoSeguroParaSponte(teste ? `${PREFIXO_TESTE} ${nome}` : nome)],
      ["dDataNascimento", d.dataNascimento ? new Date(`${d.dataNascimento}T00:00:00`) : null],
      // 0 é o único parentesco aceito nos testes; 1 devolve "31 - inválido".
      ["nParentesco", PARENTESCO_PROPRIO_ALUNO],
      ["sCEP", d.cep ? soDigitos(d.cep) : ""],
      ["sEndereco", d.endereco ?? ""],
      ["nNumeroEndereco", soDigitos(d.numeroEndereco ?? "") || "0"],
      ["sRG", d.rg ?? ""],
      ["sCPFCNPJ", soDigitos(cpf)],
      ["sCidade", d.cidade ?? ""], ["sBairro", d.bairro ?? ""],
      ["sEmail", contatoNoSponte(d).email],
      ["sTelefone", ""],
      ["sCelular", contatoNoSponte(d).celular],
      ["nAlunoID", alunoId],
      ["lResponsavelFinanceiro", "true"],
      ["lResponsavelDidatico", "true"],
      ["sObservacao", temResponsavel ? "Responsável informado no cadastro online" : "O próprio aluno"],
      ["sSexo", d.sexo ?? ""], ["sProfissao", d.profissao ?? ""],
      ["nTipoPessoa", TIPO_PESSOA.FISICA],
      ["sComplementoEndereco", d.complemento ?? ""],
    ],
    opc,
  );

  const id = xml.match(/<ResponsavelID>(\d+)<\/ResponsavelID>/)?.[1];
  return id && Number(id) > 0 ? Number(id) : null;
}

/**
 * Matrícula vigente do aluno naquela turma, ou `null`.
 *
 * Verificado contra produção: `AlunoID=1002;TurmaID=135` devolve o contrato
 * 1135 com `SituacaoID` 1 e `FinanceiroLancado` SIM. Aluno sem matrícula
 * devolve um bloco com `ContratoID` 0 — daí o filtro por id positivo.
 *
 * Só interessa a matrícula **vigente**: uma encerrada não impede nova
 * matrícula na mesma turma, então reaproveitá-la prenderia o aluno a um
 * contrato morto.
 */
async function buscarMatriculaVigente(
  cred: CredenciaisSponte, alunoId: number, turmaId: number, opc: OpcoesChamada,
): Promise<{ contratoId: number; financeiroLancado: boolean } | null> {
  let xml: string;
  try {
    xml = await chamarSoap(
      "GetMatriculas",
      [...credenciais(cred), ["sParametrosBusca", `AlunoID=${alunoId};TurmaID=${turmaId}`]],
      opc,
    );
  } catch (erro) {
    // "02 - Parâmetros de busca inválidos" é o que volta para aluno que não
    // existe; aqui significa apenas "não achei".
    if (erro instanceof SponteError && erro.codigo === 2) return null;
    throw erro;
  }

  for (const bloco of xml.split("<wsMatricula>").slice(1)) {
    const ler = (campo: string) =>
      bloco.match(new RegExp(`<${campo}>([^<]*)</${campo}>`))?.[1] ?? "";

    const contratoId = Number(ler("ContratoID"));
    if (!contratoId) continue;
    if (Number(ler("SituacaoID")) !== SITUACAO_CONTRATO.VIGENTE) continue;

    return {
      contratoId,
      financeiroLancado: ler("FinanceiroLancado").trim().toUpperCase() === "SIM",
    };
  }
  return null;
}

async function criarMatricula(
  cred: CredenciaisSponte, d: DadosMatricula, alunoId: number, opc: OpcoesChamada,
): Promise<number | null> {
  const hoje = new Date();

  // O contrato termina quando a turma termina. Sem a data da turma, 31/12 do
  // ano corrente — é o que as matrículas reais usam (01/01 a 31/12).
  const termino = d.turmaDataTermino
    ? isoParaBr(d.turmaDataTermino)
    : `31/12/${hoje.getFullYear()}`;

  const xml = await chamarSoap(
    "InsertMatricula",
    [
      ...credenciais(cred),
      // ⚠️ Situação do CONTRATO, não do aluno na turma. Ver SITUACAO_CONTRATO.
      // O contrato nasce vigente; quem controla "ainda não pagou" é a nossa
      // staging, porque InsertMatricula não expõe a situação do aluno na turma.
      ["nSituacao", SITUACAO_CONTRATO.VIGENTE],
      ["nAlunoID", alunoId],
      ["nCursoID", d.sponteCursoId],
      ["nTurmaID", String(d.sponteTurmaId)],   // declarado string no WSDL
      ["nTipoContratoID", TIPO_CONTRATO_PADRAO],   // -1, observado em produção
      ["dDataInicio", isoParaBr(hoje.toISOString().slice(0, 10))],
      ["dDataTermino", termino],
      ["dDataMatricula", hoje],
      ["nTipo", 1],                            // valor observado em todas as matrículas reais
      ["sDisciplinas", ""],
      ["nModulo", ""], ["nContratante", ""], ["nNumeroHoras", ""],
      ["sObservacao", d.observacao ?? "Pré-matrícula via cadastro online"],
    ],
    opc,
  );
  const id = xml.match(/<ContratoID>(\d+)<\/ContratoID>/)?.[1];
  return id && Number(id) > 0 ? Number(id) : null;
}

/**
 * Quanto vale cada mensalidade: o total dividido pelo número escolhido.
 *
 * Divide a partir do total em vez de usar `valorParcela` direto porque o
 * aluno pode ter escolhido um número diferente do que o plano traz — quem
 * pede 3 vezes num plano de 6 paga o dobro por mês, não a mensalidade de 6.
 *
 * Sem total informado, cai para `valorParcela × parcelas do plano`, que é de
 * onde o total sairia de qualquer forma.
 */
function valorDaParcela(d: DadosMatricula): number {
  const n = Math.max(Number(d.parcelas) || 1, 1);
  const total = Number(d.valorTotal ?? 0) > 0
    ? Number(d.valorTotal)
    : d.valorParcela * n;
  return Number((total / n).toFixed(2));
}

/**
 * Lança a taxa de matrícula como cobrança **própria**, e devolve a conta.
 *
 * Existe porque a escola vende turma que começa no ano seguinte: o aluno
 * paga a taxa agora, para garantir a vaga, e as mensalidades vencem
 * quando o curso começar. São duas cobranças com vencimentos diferentes,
 * logo dois planos — `InsertPlano` cria um de cada vez.
 *
 * **A categoria 6 dá o rótulo; o tipo 2 dá a aba.** Conferido contra
 * produção em 23/10/2026: com tipo 2 a cobrança aparece na aba "Taxa de
 * matrícula" do contrato, que é onde a escola a procura. Com tipo 0 — como
 * estava até hoje — ela disputaria o contrato com as mensalidades e uma das
 * duas seria recusada com erro 76.
 *
 * A forma é a mesma das mensalidades (−21, Link de Pagamento Sponte Pay)
 * porque é esta a cobrança que o aluno paga no checkout — e só essa forma
 * aparece na tela de Geração de Link.
 *
 * Devolve o `ContaReceberID` para o progresso guardar: sem ele, refazer o
 * checkout criaria uma segunda taxa, e o Sponte não exclui por API.
 */
async function criarPlanoTaxa(
  cred: CredenciaisSponte, d: DadosMatricula, contratoId: number | null,
  alunoId: number, opc: OpcoesChamada,
  cobranca: { valor: number; parcelas: number },
): Promise<number | null> {
  // A taxa vence já: é ela que garante a vaga.
  const venc = somarDiasUteis(new Date(), DIAS_UTEIS_ATE_COBRAR);

  const xml = await chamarSoap(
    "InsertPlano",
    [
      ...credenciais(cred),
      ["nContratoID", contratoId ? String(contratoId) : ""],
      ["nContratoAulaLivreID", ""],
      ["nAlunoID", String(alunoId)],
      ["nTipoPlano", String(TIPO_PLANO.TAXA_MATRICULA)],
      // Sem bolsa: o desconto incide sobre a mensalidade, e mesmo isso é
      // suposição não confirmada com a Sponte (ver `aplicarBolsa`).
      // Aplicá-lo à taxa seria dar desconto que ninguém autorizou.
      ["nBolsaID", ""],
      ["dDataPrimeiroVencimento", venc],
      ["nNumeroParcelas", cobranca.parcelas],
      ["nValorParcelas", cobranca.valor],
      ["nFormaCobrancaID", d.formaCobrancaId],
      ["nCategoriaID", CATEGORIA.TAXA_MATRICULA],
      ["sObservacao", "Taxa de matrícula — cadastro online"],
      ["nClienteID", ""],
      ["nContaID", CONTA_CREDITO_PADRAO],
    ],
    opc,
  );

  const id = xml.match(/<ContaReceberID>(\d+)<\/ContaReceberID>/)?.[1];
  return id && Number(id) > 0 ? Number(id) : null;
}

/**
 * O que é cobrado agora e o que fica para quando o curso começa.
 *
 * A estrutura do ERP decide o formato: duas cobranças no mesmo contrato só
 * coexistem em **tipos de plano diferentes** (erro 76). Então o que vence
 * agora vai para a aba **Taxa de matrícula** (tipo 2) e as mensalidades
 * ficam na aba **Mensalidades** (tipo 0), com a data de início do curso.
 *
 * Três casos, decididos em 23/10/2026 com o dono do produto:
 *
 * 1. **Cobrança sequencial, ou turma já iniciada** — nada agora; as N
 *    mensalidades correm a partir de hoje + 5, como sempre foi.
 * 2. **Turma futura, plano com taxa no Sponte** — a taxa é a cobrança de
 *    agora, com o valor que o plano define, e as N mensalidades esperam o
 *    curso.
 * 3. **Turma futura, plano sem taxa** — **um plano só**, com as N
 *    mensalidades: a primeira vence agora e as outras N-1 são movidas,
 *    depois de criadas, para o início do curso (`UpdateParcela`).
 *
 * O caso 3 já foi dois planos: a primeira parcela ia sozinha para a aba de
 * taxa de matrícula. Desfeito em 10/11/2026 porque o cartão recorrente do
 * Sponte Pay vale para a **conta a receber** do link — o aluno cadastrava o
 * cartão e só a "taxa" virava recorrência, as mensalidades ficavam de fora,
 * e o contrato enxergava só a aba de mensalidades. As matrículas que a
 * escola faz à mão são um plano só, e nelas tudo vira recorrência.
 */
export interface PlanoDeCobranca {
  /**
   * Taxa de matrícula **do plano do Sponte**, em plano próprio. `null` =
   * nenhuma — o caso de todos os planos da escola em 10/11/2026.
   */
  agora: { valor: number; parcelas: number } | null;
  /**
   * As mensalidades, num plano só. `parcelas` em zero significa que não há
   * plano a criar.
   *
   * `demaisAPartirDe` preenchido: a parcela 1 vence agora e as seguintes
   * são movidas para esta data em diante, mês a mês.
   */
  mensalidades: {
    parcelas: number;
    apartirDe: string | null;
    demaisAPartirDe?: string | null;
  };
  /** O que o aluno paga agora, quando é a primeira mensalidade adiantada. */
  primeiraAgora?: number | null;
}

export function planejarCobranca(d: {
  parcelas: number;
  /** Quanto vale cada mensalidade. */
  valorParcela: number;
  valorTaxa?: number | null;
  parcelasTaxa?: number | null;
  /** De quando correm as mensalidades. `null` = nada a adiar. */
  inicioDasDemais?: string | null;
}): PlanoDeCobranca {
  const total = Math.max(Number(d.parcelas) || 1, 1);
  const inicio = d.inicioDasDemais || null;
  const taxa = Number(d.valorTaxa ?? 0);
  const parcelasTaxa = Math.max(Number(d.parcelasTaxa ?? 1) || 1, 1);

  // 2. O plano tem taxa própria: ela é a cobrança de agora, e as
  //    mensalidades ficam inteiras para o curso. Vale mesmo sem adiar —
  //    taxa é cobrança de matrícula, não de mês.
  if (taxa > 0) {
    return {
      agora: { valor: taxa, parcelas: parcelasTaxa },
      mensalidades: { parcelas: total, apartirDe: inicio },
    };
  }

  // 1. Nada a adiar: um plano de mensalidades, como sempre.
  if (!inicio) {
    return { agora: null, mensalidades: { parcelas: total, apartirDe: null } };
  }

  // 3. Turma futura sem taxa: um plano só, a primeira vence agora e as
  //    demais são movidas para o início do curso. Com uma parcela só, não
  //    há o que mover.
  return {
    agora: null,
    mensalidades: {
      parcelas: total, apartirDe: null,
      demaisAPartirDe: total > 1 ? inicio : null,
    },
    primeiraAgora: d.valorParcela,
  };
}

/**
 * Os vencimentos das parcelas 2 a N quando a primeira é adiantada.
 *
 * A parcela 2 vence no início do curso e cada seguinte um mês depois, no
 * mesmo dia — ou no último dia do mês, quando ele não existe (31/01 → 28/02).
 * Sábado e domingo vão para a segunda, como o próprio `InsertPlano` faz.
 * Feriado não é considerado (ver `somarDiasUteis`).
 *
 * Devolve `[numeroParcela, "aaaa-mm-dd"]`, a partir da parcela 2.
 */
export function vencimentosDasDemais(
  inicio: string, parcelas: number,
): Array<[number, string]> {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(inicio);
  if (!m) return [];
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const p = (n: number) => String(n).padStart(2, "0");

  const saida: Array<[number, string]> = [];
  for (let k = 2; k <= Math.trunc(parcelas); k++) {
    const alvoMes = mes + (k - 2);
    const ultimo = new Date(Date.UTC(ano, alvoMes + 1, 0)).getUTCDate();
    const d = new Date(Date.UTC(ano, alvoMes, Math.min(dia, ultimo)));
    const semana = d.getUTCDay();
    if (semana === 6) d.setUTCDate(d.getUTCDate() + 2);
    if (semana === 0) d.setUTCDate(d.getUTCDate() + 1);
    saida.push([k, `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`]);
  }
  return saida;
}

/**
 * Lança um plano de mensalidades e devolve a conta a receber criada.
 *
 * Recebe **quantas** parcelas e **a partir de quando** porque uma turma
 * futura precisa de dois planos: um com a parcela adiantada, que reserva a
 * vaga, e outro com as demais a partir do início do curso. O `InsertPlano`
 * aceita uma data inicial só e espaça as parcelas mês a mês a partir dela,
 * então "uma agora e as outras em fevereiro" não cabe numa chamada.
 *
 * Turma já iniciada continua sendo uma chamada só, com todas as parcelas.
 */
async function criarPlano(
  cred: CredenciaisSponte, d: DadosMatricula, contratoId: number | null,
  alunoId: number, opc: OpcoesChamada,
  plano: { parcelas: number; apartirDe: string | null; demaisDoCurso?: boolean },
): Promise<number | null> {
  // A data vem de fora: quem sabe quando a turma começa é o checkout.
  // Antes era sempre "hoje + 5", e quem se matriculava em outubro numa
  // turma de fevereiro começava a pagar em outubro (SPEC-002 RN-03).
  const venc = plano.apartirDe
    ? new Date(`${plano.apartirDe}T00:00:00`)
    : somarDiasUteis(new Date(), DIAS_UTEIS_ATE_COBRAR);

  const xml = await chamarSoap(
    "InsertPlano",
    [
      ...credenciais(cred),
      ["nContratoID", contratoId ? String(contratoId) : ""],
      ["nContratoAulaLivreID", ""],
      // O sacado é obrigatório: sem ele o Sponte recusa com
      // "74 - Informe o sacado (AlunoID ou ClienteID)".
      ["nAlunoID", String(alunoId)],
      ["nTipoPlano", String(TIPO_PLANO.MENSALIDADE)],
      ["nBolsaID", d.bolsaId ? String(d.bolsaId) : ""],
      ["dDataPrimeiroVencimento", venc],
      // O parcelamento acontece **aqui**, não no cartão.
      //
      // O Sponte Pay não divide uma mensalidade no cartão; ele cobra o valor
      // que estiver na parcela. Então "pagar em 3 vezes" significa criar três
      // mensalidades no plano, e o aluno paga a primeira agora pelo link. As
      // outras vêm mês a mês.
      //
      // `parcelas` é a escolha do aluno (1 a N, onde N é o máximo do plano);
      // o valor de cada uma é o total dividido por ela.
      ["nNumeroParcelas", plano.parcelas],
      // O valor é sempre o da parcela do plano do curso, nos dois casos: o
      // que muda entre eles é quantas e quando, não quanto.
      ["nValorParcelas", valorDaParcela(d)],
      ["nFormaCobrancaID", d.formaCobrancaId],
      ["nCategoriaID", CATEGORIA.MENSALIDADE],
      ["sObservacao", plano.demaisDoCurso
        ? "Mensalidades do curso — cadastro online"
        : "Gerado pelo cadastro online"],
      ["nClienteID", ""],
      ["nContaID", CONTA_CREDITO_PADRAO],
    ],
    opc,
  );

  const id = xml.match(/<ContaReceberID>(\d+)<\/ContaReceberID>/)?.[1];
  return id && Number(id) > 0 ? Number(id) : null;
}

/**
 * Passo 5 — achar a parcela recém-criada.
 *
 * Filtra por `AlunoID=<id>`, que devolve só as parcelas daquele aluno.
 *
 * ⚠️ Não use `Situacao=1`: ele traz 6.458 registros e **nenhuma parcela
 * pendente recém-criada** — o que fez a busca falhar depois de o plano já ter
 * sido gravado, o pior momento possível. `AlunoID=` sozinho dá erro 21, mas
 * com valor funciona.
 */
/**
 * A cobrança que o aluno paga agora, dentre as parcelas em aberto.
 *
 * Separada de `localizarParcela` para poder ser testada sem rede: a regra
 * de desempate é o que decide se o link sai para a taxa ou para a
 * mensalidade, e isso não se confere chamando o Sponte.
 *
 * Recebe o XML cru de `GetParcelas`. Resposta vazia devolve `null` — e
 * isso **não** é erro: o `GetParcelas` mostrou-se instável em 21/10/2026,
 * devolvendo blocos vazios em chamadas sucessivas para o mesmo aluno.
 * Perder a matrícula já feita por causa disso seria pior que ficar sem o
 * link, que a régua do Sponte gera depois.
 */
export function escolherParcelaDoLink(
  xml: string,
): { contaReceberId: number; numeroParcela: string } | null {
  const blocos = xml.match(/<wsParcela>[\s\S]*?<\/wsParcela>/g) ?? [];
  // `\\s` e não `\s`: dentro do template a barra simples é consumida pela
  // string e a classe viraria `[sS]`, casando só essas duas letras.
  const campo = (b: string, n: string) =>
    (b.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`))?.[1] ?? "").trim();

  /** `dd/mm/aaaa` → `aaaammdd`, que ordena como texto. Sem data, vai ao fim. */
  const ordemData = (b: string) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(campo(b, "Vencimento"));
    return m ? `${m[3]}${m[2]}${m[1]}` : "99999999";
  };

  /** Taxa antes de mensalidade, no desempate. */
  const ehTaxa = (b: string) => (/taxa/i.test(campo(b, "Categoria")) ? 0 : 1);

  const emAberto = blocos
    .filter((b) => Number(campo(b, "ContaReceberID")) > 0 && !campo(b, "DataPagamento"))
    // Ordena por **vencimento**, não por número de parcela.
    //
    // Com taxa de matrícula existem dois planos, e cada um tem a sua
    // "parcela 1". Ordenando só pelo número, o desempate ficava por
    // conta da ordem em que o Sponte devolve o XML: o link sairia para a
    // taxa ou para a mensalidade sem critério — metade das vezes para a
    // errada (SPEC-002 RN-07).
    //
    // Quem vence primeiro é o que o aluno paga agora. Empate de data é
    // resolvido pela categoria: a taxa é o que garante a vaga.
    .sort((a, b) =>
      ordemData(a).localeCompare(ordemData(b))
      || ehTaxa(a) - ehTaxa(b)
      || Number(campo(a, "NumeroParcela")) - Number(campo(b, "NumeroParcela")));

  const primeira = emAberto[0];
  if (!primeira) return null;

  return {
    contaReceberId: Number(campo(primeira, "ContaReceberID")),
    numeroParcela: campo(primeira, "NumeroParcela") || "1",
  };
}

async function localizarParcela(
  cred: CredenciaisSponte, alunoId: number, opc: OpcoesChamada,
): Promise<{ contaReceberId: number; numeroParcela: string } | null> {
  const xml = await chamarSoap(
    "GetParcelas",
    [...credenciais(cred), ["sParametrosBusca", `AlunoID=${alunoId}`]],
    opc,
  );
  return escolherParcelaDoLink(xml);
}


/** Uma parcela que precisa mudar de vencimento. */
export interface AjusteVencimento {
  contaReceberId: number;
  numeroParcela: number;
  /** `aaaa-mm-dd` */
  vencimento: string;
  /** O valor como o Sponte o devolveu (`636,18`), para regravar igual. */
  valor: string;
}

/**
 * Quais parcelas do plano de mensalidades ainda estão fora da data.
 *
 * O plano é a conta de mensalidade mais nova do aluno: num aluno que já
 * existia, as contas antigas são de outras matrículas e não se tocam.
 *
 * Só devolve o que **difere** do esperado — é isso que deixa o passo ser
 * repetido numa retomada sem efeito: o que já foi movido não é regravado.
 * Parcela paga também fica de fora.
 */
export function ajustesDeVencimento(
  xml: string, esperado: Array<[number, string]>,
): AjusteVencimento[] {
  const blocos = xml.match(/<wsParcela>[\s\S]*?<\/wsParcela>/g) ?? [];
  const campo = (b: string, n: string) =>
    (b.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`))?.[1] ?? "").trim();

  const mensalidades = blocos.filter((b) =>
    Number(campo(b, "ContaReceberID")) > 0 &&
    Number(campo(b, "CategoriaID")) === CATEGORIA.MENSALIDADE);
  if (!mensalidades.length) return [];

  const conta = Math.max(...mensalidades.map((b) => Number(campo(b, "ContaReceberID"))));
  const doPlano = mensalidades.filter((b) => Number(campo(b, "ContaReceberID")) === conta);

  const ajustes: AjusteVencimento[] = [];
  for (const [numero, data] of esperado) {
    const b = doPlano.find((x) => Number(campo(x, "NumeroParcela")) === numero);
    if (!b || campo(b, "DataPagamento")) continue;
    const [d, m, a] = campo(b, "Vencimento").split("/");
    if (`${a}-${m}-${d}` === data) continue;
    ajustes.push({
      contaReceberId: conta, numeroParcela: numero, vencimento: data,
      valor: campo(b, "ValorParcela"),
    });
  }
  return ajustes;
}

/** A resposta do `GetParcelas` traz alguma mensalidade? */
export function temMensalidades(xml: string): boolean {
  return (xml.match(/<wsParcela>[\s\S]*?<\/wsParcela>/g) ?? []).some((b) =>
    Number(b.match(/<ContaReceberID>(\d+)</)?.[1] ?? 0) > 0 &&
    Number(b.match(/<CategoriaID>(\d+)</)?.[1] ?? 0) === CATEGORIA.MENSALIDADE);
}

/**
 * O valor como o `UpdateParcela` lê: vírgula decimal, **sem** ponto de milhar.
 *
 * O `GetParcelas` devolve "1.272,36", e mandar isso de volta grava R$ 1,00 —
 * o Sponte corta no ponto. Aconteceu na primeira matrícula real com o plano
 * único (ficha 575, 11/11/2026); nos testes todo valor era menor que mil.
 */
export function valorParaSponte(valor: string): string {
  return valor.replace(/\./g, "").trim();
}

/** "1.272,36" → 1272.36, para comparar valores sem depender da formatação. */
export function valorEmReais(valor: string): number {
  return Number(valor.replace(/\./g, "").replace(",", ".").trim());
}

/**
 * Move as parcelas 2 a N para o início do curso, e confere.
 *
 * Regrava valor, forma e categoria **iguais** aos que o Sponte devolveu —
 * o `UpdateParcela` pede todos, e mandar vazio poderia zerar algum. Depois
 * relê: se alguma parcela não ficou com a data ou mudou de valor, para com
 * erro em vez de seguir gerando link de um plano torto.
 */
export async function ajustarVencimentos(
  cred: CredenciaisSponte, alunoId: number,
  d: { formaCobrancaId: number; bolsaId?: number | null },
  esperado: Array<[number, string]>, opc: OpcoesChamada,
): Promise<void> {
  if (!esperado.length) return;

  // O `GetParcelas` já devolveu blocos vazios para um aluno que tinha
  // parcelas (21/10/2026). Aqui isso seria grave: sem as mensalidades na
  // resposta, "nada a mover" e "não li nada" se confundem, e o aluno ficaria
  // com as parcelas correndo a partir de hoje. Então insiste, e não lendo,
  // para com erro.
  const ler = async () => {
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      const xml = await chamarSoap(
        "GetParcelas",
        [...credenciais(cred), ["sParametrosBusca", `AlunoID=${alunoId}`]],
        opc,
      );
      if (temMensalidades(xml)) return xml;
    }
    throw new SponteError(
      "resposta_invalida", "GetParcelas",
      "o Sponte não devolveu as mensalidades do plano para mover os vencimentos — " +
      "tente de novo em instantes",
    );
  };

  const ajustes = ajustesDeVencimento(await ler(), esperado);
  for (const a of ajustes) {
    await chamarSoap(
      "UpdateParcela",
      [
        ...credenciais(cred),
        ["nContaReceberID", a.contaReceberId],
        ["nNumeroParcela", a.numeroParcela],
        // A mesma bolsa do `InsertPlano`: vazia poderia tirar o desconto.
        ["nBolsaID", d.bolsaId ? String(d.bolsaId) : ""],
        ["dDataVencimento", new Date(`${a.vencimento}T00:00:00`)],
        ["nValor", valorParaSponte(a.valor)],
        ["nFormaCobrancaID", String(d.formaCobrancaId)],
        ["nCategoriaID", String(CATEGORIA.MENSALIDADE)],
        ["sObservacao", "Mensalidades do curso — cadastro online"],
      ],
      opc,
    );
  }
  if (!ajustes.length) return;

  const depois = await ler();
  const faltam = ajustesDeVencimento(depois, esperado);
  if (faltam.length) {
    throw new SponteError(
      "resposta_invalida", "UpdateParcela",
      `o Sponte aceitou mover os vencimentos, mas ${faltam.length} parcela(s) ` +
      `continuam fora da data (parcela ${faltam[0].numeroParcela}) — confira o plano no Sponte.`,
    );
  }
  const valor = (xml: string, n: number) => {
    const b = (xml.match(/<wsParcela>[\s\S]*?<\/wsParcela>/g) ?? []).find((x) =>
      x.includes(`<ContaReceberID>${ajustes[0].contaReceberId}<`) &&
      x.includes(`<NumeroParcela>${n}<`));
    return b?.match(/<ValorParcela>([^<]*)</)?.[1]?.trim() ?? "";
  };
  const sumiu = ajustes.find((a) => !valor(depois, a.numeroParcela));
  if (sumiu) {
    throw new SponteError(
      "resposta_invalida", "UpdateParcela",
      `a parcela ${sumiu.numeroParcela} não voltou na conferência depois de mover ` +
      `o vencimento — confira o plano no Sponte.`,
    );
  }
  const mudou = ajustes.find((a) =>
    valorEmReais(valor(depois, a.numeroParcela)) !== valorEmReais(a.valor));
  if (mudou) {
    throw new SponteError(
      "resposta_invalida", "UpdateParcela",
      `a parcela ${mudou.numeroParcela} mudou de valor ao mover o vencimento ` +
      `(${mudou.valor} → ${valor(depois, mudou.numeroParcela)}) — confira no Sponte.`,
    );
  }
}

async function gerarLink(
  cred: CredenciaisSponte, contaReceberId: number, numeroParcela: string, opc: OpcoesChamada,
): Promise<string | null> {
  const xml = await chamarSoap(
    "GetLinkPagamentoSpontePay",
    [...credenciais(cred), ["nContaReceberID", contaReceberId], ["nNumeroParcela", numeroParcela]],
    opc,
  );
  return extrairUrlPagamento(xml);
}

/* ------------------------------------------------------------------ *
 * Orquestração
 * ------------------------------------------------------------------ */

/**
 * Executa (ou retoma) a sequência até o link de pagamento.
 *
 * **Idempotente por construção:** cada passo é pulado se o campo correspondente
 * do progresso já estiver preenchido. Chamar duas vezes seguidas não cria dois
 * alunos — e isso não é refinamento, é requisito: sem `Delete*` na API, uma
 * duplicata só sai pela interface do Sponte, na mão.
 */
export async function executarMatricula(
  cred: CredenciaisSponte,
  dados: DadosMatricula,
  progresso: ProgressoMatricula = progressoVazio(),
  opcoes: OpcoesMatricula = {},
): Promise<ProgressoMatricula> {
  const { simular = true, marcarComoTeste = false, ...opc } = opcoes;
  const p: ProgressoMatricula = { ...progresso, erro: null, erroPasso: null };

  const passo = async <T>(nome: PassoMatricula, jaFeito: boolean, fn: () => Promise<T>) => {
    if (jaFeito) return null;
    const r = await fn();
    p.ultimoPasso = nome;
    return r;
  };

  try {
    // 1. CPF já existe? (leitura — roda mesmo em simulação)
    if (p.sponteAlunoId === null) {
      const achados = await verificarCpf(cred, dados.cpf, opc);

      if (achados.length > 1) {
        // Dois cadastros com o mesmo CPF: escolher um no chute pode pendurar
        // a cobrança na pessoa errada. Isto para o fluxo de propósito.
        throw new SponteError(
          "retorno_operacao", "GetAlunos4",
          `há ${achados.length} alunos com o CPF ${soDigitos(dados.cpf)} no Sponte ` +
          `(ids ${achados.join(", ")}) — alguém precisa dizer qual é o certo`,
          "", 0,
        );
      }
      if (achados.length === 1) { p.sponteAlunoId = achados[0]; p.alunoJaExistia = true; }
      p.ultimoPasso = "verificar_cpf";
    }

    // 2. Criar o aluno — ou atualizar o que já existe
    if (p.sponteAlunoId === null) {
      p.sponteAlunoId = simular
        ? -Math.floor(Math.random() * 90000 + 10000)   // id negativo: nunca confunde com real
        : await criarAluno(cred, dados, opc, marcarComoTeste);
    } else if (p.alunoJaExistia && !simular && !p.dadosAtualizados) {
      // O cadastro traz dados mais novos que os do ERP; sem isto o aluno fica
      // com o que estava lá desde sempre.
      await atualizarAlunoExistente(cred, dados, p.sponteAlunoId, opc, marcarComoTeste);
      p.dadosAtualizados = true;
    }
    // Marca o passo mesmo quando o aluno já existia: sem isso, uma falha na
    // matrícula seria atribuída à criação do aluno, que nem chegou a rodar.
    p.ultimoPasso = "criar_aluno";

    // 3. Responsável financeiro (o sacado da cobrança)
    //
    // Só para quem informou outra pessoa como responsável. Sem isso, o
    // sacado é o próprio aluno e nada é criado — ver `precisaDeResponsavel`.
    if (p.responsavelId === null && precisaDeResponsavel(dados)) {
      p.responsavelId = simular
        ? -Math.floor(Math.random() * 90000 + 10000)
        // Procura antes de criar, pelo mesmo motivo do passo 1: quando o aluno
        // já existe ele costuma já ter responsável, e um segundo cadastro com
        // o mesmo CPF é recusado com "29 - O CPF informado já está associado a
        // outro cadastro". Sem operação de exclusão, o engano não se desfaz.
        // Três degraus, do mais específico ao mais caro:
        //
        //   1. este aluno já tem responsável?       (retomada)
        //   2. esta pessoa já existe no ERP?        (irmão, ex-aluno…)
        //   3. criar.
        //
        // O segundo degrau faltava, e é o caso comum numa escola: o pai
        // que já é responsável de outro filho tem CPF cadastrado, e o
        // Sponte recusa com "29 - O CPF informado já está associado a
        // outro cadastro". A primeira matrícula de menor em produção
        // parou exatamente aí.
        //
        // Reusar o id é seguro: o `responsavelId` não é repassado ao
        // contrato nem ao plano — ele existe para o menor ter responsável
        // financeiro no ERP. Associar a pessoa ao novo aluno exigiria
        // `UpdateResponsaveis2`, que também move o `nAlunoID` e poderia
        // desfazer o vínculo do irmão. Isso fica para quem conhecer a
        // regra da escola decidir, na tela do Sponte.
        : await (async () => {
          const doAluno = await buscarResponsavelFinanceiro(cred, p.sponteAlunoId!, opc);
          if (doAluno) return doAluno;

          const porCpf = await buscarResponsavelPorCpf(
            cred, dados.responsavelCpf?.trim() || dados.cpf || "", opc);
          if (porCpf) {
            // Reusado: a matrícula segue, mas o vínculo com este aluno não
            // existe no ERP e não dá para criá-lo por API. Marcado para a
            // escola poder fechar isso na tela do Sponte.
            p.responsavelReusado = true;
            return porCpf;
          }

          return await criarResponsavel(
            cred, dados, p.sponteAlunoId!, opc, marcarComoTeste);
        })();
      p.ultimoPasso = "criar_responsavel";
    } else if (!precisaDeResponsavel(dados)) {
      // Nada a criar, mas o passo está concluído: uma falha adiante não pode
      // ser atribuída a ele.
      p.ultimoPasso = "criar_responsavel";
    }

    // 4. Matrícula em pré-matrícula
    if (p.contratoId === null) {
      if (simular) {
        p.contratoId = -Math.floor(Math.random() * 90000 + 10000);
      } else {
        // Procura antes de criar: o Sponte recusa a segunda matrícula do mesmo
        // aluno na mesma turma com "11 - O aluno já está cadastrado na turma",
        // e numa retomada esse contrato é justamente o que queremos reaproveitar.
        const existente = await buscarMatriculaVigente(
          cred, p.sponteAlunoId!, dados.sponteTurmaId, opc);

        if (existente) {
          p.contratoId = existente.contratoId;
          // O plano financeiro pertence ao contrato: se o Sponte já o lançou,
          // repetir o passo 5 só renderia "76 - Já existe um plano".
          if (existente.financeiroLancado) p.planoCriado = true;
        } else {
          p.contratoId = await criarMatricula(cred, dados, p.sponteAlunoId!, opc);
        }
      }
      p.ultimoPasso = "criar_matricula";
    }

    /* --- 5. O financeiro --- *
     *
     * Duas cobranças no mesmo contrato só coexistem em tipos de plano
     * diferentes: o Sponte recusa a segunda do mesmo tipo com "76 - Já
     * existe um plano financeiro cadastrado neste contrato para o tipo de
     * plano informado".
     *
     * Então o que vence agora vai para a aba **Taxa de matrícula** (tipo 2)
     * e as mensalidades para a aba **Mensalidades** (tipo 0), cada uma com
     * a sua data. `planejarCobranca` decide o que cai em cada lado.
     */
    const plano = planejarCobranca({
      parcelas: dados.parcelas,
      valorParcela: valorDaParcela(dados),
      valorTaxa: dados.valorTaxa,
      parcelasTaxa: dados.parcelasTaxa,
      inicioDasDemais: dados.inicioDasDemais,
    });
    if (plano.primeiraAgora != null) p.valorCobradoAgora = plano.primeiraAgora;

    // 5a. O que o aluno paga agora — e que vai receber o link
    //
    // `contaTaxaId` em `null` distingue "ainda não criei" de "não há o que
    // cobrar agora": sem cobrança imediata, o passo nem é tentado.
    if (plano.agora && p.contaTaxaId === null) {
      p.valorCobradoAgora = plano.agora.valor;
      if (!simular) {
        try {
          p.contaTaxaId = await criarPlanoTaxa(
            cred, dados, p.contratoId, p.sponteAlunoId!, opc, plano.agora);
        } catch (erro) {
          // 76 numa retomada é o resultado desejado: já foi lançada antes.
          if (!(erro instanceof SponteError && erro.codigo === 76)) throw erro;
        }
      }
      p.ultimoPasso = "criar_taxa";
    }

    // 5b. As mensalidades
    //
    // `parcelas` em zero acontece quando o plano tem uma parcela só e ela
    // já foi cobrada agora: não há plano de mensalidades a criar, e pedir
    // um de zero parcelas seria recusado.
    if (plano.mensalidades.parcelas > 0 && !p.planoCriado) {
      if (!simular) {
        try {
          await criarPlano(cred, dados, p.contratoId, p.sponteAlunoId!, opc, {
            parcelas: plano.mensalidades.parcelas,
            apartirDe: plano.mensalidades.apartirDe
              ?? dados.primeiroVencimento ?? null,
            demaisDoCurso: !!plano.mensalidades.apartirDe,
          });
        } catch (erro) {
          // Aqui o 76 **não** é benigno quando há cobrança agora: significa
          // que as duas disputaram o mesmo tipo de plano, e o aluno fica com
          // uma e sem a outra. Engolir esse código custou uma rodada inteira
          // de teste em 23/10/2026 — a ficha saiu "enviado", sem erro, com
          // uma mensalidade de quatro, e nada na auditoria.
          if (erro instanceof SponteError && erro.codigo === 76 && plano.agora) {
            throw new SponteError(
              "retorno_operacao",
              "InsertPlano",
              "o Sponte recusou o plano de mensalidades neste contrato (76) "
              + "— a cobrança de agora foi criada, as mensalidades não.",
              undefined,
              76,
            );
          }
          // Sem cobrança agora, 76 é a retomada de sempre: já existe.
          if (!(erro instanceof SponteError && erro.codigo === 76)) throw erro;
        }
      }
      p.planoCriado = true;
      p.planoDemaisCriado = true;
      p.ultimoPasso = plano.mensalidades.apartirDe
        ? "criar_plano_demais"
        : "criar_plano";
    }

    // 5c. A primeira agora, as demais com o curso
    //
    // O `InsertPlano` espaça as parcelas mês a mês a partir de uma data só.
    // Para a primeira vencer agora e as outras no início do curso, o plano
    // nasce seguido e as parcelas 2 a N são movidas depois.
    const demaisAPartirDe = plano.mensalidades.demaisAPartirDe;
    if (demaisAPartirDe && !p.vencimentosAjustados) {
      if (!simular) {
        await ajustarVencimentos(cred, p.sponteAlunoId!, dados,
          vencimentosDasDemais(demaisAPartirDe, plano.mensalidades.parcelas), opc);
      }
      p.vencimentosAjustados = true;
      p.ultimoPasso = "ajustar_vencimentos";
    }

    // 6. Localizar a parcela
    if (p.contaReceberId === null) {
      if (simular) {
        p.contaReceberId = -Math.floor(Math.random() * 90000 + 10000);
        p.numeroParcela = "1";
      } else {
        const achada = await localizarParcela(cred, p.sponteAlunoId!, opc);
        if (!achada) {
          throw new SponteError(
            "resposta_invalida", "GetParcelas",
            "O plano foi criado mas nenhuma parcela em aberto foi localizada para o aluno.",
          );
        }
        p.contaReceberId = achada.contaReceberId;
        p.numeroParcela = achada.numeroParcela;
      }
      p.ultimoPasso = "localizar_parcela";
    }

    // 7. Link de pagamento
    //
    // Só existe se a fatura já tiver sido gerada — pela régua de cobrança ou à
    // mão, na tela do Sponte. O código 313 ("parcela não vinculada") significa
    // "a fatura ainda não existe", e é o caso NORMAL logo após a matrícula:
    // não é falha, é espera. Ver `cobranca.ts` para o porquê.
    if (p.linkPagamento === null) {
      if (simular) {
        p.linkPagamento = `https://exemplo-sponte-pay.invalido/checkout/simulado-${Math.abs(p.contaReceberId!)}`;
      } else {
        try {
          p.linkPagamento = await gerarLink(cred, p.contaReceberId!, p.numeroParcela ?? "1", opc);
        } catch (erro) {
          if (erro instanceof SponteError && erro.codigo === 313) {
            p.aguardandoFatura = true;
          } else {
            throw erro;
          }
        }
      }
      p.ultimoPasso = "gerar_link";
    }

    return p;
  } catch (erro) {
    p.erro = erro instanceof Error ? erro.message : String(erro);
    // O passo que falhou é o seguinte ao último concluído.
    const i = p.ultimoPasso ? PASSOS.indexOf(p.ultimoPasso) : -1;
    p.erroPasso = PASSOS[i + 1] ?? null;
    return p;
  }
}

/**
 * Promove a matrícula para Cursando depois do pagamento confirmado.
 *
 * ⚠️ Só deve ser chamada com confirmação real. Promover sem pagamento coloca na
 * turma quem não pagou — e reverter exige intervenção manual no ERP.
 */
export async function promoverMatricula(
  cred: CredenciaisSponte,
  contratoId: number,
  opcoes: OpcoesMatricula = {},
): Promise<void> {
  const { simular = true, ...opc } = opcoes;
  if (simular) return;

  await chamarSoap(
    "UpdateMatriculaV2",
    [
      ...credenciais(cred),
      ["nContratoID", String(contratoId)],
      ["nContratoAulaLivreID", ""],
      ["nSituacao", String(SITUACAO_TURMA.CURSANDO)],
      ["nCursoID", ""], ["nTipoContratoID", ""],
      ["dDataInicio", ""], ["nContratante", ""], ["dDataTermino", ""],
      ["dDataMatricula", ""], ["nModulo", ""],
      ["sDisciplinasMatricular", ""], ["sDisciplinasRemover", ""],
      ["sObservacao", "Matrícula ativada — pagamento confirmado"],
    ],
    opc,
  );
}

/**
 * O pagamento entrou?
 *
 * Enquanto a Sponte não confirmar se o Sponte Pay tem webhook, esta é a única
 * forma de saber — e por isso o aluno espera entre pagar e ser matriculado.
 */
export async function pagamentoConfirmado(
  cred: CredenciaisSponte,
  contaReceberId: number,
  numeroParcela: string,
  alunoId: number,
  opcoes: OpcoesChamada = {},
): Promise<{ pago: boolean; dataPagamento: string | null; valorPago: string | null }> {
  const xml = await chamarSoap(
    "GetParcelas",
    [...credenciais(cred), ["sParametrosBusca", `AlunoID=${alunoId}`]],
    opcoes,
  );

  const campo = (b: string, n: string) =>
    (b.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`))?.[1] ?? "").trim();

  const bloco = (xml.match(/<wsParcela>[\s\S]*?<\/wsParcela>/g) ?? []).find((b) =>
    Number(campo(b, "ContaReceberID")) === contaReceberId &&
    campo(b, "NumeroParcela") === String(numeroParcela));

  if (!bloco) return { pago: false, dataPagamento: null, valorPago: null };

  const dataPagamento = campo(bloco, "DataPagamento");
  return {
    pago: dataPagamento !== "",
    dataPagamento: dataPagamento || null,
    valorPago: campo(bloco, "ValorPago") || null,
  };
}

/** Rótulo de cada passo, para a tela de acompanhamento. */
export const ROTULO_PASSO: Record<PassoMatricula, string> = {
  verificar_cpf: "Conferindo o CPF no sistema da escola",
  criar_aluno: "Criando o cadastro do aluno",
  criar_responsavel: "Definindo o responsável financeiro",
  criar_matricula: "Registrando a pré-matrícula na turma",
  criar_taxa: "Lançando a taxa de matrícula",
  criar_plano: "Gerando o plano de pagamento",
  criar_plano_demais: "Agendando as mensalidades do curso",
  ajustar_vencimentos: "Agendando as mensalidades do curso",
  localizar_parcela: "Localizando a cobrança",
  gerar_link: "Preparando o pagamento",
};
