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
 */

import { build } from "esbuild";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const RAIZ = resolve(import.meta.dirname, "..");
const SAIDA = join(RAIZ, ".vercel", "output");
const FUNCAO = join(SAIDA, "functions", "api", "index.func");

/** Tudo que o navegador baixa direto, sem passar pela função. */
const ESTATICOS = [
  "index.html",
  "admin-turmas.html",
  "admin-alunos.html",
  "cadastro.html",
  "reposicao.html",
  "frontend",
];

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
  for (const item of ESTATICOS) {
    await cp(join(RAIZ, item), join(estatico, item), { recursive: true });
  }
  console.log(`  estáticos: ${await contar(estatico)} arquivo(s)`);

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
  console.log(`\n  pronto em .vercel/output`);
}

async function contar(dir) {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) n++;
  }
  return n;
}

await montar();
