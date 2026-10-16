/**
 * Testes da camada SOAP. Rodam sem rede, sem Docker e sem token:
 *
 *     node --test supabase/functions/_shared/
 *
 * Node 24 executa TypeScript direto (type stripping), então não há build nem
 * `npm install` no caminho. O mesmo arquivo vale como documentação executável
 * do formato que esperamos do Sponte — quando uma resposta real divergir de um
 * destes casos, o teste é o lugar de registrar a diferença.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  chamarSoap,
  checarRetornoOperacao,
  credenciais,
  credenciaisDoAmbiente,
  desescaparXml,
  escaparXml,
  extrairResultado,
  extrairSoapFault,
  lerRetornoOperacao,
  formatarDateTime,
  montarEnvelope,
  SponteError,
  type Parametros,
} from "./soap.ts";

/* ------------------------------------------------------------------ *
 * Escape
 * ------------------------------------------------------------------ */

test("escaparXml protege os cinco caracteres especiais", () => {
  assert.equal(
    escaparXml(`Silva & Souza <"teste"> 'x'`),
    "Silva &amp; Souza &lt;&quot;teste&quot;&gt; &apos;x&apos;",
  );
});

test("escapar e desescapar é uma viagem de ida e volta", () => {
  const original = `Maria & João <irmãos> "da Silva" 'Jr'`;
  assert.equal(desescaparXml(escaparXml(original)), original);
});

test("desescaparXml trata &amp; por último, preservando entidade literal", () => {
  // "&amp;lt;" representa o texto literal "&lt;" — e não o caractere "<".
  // Se &amp; fosse resolvido primeiro, o resultado viraria "<".
  assert.equal(desescaparXml("&amp;lt;"), "&lt;");
});

test("desescaparXml resolve referência numérica", () => {
  assert.equal(desescaparXml("caf&#233;"), "café");
});

/* ------------------------------------------------------------------ *
 * Datas
 * ------------------------------------------------------------------ */

test("formatarDateTime devolve xsd:dateTime local, sem sufixo de fuso", () => {
  const d = new Date(2026, 8, 24, 14, 5, 9); // 24/09/2026 14:05:09 local
  assert.equal(formatarDateTime(d), "2026-09-24T14:05:09");
});

test("formatarDateTime preserva o dia de uma data à meia-noite", () => {
  // O motivo de não usar toISOString(): em fuso negativo, a meia-noite local
  // vira o dia anterior em UTC — e a data de nascimento do aluno anda um dia.
  const d = new Date(2001, 0, 1, 0, 0, 0);
  assert.equal(formatarDateTime(d), "2001-01-01T00:00:00");
});

test("formatarDateTime recusa data inválida", () => {
  assert.throws(() => formatarDateTime(new Date("nada")), TypeError);
});

/* ------------------------------------------------------------------ *
 * Envelope
 * ------------------------------------------------------------------ */

test("montarEnvelope preserva a ordem declarada dos parâmetros", () => {
  const xml = montarEnvelope("GetTurmas", [
    ["nCodigoCliente", 12345],
    ["sToken", "abc"],
    ["sParametrosBusca", ""],
  ]);

  const posCodigo = xml.indexOf("<nCodigoCliente>");
  const posToken = xml.indexOf("<sToken>");
  const posBusca = xml.indexOf("<sParametrosBusca");

  assert.ok(posCodigo < posToken, "nCodigoCliente deve vir antes de sToken");
  assert.ok(posToken < posBusca, "sToken deve vir antes de sParametrosBusca");
});

test("montarEnvelope usa elemento vazio para valor ausente", () => {
  const xml = montarEnvelope("InsertAlunos3", [
    ["sNome", "Maria"],
    ["sRG", null],
    ["sCPF", undefined],
    ["sEmail", ""],
  ]);

  assert.match(xml, /<sNome>Maria<\/sNome>/);
  assert.match(xml, /<sRG \/>/);
  assert.match(xml, /<sCPF \/>/);
  assert.match(xml, /<sEmail \/>/);
});

