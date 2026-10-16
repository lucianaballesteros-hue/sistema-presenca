/**
 * Camada SOAP do WSAPIEdu — o web service transacional do Sponte.
 *
 * Este arquivo cuida só do *transporte*: montar o envelope, mandar o POST,
 * abrir a resposta e transformar falha em exceção. Ele não sabe nada sobre
 * aluno, turma ou matrícula — isso fica nos módulos de cada operação.
 *
 * Duas particularidades do WSAPIEdu moldam todo o código abaixo, e valem ser
 * lidas antes de mexer aqui (detalhes em `docs/API-SPONTE.md`):
 *
 * 1. **HTTP 200 não significa sucesso.** Token inválido, ID inexistente ou
 *    validação de negócio recusada voltam como 200. Quem decide é o campo
 *    `RetornoOperacao` dentro do corpo — ver `checarRetornoOperacao()`.
 *
 * 2. **A resposta é XML dentro de XML.** O conteúdo útil vem como uma string
 *    *escapada* dentro de `<{Operacao}Result>`. Extrair e desescapar é um passo
 *    obrigatório antes de qualquer parse — ver `extrairResultado()`.
 *
 * Sem dependências externas de propósito: roda igual no Deno (Edge Function) e
 * no Node (testes locais), sem `npm install` e sem Docker.
 */

export const SPONTE_ENDPOINT = "https://api.sponteeducacional.net.br/WSAPIEdu.asmx";
export const SPONTE_NAMESPACE = "http://api.sponteeducacional.net.br/";

/** Valor aceito num parâmetro SOAP. `null`/`undefined` viram elemento vazio. */
export type ValorParametro = string | number | Date | null | undefined;

/**
 * Parâmetros da operação, como lista ordenada de pares.
 *
 * É uma lista — e não um objeto — porque o XSD do WSAPIEdu declara os
 * parâmetros como `<sequence>`: **a ordem dos elementos faz parte do
 * contrato**. Mandar `sToken` antes de `nCodigoCliente` é recusado. Um objeto
 * JS até preserva a ordem de inserção, mas deixa isso implícito e fácil de
 * quebrar numa refatoração; a lista torna a exigência visível.
 */
export type Parametros = Array<[string, ValorParametro]>;

/** Falha vinda do Sponte, em qualquer das camadas onde ela pode aparecer. */
export class SponteError extends Error {
  readonly operacao: string;
  readonly tipo: "http" | "soap_fault" | "retorno_operacao" | "resposta_invalida" | "timeout";
  readonly detalhe?: string;
  /** Código numérico de `RetornoOperacao`, quando a falha veio de lá. */
  readonly codigo?: number;

  constructor(
    tipo: SponteError["tipo"],
    operacao: string,
    mensagem: string,
    detalhe?: string,
    codigo?: number,
  ) {
    super(mensagem);
    this.name = "SponteError";
    this.tipo = tipo;
    this.operacao = operacao;
    this.detalhe = detalhe;
    this.codigo = codigo;
  }
}

/* ------------------------------------------------------------------ *
 * Escape de XML
 * ------------------------------------------------------------------ */

/**
 * Escapa um valor para poder entrar como texto num elemento XML.
 *
 * Não é opcional nem paranoia: nomes de aluno com `&` ("Silva & Souza") e
 * observações com aspas passam por aqui. Sem escape, o envelope vira XML
 * inválido e o Sponte devolve um erro que não diz o que aconteceu.
 */
