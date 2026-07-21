-- ============================================================
-- Reforço de RLS nas tabelas do painel principal.
-- ============================================================
--
-- Confirmado pela consulta a pg_policies: as 6 policies abaixo já existem e
-- já têm a lógica certa (professor só vê as próprias turmas/alunos/presenças/
-- histórico, admin vê tudo de professores) — o problema é que estão
-- liberadas para o role "public", que no Postgres significa TODO MUNDO,
-- incluindo "anon" (ou seja, incluindo um aluno que só tem o link de
-- reposição, sem nunca ter feito login).
--
-- Isso é diferente do que este script fazia antes: aqui NÃO apagamos nem
-- recriamos nenhuma policy — ALTER POLICY só troca quem pode usá-la (o
-- "TO"), sem tocar na condição (USING/WITH CHECK) de cada uma. A lógica de
-- quem-vê-o-quê continua exatamente a mesma; só deixa de valer para quem não
-- está autenticado.
--
-- Tabelas `reposicoes`/`reposicao_opcoes` não precisam disso — a policy
-- delas (`staff_full_access`) já nasceu restrita a `{authenticated}`.
--
-- Recomendo testar login + uma chamada + um relatório logo depois de rodar,
-- só para confirmar visualmente que nada mudou para quem já está logado.
-- ============================================================

-- Garante que RLS está ligado (idempotente — não faz nada se já estiver).
alter table turmas enable row level security;
alter table alunos enable row level security;
alter table presencas enable row level security;
alter table historico enable row level security;
alter table professores enable row level security;

-- Restringe cada policy existente a "authenticated", preservando a lógica.
alter policy professor_ver_turmas on turmas to authenticated;
alter policy professor_ver_alunos on alunos to authenticated;
alter policy professor_ver_presencas on presencas to authenticated;
alter policy professor_ver_historico on historico to authenticated;
alter policy admin_ver_tudo_professores on professores to authenticated;
alter policy professor_ver_proprio on professores to authenticated;