test("montarEnvelope escapa o conteúdo dos valores", () => {
  const xml = montarEnvelope("InsertAlunos3", [["sNome", "Silva & Souza"]]);
  assert.match(xml, /<sNome>Silva &amp; Souza<\/sNome>/);
  assert.doesNotMatch(xml, /Silva & Souza/);
});

test("montarEnvelope declara o namespace do Sponte na operação", () => {
  const xml = montarEnvelope("GetTurmas", []);
  assert.match(xml, /<GetTurmas xmlns="http:\/\/api\.sponteeducacional\.net\.br\/">/);
});

test("montarEnvelope converte Date e number", () => {
  const xml = montarEnvelope("InsertMatricula", [
    ["nAlunoID", 42],
    ["dDataMatricula", new Date(2026, 8, 24, 0, 0, 0)],
  ]);
  assert.match(xml, /<nAlunoID>42<\/nAlunoID>/);
  assert.match(xml, /<dDataMatricula>2026-09-24T00:00:00<\/dDataMatricula>/);
});

test("montarEnvelope recusa nome de operação malformado", () => {
  assert.throws(() => montarEnvelope("Get Turmas", []), TypeError);
  assert.throws(() => montarEnvelope("<script>", []), TypeError);
});

test("montarEnvelope recusa nome de parâmetro malformado", () => {
  assert.throws(() => montarEnvelope("GetTurmas", [["a b", "x"]]), TypeError);
});

/* ------------------------------------------------------------------ *
 * Extração da resposta
 * ------------------------------------------------------------------ */

function envelopeResposta(operacao: string, conteudoEscapado: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${operacao}Response xmlns="http://api.sponteeducacional.net.br/">
      <${operacao}Result>${conteudoEscapado}</${operacao}Result>
    </${operacao}Response>
  </soap:Body>
</soap:Envelope>`;
}

test("extrairResultado desescapa o XML interno", () => {
  const interno = "<Turmas><Turma><TurmaID>7</TurmaID></Turma></Turmas>";
  const xml = envelopeResposta("GetTurmas", escaparXml(interno));
  assert.equal(extrairResultado(xml, "GetTurmas"), interno);
});

test("extrairResultado aceita prefixo de namespace no elemento Result", () => {
  const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><ns:GetTurmasResponse xmlns:ns="http://api.sponteeducacional.net.br/">
    <ns:GetTurmasResult>&lt;Turmas /&gt;</ns:GetTurmasResult>
  </ns:GetTurmasResponse></soap:Body></soap:Envelope>`;
  assert.equal(extrairResultado(xml, "GetTurmas"), "<Turmas />");
});

test("extrairResultado trata Result auto-fechado como vazio", () => {
  const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><GetTurmasResponse><GetTurmasResult /></GetTurmasResponse></soap:Body></soap:Envelope>`;
  assert.equal(extrairResultado(xml, "GetTurmas"), "");
});

test("extrairResultado desembrulha CDATA", () => {
  const xml = envelopeResposta("GetTurmas", "<![CDATA[<Turmas><T/></Turmas>]]>");
  assert.equal(extrairResultado(xml, "GetTurmas"), "<Turmas><T/></Turmas>");
});

test("extrairResultado lança quando o elemento Result não existe", () => {
  const xml = `<soap:Envelope><soap:Body><Outra /></soap:Body></soap:Envelope>`;
  assert.throws(
    () => extrairResultado(xml, "GetTurmas"),
    (e: unknown) => e instanceof SponteError && e.tipo === "resposta_invalida",
  );
});

/* ------------------------------------------------------------------ *
 * SOAP Fault
 * ------------------------------------------------------------------ */

test("extrairSoapFault lê faultstring do SOAP 1.1", () => {
  const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><soap:Fault>
    <faultcode>soap:Server</faultcode>
    <faultstring>Token inv&#225;lido</faultstring>
  </soap:Fault></soap:Body></soap:Envelope>`;
  assert.equal(extrairSoapFault(xml), "Token inválido");
});

