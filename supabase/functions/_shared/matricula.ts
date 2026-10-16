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
export const TIPO_PLANO_MENSALIDADE = 0;

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
  | "criar_plano"
  | "localizar_parcela"
  | "gerar_link";

export const PASSOS: PassoMatricula[] = [
  "verificar_cpf", "criar_aluno", "criar_responsavel", "criar_matricula",
  "criar_plano", "localizar_parcela", "gerar_link",
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
    responsavelId: null, contratoId: null,
    planoCriado: false, contaReceberId: null, numeroParcela: null,
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
  return partes.join(" | ");
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
    ["sEmail", ou(d.email, "Email")],
    ["sTelefone", soDigitos(ou(d.telefone, "Telefone"))],
    ["sCelular", soDigitos(ou(d.celular, "Celular"))],
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
      ["sEmail", d.email ?? ""],
      ["sTelefone", d.telefone ? soDigitos(d.telefone) : ""],
      ["sCPF", soDigitos(d.cpf)],
      ["sRG", d.rg ?? ""],
      ["sCelular", d.celular ? soDigitos(d.celular) : ""],
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
      ["sEmail", (temResponsavel ? d.responsavelEmail : d.email) ?? ""],
      ["sTelefone", ""],
      ["sCelular", soDigitos((temResponsavel ? d.responsavelCelular : d.celular) ?? "")],
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

async function criarPlano(
  cred: CredenciaisSponte, d: DadosMatricula, contratoId: number | null,
  alunoId: number, opc: OpcoesChamada,
): Promise<void> {
  const venc = new Date();
  venc.setDate(venc.getDate() + 5);   // 5 dias para pagar a primeira

  await chamarSoap(
    "InsertPlano",
    [
      ...credenciais(cred),
      ["nContratoID", contratoId ? String(contratoId) : ""],
      ["nContratoAulaLivreID", ""],
      // O sacado é obrigatório: sem ele o Sponte recusa com
      // "74 - Informe o sacado (AlunoID ou ClienteID)".
      ["nAlunoID", String(alunoId)],
      ["nTipoPlano", String(TIPO_PLANO_MENSALIDADE)],
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
      ["nNumeroParcelas", d.parcelas],
      ["nValorParcelas", valorDaParcela(d)],
      ["nFormaCobrancaID", d.formaCobrancaId],
      ["nCategoriaID", CATEGORIA.MENSALIDADE],
      ["sObservacao", "Gerado pelo cadastro online"],
      ["nClienteID", ""],
      ["nContaID", CONTA_CREDITO_PADRAO],
    ],
    opc,
  );
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
async function localizarParcela(
  cred: CredenciaisSponte, alunoId: number, opc: OpcoesChamada,
): Promise<{ contaReceberId: number; numeroParcela: string } | null> {
  const xml = await chamarSoap(
    "GetParcelas",
    [...credenciais(cred), ["sParametrosBusca", `AlunoID=${alunoId}`]],
    opc,
  );

  const blocos = xml.match(/<wsParcela>[\s\S]*?<\/wsParcela>/g) ?? [];
  const campo = (b: string, n: string) =>
    (b.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`))?.[1] ?? "").trim();

  // Em aberto e na ordem: a cobrança do checkout é a primeira parcela.
  const doAluno = blocos
    .filter((b) => Number(campo(b, "ContaReceberID")) > 0 && !campo(b, "DataPagamento"))
    .sort((a, b) => Number(campo(a, "NumeroParcela")) - Number(campo(b, "NumeroParcela")));

  const primeira = doAluno[0];
  if (!primeira) return null;

  return {
    contaReceberId: Number(campo(primeira, "ContaReceberID")),
    numeroParcela: campo(primeira, "NumeroParcela") || "1",
  };
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
    if (p.responsavelId === null) {
      p.responsavelId = simular
        ? -Math.floor(Math.random() * 90000 + 10000)
        // Procura antes de criar, pelo mesmo motivo do passo 1: quando o aluno
        // já existe ele costuma já ter responsável, e um segundo cadastro com
        // o mesmo CPF é recusado com "29 - O CPF informado já está associado a
        // outro cadastro". Sem operação de exclusão, o engano não se desfaz.
        : await buscarResponsavelFinanceiro(cred, p.sponteAlunoId!, opc)
          ?? await criarResponsavel(cred, dados, p.sponteAlunoId!, opc, marcarComoTeste);
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

    // 5. Plano financeiro
    if (!p.planoCriado) {
      if (!simular) {
        try {
          await criarPlano(cred, dados, p.contratoId, p.sponteAlunoId!, opc);
        } catch (erro) {
          // Código 76 = o plano já existe neste contrato. Numa retomada isso é
          // exatamente o resultado desejado, não uma falha.
          if (!(erro instanceof SponteError && erro.codigo === 76)) throw erro;
        }
      }
      p.planoCriado = true;
      p.ultimoPasso = "criar_plano";
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
  criar_plano: "Gerando o plano de pagamento",
  localizar_parcela: "Localizando a cobrança",
  gerar_link: "Preparando o pagamento",
};
