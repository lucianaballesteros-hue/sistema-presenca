-- ============================================================
-- Diagnóstico de Row Level Security (RLS) — todas as tabelas públicas
-- ============================================================
-- Referenciado em ARQUITETURA.md (seções 15.5 e 16.3). Rode as duas
-- consultas abaixo no SQL Editor do painel Supabase sempre que precisar
-- confirmar rapidamente:
--   1) quais tabelas têm RLS ligado;
--   2) quais policies existem em cada uma, pra qual comando (select/
--      insert/update/delete) e pra qual role (`authenticated` é o
--      esperado em todas — `public`/`anon` numa tabela do painel interno
--      é sinal de policy grande demais, ver seção 15 ponto 5).
--
-- Uma tabela com RLS ligado e SEM nenhuma linha na segunda consulta nega
-- tudo por padrão (nem SELECT funciona) — foi exatamente o que aconteceu
-- com `cursos` (ver sql/corrigir_rls_cursos.sql).
-- ============================================================

-- 1) RLS ligado/desligado por tabela
select
  tablename,
  rowsecurity as rls_ligado
from pg_tables
where schemaname = 'public'
order by tablename;

-- 2) Policies existentes por tabela/comando/role
select
  tablename,
  policyname,
  cmd as comando,
  roles,
  qual as using_expr,
  with_check as with_check_expr
from pg_policies
where schemaname = 'public'
order by tablename, cmd;