test("extrairSoapFault lê Reason/Text do SOAP 1.2", () => {
  const xml = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body><soap:Fault>
    <soap:Reason><soap:Text xml:lang="pt">Falhou</soap:Text></soap:Reason>
  </soap:Fault></soap:Body></soap:Envelope>`;
  assert.equal(extrairSoapFault(xml), "Falhou");
});

test("extrairSoapFault devolve null quando não há falha", () => {
  assert.equal(extrairSoapFault(envelopeResposta("GetTurmas", "&lt;x /&gt;")), null);
});

test("extrairResultado transforma Fault em SponteError, mesmo com HTTP 200", () => {
  const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><soap:Fault><faultstring>Erro</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
  assert.throws(
    () => extrairResultado(xml, "GetTurmas"),
    (e: unknown) => e instanceof SponteError && e.tipo === "soap_fault",
  );
});

/* ------------------------------------------------------------------ *
 * RetornoOperacao — a regra de ouro
 * ------------------------------------------------------------------ */

// Os três valores abaixo foram capturados do Sponte de produção em 24/09/2026
// por scripts/explorar-sponte.ts. São o formato real, não suposição.
const SUCESSO = "01 - Operação Realizada com Sucesso.";
const SEM_PARAMETRO = "21 - Informe pelo menos um parâmetro de busca.";
const SEM_REGISTROS = "43 - Nenhum registro foi encontrado para os parâmetros de busca informados.";

const envolver = (retorno: string) =>
  `<wsTurma><RetornoOperacao>${retorno}</RetornoOperacao></wsTurma>`;

test("lerRetornoOperacao separa código e mensagem", () => {
  assert.deepEqual(lerRetornoOperacao(envolver(SUCESSO)), {
    codigo: 1,
    mensagem: "Operação Realizada com Sucesso.",
    bruto: SUCESSO,
  });
});

test("lerRetornoOperacao devolve null sem o campo", () => {
  assert.equal(lerRetornoOperacao("<wsTurma><Nome>x</Nome></wsTurma>"), null);
});

test("lerRetornoOperacao usa código -1 para formato inesperado", () => {
  // Formato que não conhecemos vira falha, em vez de passar despercebido.
  assert.equal(lerRetornoOperacao(envolver("Token inválido"))?.codigo, -1);
});

test("checarRetornoOperacao aceita o código 01 de sucesso", () => {
  assert.doesNotThrow(() => checarRetornoOperacao(envolver(SUCESSO), "GetTurmas"));
});

test("checarRetornoOperacao NÃO lança no código 43 — busca vazia não é falha", () => {
  // O caso que sustenta a deduplicação por CPF: 43 significa "esse aluno ainda
  // não existe", que é justamente o resultado que autoriza o cadastro.
  assert.doesNotThrow(() => checarRetornoOperacao(envolver(SEM_REGISTROS), "GetAlunos4"));
});

test("checarRetornoOperacao lança no código 21", () => {
  assert.throws(
    () => checarRetornoOperacao(envolver(SEM_PARAMETRO), "GetTurmas"),
    (e: unknown) =>
      e instanceof SponteError && e.tipo === "retorno_operacao" && e.codigo === 21,
  );
});

test("checarRetornoOperacao lança em código desconhecido", () => {
  assert.throws(
    () => checarRetornoOperacao(envolver("99 - Alguma coisa nova"), "GetTurmas"),
    (e: unknown) => e instanceof SponteError && e.codigo === 99,
  );
});

test("checarRetornoOperacao ignora resposta sem o campo", () => {
  assert.doesNotThrow(() => checarRetornoOperacao("<R><Turma /></R>", "GetTurmas"));
});

/* ------------------------------------------------------------------ *
 * Transporte
 * ------------------------------------------------------------------ */

/** `fetch` de mentira: devolve o que for pedido e registra a chamada. */
function fetchFalso(
  corpo: string,
  status = 200,
): { fetchImpl: typeof fetch; chamadas: Array<{ url: string; init: RequestInit }> } {
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    chamadas.push({ url, init });
    return new Response(corpo, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, chamadas };
}

test("chamarSoap manda SOAPAction e Content-Type corretos", async () => {
  const { fetchImpl, chamadas } = fetchFalso(envelopeResposta("GetTurmas", "&lt;Turmas /&gt;"));

  await chamarSoap("GetTurmas", [["nCodigoCliente", 1]], { fetchImpl });

  const headers = chamadas[0].init.headers as Record<string, string>;
  assert.equal(headers["SOAPAction"], "http://api.sponteeducacional.net.br/GetTurmas");
  assert.equal(headers["Content-Type"], "text/xml; charset=utf-8");
  assert.equal(chamadas[0].init.method, "POST");
});

test("chamarSoap devolve o XML interno desescapado", async () => {
  const interno = "<Turmas><Turma><TurmaID>7</TurmaID></Turma></Turmas>";
  const { fetchImpl } = fetchFalso(envelopeResposta("GetTurmas", escaparXml(interno)));

  assert.equal(await chamarSoap("GetTurmas", [], { fetchImpl }), interno);
});

test("chamarSoap lança em HTTP 500 sem Fault legível", async () => {
  const { fetchImpl } = fetchFalso("Internal Server Error", 500);
  await assert.rejects(
    () => chamarSoap("GetTurmas", [], { fetchImpl }),
    (e: unknown) => e instanceof SponteError && e.tipo === "http",
  );
});

test("chamarSoap prefere a mensagem do Fault ao status HTTP", async () => {
  const corpo = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
    <soap:Body><soap:Fault><faultstring>Token expirado</faultstring></soap:Fault></soap:Body>
  </soap:Envelope>`;
  const { fetchImpl } = fetchFalso(corpo, 500);

  await assert.rejects(
    () => chamarSoap("GetTurmas", [], { fetchImpl }),
    (e: unknown) =>
      e instanceof SponteError && e.tipo === "soap_fault" && e.message.includes("Token expirado"),
  );
});

