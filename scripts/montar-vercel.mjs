/**
 * Monta a saída de build da Vercel, em vez de deixá-la adivinhar.
 *
 *     node scripts/montar-vercel.mjs
 *
 * ## Por que isto existe
 *
 * O projeto importa com a extensão explícita (`from "./app.ts"`), que é o
 * que o Node 22+ exige para executar TypeScript direto, sem build. A
 * Vercel, no modo automático, **compila** cada `.ts` para `.js` e **não**
 * reescreve os especificadores — então a função publicada procurava
 * `scripts/app.ts`, que lá já não existia:
 *
 *     Cannot find module '/var/task/scripts/app.ts'
 *       imported from /var/task/api/[...rota].js
 *
 * São 31 especificadores no grafo. Trocar todos para `.js` consertaria a
 * Vercel e quebraria a execução local, que é como os 224 testes rodam.
 *
 * A saída é empacotar: o esbuild resolve os `.ts` e produz **um arquivo
 * sem import externo nenhum**. Aí não há especificador para reescrever.
 *
 * ## Por que a Build Output API
 *
 * Gerar um `.js` dentro de `api/` não bastaria: no modo automático a
 * Vercel decide o que são funções a partir do repositório, antes de rodar
 * o build, e um arquivo criado depois pode não entrar. A Build Output API
 * é o contrato explícito — o que estiver em `.vercel/output` é o que vai
 * ao ar, incluindo as rotas. Sem convenção para interpretar errado, que
 * foi o que fez os caminhos aninhados darem 404.
 *
 * Documentação: https://vercel.com/docs/build-output-api/v3
 *
 * ## O `vercel.json` tem uma chave só, e isso é de propósito
 *
 * Lá fica apenas `buildCommand`, apontando para este arquivo. Duas razões:
 *
 * 1. **Ele é obrigatório.** O log do deploy mostrava `no build` logo após
 *    o install: sem a chave declarada, a plataforma não roda etapa de
 *    build nenhuma — nem com o script `build` no `package.json`. Aí este
 *    arquivo nunca executa, `.vercel/output` nunca existe, e a Vercel
 *    volta ao modo automático, que é o que quebra os imports.
 *
 * 2. **Nada mais cabe lá.** Com a Build Output API, as chaves `routes`,
 *    `headers`, `rewrites` e `functions` do `vercel.json` são ignoradas —
 *    quem manda é o `config.json` escrito aqui embaixo.
 *
 * ⚠️ E **não escreva comentários no `vercel.json`**. A Vercel valida o
 * arquivo contra um schema estrito e recusa propriedade desconhecida:
 * chaves como `"//"` ou `"//rewrites"`, que em outros projetos servem de
 * comentário, fazem o **build inteiro falhar**. Três deploys desta série
 * morreram por isso, e o erro não diz qual chave é. A explicação mora
 * aqui, num arquivo que aceita comentário de verdade.
 */

import { build } from "esbuild";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";

const RAIZ = resolve(import.meta.dirname, "..");
const SAIDA = join(RAIZ, ".vercel", "output");
const FUNCAO = join(SAIDA, "functions", "api", "index.func");

/**
 * O que **não** é publicado como estático.
 *
 * Lista de exclusão, e não de inclusão, de propósito. A primeira versão
 * listava o que copiar — e esquecia `backend/`. Como `auth.js` importa
 * `backend/api/supabaseClient.js`, o grafo de módulos inteiro morria no
 * navegador: `window.doLogin` nunca era criado e o botão "Entrar" não
 * fazia nada. Sem erro na tela, sem erro no build.
 *
 * Antes da Build Output API a Vercel copiava o repositório inteiro, e
 * isso funcionava por acidente. Voltar a esse comportamento — publicar
 * tudo menos o que é claramente de servidor — faz o esquecimento mudar de
 * lado: arquivo novo do site passa a funcionar sozinho, e o erro possível
 * vira "publiquei demais", que é visível, em vez de "faltou um módulo",
 * que é silencioso.
 */
const NAO_PUBLICAR = new Set([
  // Servidor e ferramentas: nada disso é baixado pelo navegador.
  "api", "scripts", "supabase", "sql", "docs", "node_modules",
  // Ambiente e controle.
  ".git", ".github", ".claude", ".vercel", ".vscode",
  // Metadados do projeto.
  "package.json", "package-lock.json", "tsconfig.json", "vercel.json",
  ".gitignore", ".env", ".env.example", "README.md", "ARQUITETURA.md",
]);