export function escaparXml(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Desfaz o escape de XML. Usado no conteúdo de `<{Operacao}Result>`, que chega
 * escapado.
 *
 * A ordem importa: `&amp;` tem de ser o **último** a ser substituído, senão
 * um `&amp;lt;` legítimo (o texto literal "&lt;") vira `<` por engano.
 */
export function desescaparXml(texto: string): string {
  return texto
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

/* ------------------------------------------------------------------ *
 * Conversão de valores
 * ------------------------------------------------------------------ */

/**
 * Formata uma data no formato `xsd:dateTime` sem fuso (`2026-09-24T00:00:00`).
 *
 * Sem sufixo `Z` e sem offset de propósito: o servidor é brasileiro e
 * interpreta a data como local. Mandar `Z` num aluno nascido à meia-noite
 * empurra a data de nascimento para o dia anterior.
 *
 * Usa os componentes locais da `Date` (`getFullYear` e irmãos), não os UTC,
 * pelo mesmo motivo.
 */
export function formatarDateTime(data: Date): string {
  if (Number.isNaN(data.getTime())) {
    throw new TypeError("Data inválida passada para formatarDateTime()");
  }
  const p = (n: number, casas = 2) => String(n).padStart(casas, "0");
  return (
    `${p(data.getFullYear(), 4)}-${p(data.getMonth() + 1)}-${p(data.getDate())}` +
    `T${p(data.getHours())}:${p(data.getMinutes())}:${p(data.getSeconds())}`
  );
}

/** Converte um valor de parâmetro para o texto que vai dentro do elemento. */
function valorParaTexto(valor: ValorParametro): string {
  if (valor === null || valor === undefined) return "";
  if (valor instanceof Date) return formatarDateTime(valor);
  if (typeof valor === "number") {
    if (!Number.isFinite(valor)) {
      throw new TypeError(`Número inválido em parâmetro SOAP: ${valor}`);
    }
    return String(valor);
  }
  return valor;
}

/* ------------------------------------------------------------------ *
 * Montagem do envelope
 * ------------------------------------------------------------------ */

/**
 * Monta o envelope SOAP 1.1 de uma operação.
 *
 * Parâmetro sem valor vira elemento vazio (`<sRG />`) em vez de ser omitido:
 * o `<sequence>` do XSD espera todos os elementos declarados, na ordem, e
 * omitir um do meio pode fazer o servidor casar os seguintes com as posições
 * erradas.
 */
export function montarEnvelope(operacao: string, parametros: Parametros): string {
  validarNomeOperacao(operacao);

  const corpo = parametros
    .map(([nome, valor]) => {
      validarNomeParametro(nome, operacao);
      const texto = valorParaTexto(valor);
      return texto === ""
        ? `      <${nome} />`
        : `      <${nome}>${escaparXml(texto)}</${nome}>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${operacao} xmlns="${SPONTE_NAMESPACE}">
${corpo}
    </${operacao}>
  </soap:Body>
</soap:Envelope>`;
}

/**
 * Nome de operação e de parâmetro entram no XML como *nome de elemento*, onde
 * escape não existe — um nome malformado quebraria o envelope de um jeito
 * difícil de diagnosticar. Como ambos são sempre constantes do nosso código
 * (nunca entrada de usuário), a validação é uma rede contra erro de digitação,
 * não contra ataque.
 */
function validarNomeOperacao(operacao: string): void {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(operacao)) {
    throw new TypeError(`Nome de operação SOAP inválido: ${JSON.stringify(operacao)}`);
  }
}

function validarNomeParametro(nome: string, operacao: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(nome)) {
    throw new TypeError(
      `Nome de parâmetro inválido em ${operacao}: ${JSON.stringify(nome)}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Leitura da resposta
 * ------------------------------------------------------------------ */

/**
 * Procura um `<soap:Fault>` na resposta e devolve a mensagem, ou `null`.
 *
 * Fault é a falha de *protocolo* (envelope malformado, operação inexistente),
 * distinta da falha de *negócio*, que vem em `RetornoOperacao`. As duas podem
 * chegar com HTTP 200.
 */
export function extrairSoapFault(xml: string): string | null {
  if (!/<(?:\w+:)?Fault[\s>]/.test(xml)) return null;

  const faultstring = xml.match(/<(?:\w+:)?faultstring(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?faultstring>/i);
  if (faultstring) return desescaparXml(faultstring[1].trim());

  // SOAP 1.2 usa <Reason><Text>…</Text></Reason> no lugar de <faultstring>.
  const reason = xml.match(/<(?:\w+:)?Text(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?Text>/i);
  if (reason) return desescaparXml(reason[1].trim());

  return "SOAP Fault sem mensagem legível";
}

/**
 * Extrai o conteúdo de `<{Operacao}Result>` e desfaz o escape, devolvendo o
 * XML interno pronto para parse.
 *
 * Trata as três formas em que o elemento pode chegar: com prefixo de namespace
 * (`<ns:GetTurmasResult>`), vazio e auto-fechado (`<GetTurmasResult />`), e com
 * o conteúdo dentro de CDATA em vez de escapado.
 */
export function extrairResultado(xml: string, operacao: string): string {
  validarNomeOperacao(operacao);

  const fault = extrairSoapFault(xml);
  if (fault) {
    throw new SponteError("soap_fault", operacao, `SOAP Fault em ${operacao}: ${fault}`, xml);
  }

  const alvo = `${operacao}Result`;
  const vazio = new RegExp(`<(?:\\w+:)?${alvo}(?:\\s[^>]*)?/>`);
  if (vazio.test(xml)) return "";

  const comConteudo = new RegExp(
    `<(?:\\w+:)?${alvo}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${alvo}>`,
  );
  const achado = xml.match(comConteudo);
  if (!achado) {
    throw new SponteError(
      "resposta_invalida",
      operacao,
      `Resposta do Sponte não contém <${alvo}>.`,
      xml.slice(0, 2000),
    );
  }

  const bruto = achado[1].trim();

  const cdata = bruto.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) return cdata[1].trim();

  return desescaparXml(bruto);
}

/**
 * Códigos de `RetornoOperacao`, observados em produção em 24/09/2026.
 *
 * O campo vem no formato `"NN - Mensagem"` — por exemplo
 * `"01 - Operação Realizada com Sucesso."`. O número é o que importa; a
 * mensagem é texto livre em português e não deve ser comparada.
 *
 * A lista da Sponte não é pública; estes três foram levantados empiricamente
 * (`scripts/explorar-sponte.ts`). Ao encontrar um código novo, acrescente aqui
 * e registre em `docs/API-SPONTE.md`.
 */
export const RETORNO_SUCESSO = 1;
/** Filtro ausente, vazio ou com chave que a operação não reconhece. */
export const RETORNO_SEM_PARAMETRO = 21;
/** Filtro válido, porém sem resultados. Ver nota abaixo: **não é erro**. */
export const RETORNO_SEM_REGISTROS = 43;

export interface RetornoOperacao {
  codigo: number;
  mensagem: string;
  bruto: string;
}

/** Lê o primeiro `RetornoOperacao` do XML interno, ou `null` se não houver. */
export function lerRetornoOperacao(xmlInterno: string): RetornoOperacao | null {
  const achado = xmlInterno.match(
    /<RetornoOperacao(?:\s[^>]*)?>([\s\S]*?)<\/RetornoOperacao>/i,
  );
  if (!achado) return null;

  const bruto = desescaparXml(achado[1].trim());
  const partes = bruto.match(/^(\d+)\s*-\s*([\s\S]*)$/);

  // Formato inesperado: devolve código -1 para que a checagem trate como falha,
  // em vez de deixar passar algo que não sabemos ler.
  if (!partes) return { codigo: -1, mensagem: bruto, bruto };

  return { codigo: Number(partes[1]), mensagem: partes[2].trim(), bruto };
}

/**
 * Lança se o `RetornoOperacao` indicar falha.
 *
 * Dois códigos passam sem erro:
 *
 * - **01** — sucesso, o caso normal.
 * - **43** — "nenhum registro encontrado". É um **resultado vazio, não uma
 *   falha**, e tratá-lo como exceção quebraria a lógica mais importante da
 *   integração: a verificação de CPF duplicado antes de criar um aluno
 *   (`docs/API-SPONTE.md` §9.3). Ali, 43 é exatamente a resposta desejada —
 *   significa "esse aluno ainda não existe, pode cadastrar". Quem precisa
 *   distinguir busca vazia de busca cheia usa `lerRetornoOperacao()`.
 *
 * Qualquer outro código vira `SponteError`. O critério é conservador de
 * propósito: um código desconhecido é tratado como falha, porque o custo de
 * deixar uma matrícula recusada passar por bem-sucedida é muito maior que o de
 * um falso alarme.
 */
export function checarRetornoOperacao(xmlInterno: string, operacao: string): void {
  const retorno = lerRetornoOperacao(xmlInterno);

  // Ausência não é erro: nem toda operação devolve o campo, e a validação real
  // de cada uma é feita por quem a consome.
  if (!retorno) return;

  if (retorno.codigo === RETORNO_SUCESSO || retorno.codigo === RETORNO_SEM_REGISTROS) {
    return;
  }

  throw new SponteError(
    "retorno_operacao",
    operacao,
    `Sponte recusou ${operacao}: ${retorno.bruto}`,
    xmlInterno.slice(0, 2000),
    retorno.codigo,
  );
}

/* ------------------------------------------------------------------ *
 * Transporte
 * ------------------------------------------------------------------ */

export interface OpcoesChamada {
  /** Sobrescreve o endpoint — usado em teste e, se existir, em pré-produção. */
  endpoint?: string;
  /** Tempo máximo da requisição. Padrão: 30s. */
  timeoutMs?: number;
  /** `fetch` alternativo. Permite testar sem rede. */
  fetchImpl?: typeof fetch;
  /** Pula `checarRetornoOperacao()`. Só para diagnóstico. */
  ignorarRetornoOperacao?: boolean;
}

/**
 * Executa uma operação do WSAPIEdu e devolve o XML interno já desescapado.
 *
 * O timeout é obrigatório na prática: SOAP com XML aninhado é lento, e uma
 * Edge Function que espera indefinidamente consome o tempo de execução até
 * ser morta pelo runtime, sem deixar rastro útil.
 */
export async function chamarSoap(
  operacao: string,
  parametros: Parametros,
  opcoes: OpcoesChamada = {},
): Promise<string> {
  const {
    endpoint = SPONTE_ENDPOINT,
    timeoutMs = 30_000,
    fetchImpl = fetch,
    ignorarRetornoOperacao = false,
  } = opcoes;

  const envelope = montarEnvelope(operacao, parametros);
  const controle = new AbortController();
  const alarme = setTimeout(() => controle.abort(), timeoutMs);

  let resposta: Response;
  try {
    resposta = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": `${SPONTE_NAMESPACE}${operacao}`,
      },
      body: envelope,
      signal: controle.signal,
    });
  } catch (erro) {
    if (erro instanceof Error && erro.name === "AbortError") {
      throw new SponteError(
        "timeout",
        operacao,
        `Sponte não respondeu ${operacao} em ${timeoutMs}ms.`,
      );
    }
    throw new SponteError(
      "http",
      operacao,
      `Falha de rede ao chamar ${operacao}.`,
      erro instanceof Error ? erro.message : String(erro),
    );
  } finally {
    clearTimeout(alarme);
  }

  const texto = await resposta.text();

  // Um 500 do .asmx costuma trazer um SOAP Fault legível no corpo — vale mais
  // que o status sozinho, então a mensagem dele tem prioridade.
  if (!resposta.ok) {
    const fault = extrairSoapFault(texto);
    throw new SponteError(
      fault ? "soap_fault" : "http",
      operacao,
      fault
        ? `SOAP Fault em ${operacao}: ${fault}`
        : `Sponte respondeu HTTP ${resposta.status} em ${operacao}.`,
      texto.slice(0, 2000),
    );
  }

  const interno = extrairResultado(texto, operacao);
  if (!ignorarRetornoOperacao) checarRetornoOperacao(interno, operacao);
  return interno;
}

/**
 * Prefixo de credencial presente em **toda** operação do WSAPIEdu.
 *
 * Existe para que nenhum módulo de operação repita (e eventualmente inverta) a
 * ordem `nCodigoCliente` → `sToken`. Use sempre espalhando no início:
 *
 * ```ts
 * const params: Parametros = [
 *   ...credenciais(cfg),
 *   ["sParametrosBusca", filtro],
 * ];
 * ```
 */
export interface CredenciaisSponte {
  codigoCliente: number;
  token: string;
}

export function credenciais(cfg: CredenciaisSponte): Parametros {
  return [
    ["nCodigoCliente", cfg.codigoCliente],
    ["sToken", cfg.token],
  ];
}

/**
 * Lê as credenciais do ambiente da Edge Function.
 *
 * Falha alto e cedo se faltar alguma: um `nCodigoCliente` vazio não causa erro
 * de rede — o Sponte responde 200 com uma recusa genérica, e o diagnóstico
 * fica caro.
 */
export function credenciaisDoAmbiente(
  env: { get(chave: string): string | undefined },
): CredenciaisSponte {
  const token = env.get("SPONTE_KEY");
  const codigo = env.get("SPONTE_CODIGO_CLIENTE");

  if (!token) {
    throw new Error(
      "Secret SPONTE_KEY não configurado nas Edge Function Secrets do projeto.",
    );
  }
  if (!codigo) {
    throw new Error(
      "Secret SPONTE_CODIGO_CLIENTE não configurado. O WSAPIEdu exige " +
        "nCodigoCliente além do token em toda chamada.",
    );
  }

  const codigoCliente = Number(codigo);
  if (!Number.isInteger(codigoCliente) || codigoCliente <= 0) {
    throw new Error(
      `SPONTE_CODIGO_CLIENTE deve ser um inteiro positivo (recebido: ${JSON.stringify(codigo)}).`,
    );
  }

  return { codigoCliente, token };
}