test("chamarSoap trata HTTP 200 com recusa de negócio como erro", async () => {
  // O caso que mais importa: sem esta checagem, uma recusa vira sucesso.
  const interno = "<R><RetornoOperacao>21 - Informe pelo menos um parâmetro de busca.</RetornoOperacao></R>";
  const { fetchImpl } = fetchFalso(envelopeResposta("GetAlunos4", escaparXml(interno)));

  await assert.rejects(
    () => chamarSoap("GetAlunos4", [], { fetchImpl }),
    (e: unknown) => e instanceof SponteError && e.tipo === "retorno_operacao",
  );
});

test("chamarSoap respeita o timeout", async () => {
  const fetchLento = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const erro = new Error("abortado");
        erro.name = "AbortError";
        reject(erro);
      });
    })) as unknown as typeof fetch;

  await assert.rejects(
    () => chamarSoap("GetTurmas", [], { fetchImpl: fetchLento, timeoutMs: 30 }),
    (e: unknown) => e instanceof SponteError && e.tipo === "timeout",
  );
});

/* ------------------------------------------------------------------ *
 * Credenciais
 * ------------------------------------------------------------------ */

test("credenciais produz o par na ordem exigida pelo WSDL", () => {
  const p: Parametros = credenciais({ codigoCliente: 999, token: "t" });
  assert.deepEqual(p, [["nCodigoCliente", 999], ["sToken", "t"]]);
});

test("credenciaisDoAmbiente exige SPONTE_KEY", () => {
  const env = { get: (k: string) => (k === "SPONTE_CODIGO_CLIENTE" ? "1" : undefined) };
  assert.throws(() => credenciaisDoAmbiente(env), /SPONTE_KEY/);
});

test("credenciaisDoAmbiente exige SPONTE_CODIGO_CLIENTE", () => {
  const env = { get: (k: string) => (k === "SPONTE_KEY" ? "abc" : undefined) };
  assert.throws(() => credenciaisDoAmbiente(env), /SPONTE_CODIGO_CLIENTE/);
});

test("credenciaisDoAmbiente recusa código de cliente não numérico", () => {
  const env = {
    get: (k: string) => (k === "SPONTE_KEY" ? "abc" : "não-é-número"),
  };
  assert.throws(() => credenciaisDoAmbiente(env), /inteiro positivo/);
});

test("credenciaisDoAmbiente devolve o par convertido", () => {
  const env = {
    get: (k: string) => (k === "SPONTE_KEY" ? "tok" : "12345"),
  };
  assert.deepEqual(credenciaisDoAmbiente(env), { codigoCliente: 12345, token: "tok" });
});
