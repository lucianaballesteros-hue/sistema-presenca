/**
 * Executa SQL direto no Postgres do Supabase.
 *
 *     node --env-file=.env scripts/db.ts <arquivo.sql>
 *     node --env-file=.env scripts/db.ts --check
 *
 * Lê `DATABASE_URL` do `.env` — a connection string do painel Supabase
 * (Settings → Database → Connection string → URI), com a senha no lugar de
 * `[YOUR-PASSWORD]`.
 *
 * ⚠️ Essa credencial é o superusuário do banco: alcança tudo, inclusive o que
 * a service_role não alcança, e ignora RLS por completo. Vive só no `.env`,
 * que está no .gitignore.
 */

import { readFile } from "node:fs/promises";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(`
  DATABASE_URL não está no .env.

  Pegue em: painel Supabase → Settings → Database → Connection string → URI
  e troque [YOUR-PASSWORD] pela senha do banco.

  No .env:
    DATABASE_URL=postgresql://postgres:SENHA@db.xxxx.supabase.co:5432/postgres
`);
  process.exit(1);
}

// O Supabase exige TLS, mas usa certificado que a cadeia padrão do Node não
// valida. `rejectUnauthorized: false` mantém a conexão cifrada sem travar na
// verificação — é o que a própria documentação deles orienta para scripts.
const cliente = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

const alvo = process.argv[2];

async function conferir() {
  const tabelas = await cliente.query(`
    select tablename, rowsecurity
      from pg_tables
     where schemaname = 'public'
       and tablename in ('links_cadastro','alunos_staging','turmas_staging','importacoes')
     order by tablename`);

  console.log("\n  TABELAS DO CADASTRO ONLINE");
  if (!tabelas.rows.length) {
    console.log("     nenhuma — o script de instalação ainda não rodou");
  } else {
    for (const r of tabelas.rows) {
      console.log(`     ${r.tablename.padEnd(20)} RLS ${r.rowsecurity ? "ligado ✔" : "DESLIGADO ✖"}`);
    }
  }

  const policies = await cliente.query(`
    select tablename, policyname, roles::text as roles, cmd
      from pg_policies
     where schemaname = 'public'
       and tablename in ('links_cadastro','alunos_staging','turmas_staging','importacoes')
     order by tablename, policyname`);

  console.log("\n  POLICIES");
  for (const r of policies.rows) {
    // Policy para `anon` nestas tabelas seria furo: o público só deve falar
    // com as funções security definer, nunca com as tabelas.
    const perigo = /anon/.test(r.roles) ? "   ⚠️ PERMITE anon" : "";
    console.log(`     ${r.tablename.padEnd(20)} ${r.policyname.padEnd(16)} ${r.roles.padEnd(18)} ${r.cmd}${perigo}`);
  }

  const funcs = await cliente.query(`
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'cadastro_publico_%'
     order by p.proname`);

  console.log("\n  FUNÇÕES PÚBLICAS");
  for (const r of funcs.rows) console.log(`     ${r.proname}(${r.args})`);

  const contagens = await cliente.query(`
    select 'links_cadastro' as t, count(*) from public.links_cadastro
    union all select 'alunos_staging', count(*) from public.alunos_staging
    union all select 'turmas_staging', count(*) from public.turmas_staging
    union all select 'importacoes', count(*) from public.importacoes
  `).catch(() => null);

  if (contagens) {
    console.log("\n  LINHAS");
    for (const r of contagens.rows) console.log(`     ${r.t.padEnd(20)} ${r.count}`);
  }
  console.log("");
}

try {
  await cliente.connect();
  const { rows } = await cliente.query("select current_database() db, current_user usr, version()");
  console.log(`  conectado: ${rows[0].db} como ${rows[0].usr}`);

  if (!alvo || alvo === "--check") {
    await conferir();
  } else {
    const sql = await readFile(alvo, "utf8");
    console.log(`  executando ${alvo} (${sql.length.toLocaleString("pt-BR")} caracteres)…`);
    // Sem transação explícita: o script é idempotente e alguns comandos
    // (create index concurrently, por exemplo) não rodam dentro de uma.
    await cliente.query(sql);
    console.log(`  ✔ executado sem erros`);
    await conferir();
  }
} catch (erro) {
  const e = erro as Error & { position?: string; hint?: string; detail?: string };
  console.error(`\n  ✖ ${e.message}`);
  if (e.detail) console.error(`     detalhe: ${e.detail}`);
  if (e.hint) console.error(`     dica: ${e.hint}`);
  if (e.position) console.error(`     posição: caractere ${e.position}`);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