async function montar() {
  await rm(SAIDA, { recursive: true, force: true });
  await mkdir(FUNCAO, { recursive: true });

  /* --- 1. A função, num arquivo só --- */
  const r = await build({
    entryPoints: [join(RAIZ, "api", "[...rota].ts")],
    outfile: join(FUNCAO, "index.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // `pg` só é usado pelo script de migração, que não vai para produção.
    // Sem isto o esbuild tenta empacotá-lo e puxa dependências nativas.
    external: ["pg"],
    logLevel: "warning",
    metafile: true,
  });

  const tamanho = Object.values(r.metafile.outputs)[0]?.bytes ?? 0;
  console.log(`  função: ${(tamanho / 1024).toFixed(0)} KB, sem import externo`);

  // O contrato da função: runtime, ponto de entrada e tempo máximo.
  await writeFile(join(FUNCAO, ".vc-config.json"), JSON.stringify({
    runtime: "nodejs22.x",
    handler: "index.mjs",
    launcherType: "Nodejs",
    shouldAddHelpers: false,
    // 60 s é o teto do plano Hobby; acima disso o deploy é recusado.
    maxDuration: 60,
  }, null, 2) + "\n");

  // `type: module` para o runtime tratar o .mjs como ESM sem adivinhar.
  await writeFile(join(FUNCAO, "package.json"),
    JSON.stringify({ type: "module" }, null, 2) + "\n");

  /* --- 2. Os estáticos --- */
  const estatico = join(SAIDA, "static");
  await mkdir(estatico, { recursive: true });

  const copiados = [];
  for (const e of await readdir(RAIZ, { withFileTypes: true })) {
    // Nada que comece com ponto, e nada da lista de exclusão.
    if (e.name.startsWith(".") || NAO_PUBLICAR.has(e.name)) continue;
    await cp(join(RAIZ, e.name), join(estatico, e.name), { recursive: true });
    copiados.push(e.name);
  }
  console.log(`  estáticos: ${await contar(estatico)} arquivo(s) de ${copiados.join(", ")}`);

  // O site não funciona sem estes: `auth.js` importa o cliente do Supabase
  // de `backend/`, e um import quebrado derruba o grafo inteiro no
  // navegador — sem erro de build, sem erro na tela.
  for (const obrigatorio of ["index.html", "frontend", "backend"]) {
    if (!copiados.includes(obrigatorio)) {
      throw new Error(
        `"${obrigatorio}" não foi publicado. Está em NAO_PUBLICAR ou sumiu da raiz?`);
    }
  }

  /* --- 3. As rotas, explícitas --- */
  await writeFile(join(SAIDA, "config.json"), JSON.stringify({
    version: 3,
    routes: [
      // Cabeçalhos primeiro: `continue` deixa o pedido seguir para a
      // regra seguinte em vez de encerrar aqui.
      {
        src: "/api/(.*)",
        headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
        continue: true,
      },
      {
        src: "/(.*)",
        headers: {
          "X-Frame-Options": "SAMEORIGIN",
          "Referrer-Policy": "strict-origin-when-cross-origin",
        },
        continue: true,
      },

      // Tudo sob /api vai para a função, em qualquer profundidade. É o que
      // faltava: com a convenção de nome, só um segmento chegava lá.
      { src: "/api/(.*)", dest: "/api/index" },

      // Arquivo que existe é servido como está.
      { handle: "filesystem" },
    ],

    // O cron vive aqui porque, com a Build Output API, o `vercel.json`
    // deixa de ser lido — ele foi removido para não ficar um arquivo de
    // configuração que ninguém aplica. Uma vez por dia é o teto do plano
    // Hobby; acima disso o deploy é recusado.
    crons: [{ path: "/api/ciclos", schedule: "0 6 * * *" }],
  }, null, 2) + "\n");

  console.log(`  rotas: /api/* -> a função; o resto, arquivo estático`);

  await conferirImports(estatico);
  console.log(`\n  pronto em .vercel/output`);
}

/**
 * Segue os imports a partir das páginas e **falha o build** se faltar um.
 *
 * Existe porque faltar um módulo não dá erro em lugar nenhum: o build
 * passa, a Vercel publica, a página carrega — e o navegador morre no
 * primeiro import quebrado. Foi assim que a pasta `backend/` ficou fora
 * da publicação e o botão "Entrar" parou de funcionar, sem sinal no build
 * nem na tela.
 *
 * É a checagem que o navegador faria, antecipada para o build.
 */
async function conferirImports(estatico) {
  const vistos = new Set();
  const faltando = [];

  async function seguir(arquivo, veioDe) {
    if (vistos.has(arquivo)) return;
    vistos.add(arquivo);

    const caminho = join(estatico, arquivo);
    if (!existsSync(caminho)) {
      faltando.push(`${arquivo}  (importado por ${veioDe})`);
      return;
    }

    const txt = await readFile(caminho, "utf8");
    const specs = [
      ...[...txt.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
      ...[...txt.matchAll(/import\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
      // `<script src>` só em HTML: num `.js`, o que casa é o exemplo de
      // uso dentro de um comentário — já deu falso positivo.
      ...(arquivo.endsWith(".html")
        ? [...txt.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1])
        : []),
    ];

    for (const sp of specs) {
      if (/^https?:|^\/\/|^data:/.test(sp)) continue;   // CDN
      const base = sp.startsWith("/") ? "" : dirname(arquivo);
      const alvo = normalize(join(base, sp.replace(/^\/+/, ""))).split(sep).join("/");
      await seguir(alvo, arquivo);
    }
  }

  for (const e of await readdir(estatico, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".html")) await seguir(e.name, "(página)");
  }

  if (faltando.length) {
    throw new Error(
      `${faltando.length} import(s) quebrado(s) na saída — a página carregaria ` +
      `e morreria no navegador:\n   ${faltando.join("\n   ")}`);
  }
  console.log(`  imports: ${vistos.size} arquivos alcançados, nenhum quebrado`);
}

async function contar(dir) {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) n++;
  }
  return n;
}

await montar();
