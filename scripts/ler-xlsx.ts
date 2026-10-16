/**
 * Leitor de .xlsx sem dependência externa.
 *
 * Um .xlsx é um zip de arquivos XML. Em vez de instalar uma biblioteca (ou
 * depender do binário `unzip`, que não existe em toda máquina nem no runtime
 * das Edge Functions), isto abre o zip com o `zlib` do próprio Node e lê o
 * XML com expressões regulares.
 *
 * O recorte é proposital — só o que a planilha de controle usa:
 * nomes de abas, textos compartilhados e o valor de cada célula como string.
 * Não interpreta fórmula (lê o último valor calculado, que é o que o Excel
 * guarda), nem formato de número, nem data.
 */

import { inflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";

/* ------------------------------------------------------------------ *
 * Zip
 * ------------------------------------------------------------------ */

/**
 * Abre o zip e devolve cada arquivo pelo nome.
 *
 * Lê o diretório central (no fim do arquivo) em vez de varrer do começo:
 * é onde o zip declara oficialmente o que contém, e evita tropeçar em
 * cabeçalhos locais com tamanho adiado.
 */
export function abrirZip(caminho: string): Map<string, Buffer> {
  const buf = readFileSync(caminho);

  // O fim do diretório central é um marcador seguido de até 64 KB de
  // comentário, então a busca é de trás para a frente.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65_558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${caminho} não parece um arquivo .xlsx`);

  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const arquivos = new Map<string, Buffer>();
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;

    const metodo = buf.readUInt16LE(p + 10);
    const tamComprimido = buf.readUInt32LE(p + 20);
    const nomeLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const comentLen = buf.readUInt16LE(p + 32);
    const offsetLocal = buf.readUInt32LE(p + 42);
    const nome = buf.toString("utf8", p + 46, p + 46 + nomeLen);

    // O cabeçalho local tem tamanhos próprios para nome e extra, que podem
    // diferir dos do diretório central — daí reler aqui.
    const nomeLocal = buf.readUInt16LE(offsetLocal + 26);
    const extraLocal = buf.readUInt16LE(offsetLocal + 28);
    const inicio = offsetLocal + 30 + nomeLocal + extraLocal;
    const dados = buf.subarray(inicio, inicio + tamComprimido);

    arquivos.set(nome, metodo === 0 ? dados : inflateRawSync(dados));
    p += 46 + nomeLen + extraLen + comentLen;
  }
  return arquivos;
}

/* ------------------------------------------------------------------ *
 * Planilha
 * ------------------------------------------------------------------ */

const destag = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
   .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
   .replace(/&amp;/g, "&");

export class Planilha {
  #zip: Map<string, Buffer>;
  #sst: string[];
  #abas: Record<string, string>;

  constructor(caminho: string) {
    this.#zip = abrirZip(caminho);
    this.#sst = this.#lerStrings();
    this.#abas = this.#lerAbas();
  }

  get abas(): string[] {
    return Object.keys(this.#abas);
  }

  #texto(nome: string): string {
    const b = this.#zip.get(nome);
    if (!b) throw new Error(`o .xlsx não tem ${nome}`);
    return b.toString("utf8");
  }

  /** Textos repetidos ficam numa tabela só; a célula guarda o índice. */
  #lerStrings(): string[] {
    if (!this.#zip.has("xl/sharedStrings.xml")) return [];
    const xml = this.#texto("xl/sharedStrings.xml");
    return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
      // Um <si> pode vir partido em vários <t> quando tem formatação no meio.
      destag([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  }

  #lerAbas(): Record<string, string> {
    const wb = this.#texto("xl/workbook.xml");
    const rels = this.#texto("xl/_rels/workbook.xml.rels");

    const porId: Record<string, string> = {};
    for (const m of rels.matchAll(/<Relationship([^>]*?)\/?>/g)) {
      const id = m[1].match(/Id="([^"]+)"/)?.[1];
      const alvo = m[1].match(/Target="([^"]+)"/)?.[1];
      if (id && alvo) porId[id] = alvo.startsWith("/") ? alvo.slice(1) : `xl/${alvo}`;
    }

    const saida: Record<string, string> = {};
    for (const m of wb.matchAll(/<sheet([^>]*?)\/?>/g)) {
      const nome = m[1].match(/name="([^"]+)"/)?.[1];
      const rid = m[1].match(/r:id="([^"]+)"/)?.[1];
      if (nome && rid && porId[rid]) saida[destag(nome)] = porId[rid];
    }
    return saida;
  }

  /** "BC" → 54. Coluna do Excel para índice de vetor. */
  static indiceColuna(ref: string): number {
    const letras = ref.match(/^[A-Z]+/)?.[0] ?? "A";
    let n = 0;
    for (const c of letras) n = n * 26 + (c.charCodeAt(0) - 64);
    return n - 1;
  }

  /**
   * As linhas de uma aba, cada uma como vetor de strings.
   *
   * Células vazias viram `""` e linhas puladas viram vetor vazio, para quem
   * percorre poder indexar sem checar `undefined` a cada acesso.
   */
  linhas(aba: string): string[][] {
    const caminho = this.#abas[aba];
    if (!caminho) throw new Error(`a planilha não tem a aba "${aba}" (tem: ${this.abas.join(", ")})`);

    const xml = this.#texto(caminho);
    const saida: string[][] = [];

    for (const mr of xml.matchAll(/<row[^>]*?r="(\d+)"[^>]*?>([\s\S]*?)<\/row>/g)) {
      const linha: string[] = [];

      for (const mc of mr[2].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = mc[1].match(/r="([A-Z]+\d+)"/)?.[1];
        if (!ref) continue;

        const tipo = mc[1].match(/t="([^"]+)"/)?.[1];
        const corpo = mc[2] ?? "";
        const v = corpo.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const inline = corpo.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/)?.[1];

        let valor = "";
        if (tipo === "s" && v !== undefined) valor = this.#sst[Number(v)] ?? "";
        else if (tipo === "inlineStr" && inline !== undefined) valor = destag(inline);
        else if (v !== undefined) valor = destag(v);

        linha[Planilha.indiceColuna(ref)] = valor;
      }

      for (let i = 0; i < linha.length; i++) if (linha[i] === undefined) linha[i] = "";
      saida[Number(mr[1]) - 1] = linha;
    }

    for (let i = 0; i < saida.length; i++) if (!saida[i]) saida[i] = [];
    return saida;
  }

  /**
   * Linhas de uma aba como objetos, usando a linha indicada como cabeçalho.
   *
   * A planilha de controle tem o cabeçalho na linha 2, não na 1 — daí o
   * parâmetro em vez de assumir a primeira.
   */
  registros(aba: string, linhaCabecalho = 1): Record<string, string>[] {
    const linhas = this.linhas(aba);
    const cabecalho = (linhas[linhaCabecalho - 1] ?? []).map((h) => h.trim());

    return linhas.slice(linhaCabecalho).map((linha) => {
      const o: Record<string, string> = {};
      cabecalho.forEach((nome, i) => { if (nome) o[nome] = (linha[i] ?? "").trim(); });
      return o;
    });
  }
}
