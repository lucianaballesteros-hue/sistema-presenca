-- ============================================================
-- Verificação de segurança — rode isso no SQL Editor do Supabase.
-- Não muda nada no banco, só mostra o estado atual.
-- ============================================================
--
-- Por que isso importa para a página de reposição:
-- a página pública (reposicao.html) usa a MESMA chave "anon" que o painel
-- principal já usa — isso é inevitável (é a mesma chave pública de sempre,
-- que qualquer visitante do index.html já carrega no navegador antes mesmo
-- de fazer login). A única coisa que separa "aluno com o link" de "aluno
-- lendo a tabela de alunos inteira" é o Row Level Security (RLS) de cada
-- tabela — não o código deste repositório.
--
-- As tabelas `reposicoes`/`reposicao_opcoes` (criadas por sql/reposicoes.sql)
-- já estão corretamente fechadas para "anon". O que este script confere é
-- se as tabelas ANTIGAS (turmas, alunos, presencas, historico, professores)
-- também estão.

-- 1) RLS está LIGADO em todas as tabelas? (rowsecurity deve ser "true" em todas)
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by tablename;

-- 2) Quais policies existem, e para quem (coluna "roles")?
--    O que você NÃO quer ver: qualquer linha com "anon" na coluna roles
--    para turmas/alunos/presencas/historico/professores.
select schemaname, tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- ============================================================
-- Como ler o resultado:
--   - Se `rowsecurity` = false em alguma tabela → RLS está DESLIGADO nela,
--     ou seja, qualquer pessoa com a chave anon (inclusive um aluno que só
--     tem o link de reposição) consegue ler/escrever essa tabela inteira
--     agora mesmo, direto pela API do Supabase.
--   - Se `rowsecurity` = true mas existe uma policy com "anon" no `roles`
--     para uma dessas 5 tabelas → o mesmo problema, de um jeito mais
--     específico.
--   - Se `rowsecurity` = true e nenhuma policy menciona "anon" para essas
--     5 tabelas → já está seguro, nenhuma ação necessária.
--
-- Se encontrar algum problema, o arquivo sql/reforcar_rls.sql resolve —
-- mas leia a explicação nele antes de rodar.
-- ============================================================
