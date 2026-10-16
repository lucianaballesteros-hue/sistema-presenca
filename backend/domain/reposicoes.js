import { state } from '../../frontend/state/store.js';

// Uma reposição só entra na chamada depois que o aluno escolhe o horário pelo
// link público ('agendada') — e continua lá depois de marcada ('concluida'),
// para dar pra conferir ou corrigir o que foi lançado.
const STATUS_NA_CHAMADA = ['agendada', 'concluida'];

export function opcaoEscolhida(rep) {
  return (rep.reposicao_opcoes || []).find(o => o.id === rep.opcao_escolhida_id) || null;
}

// Turma onde está guardada a aula que o aluno perdeu. Normalmente é a turma de
// origem da reposição, mas se o aluno foi transferido depois, as presenças
// dele foram junto (moverPresencasDeTurma) — então vale a turma atual dele,
// que é a que calcAluno() lê.
export function turmaDaAulaPerdida(rep, aluno) {
  return aluno?.turma_id || rep.turma_origem_id;
}

// O que foi marcado na chamada da reposição. Não existe coluna própria para
// isso: o lançamento vai direto para a aula perdida, na turma original do
// aluno (é ali que conta na frequência), e o status 'concluida' é o que diz
// que aquele valor veio da reposição — enquanto ela está só 'agendada', o que
// estiver gravado lá é a falta original, não um lançamento da reposição.
export function resultadoReposicao(rep) {
  if (rep.status !== 'concluida') return '';
  const aluno = state.ALUNOS.find(a => a.id === rep.aluno_id);
  return state.PRESENCAS[`${turmaDaAulaPerdida(rep, aluno)}_${rep.aula}`]?.[rep.aluno_id] || '';
}

// Alunos de OUTRAS turmas que escolheram repor esta aula nesta turma: entram
// na chamada só nesta aula e, nas seguintes, continuam apenas na turma deles.
// A aula é casada pelo nome ("Aula 5" perdida = "Aula 5" desta turma) — mesmo
// critério das sugestões automáticas (proximaAula); o banco não guarda a data
// de cada aula para dar pra casar pelo dia escolhido.
export function reposicoesNaAula(turmaId, aula) {
  const jaListados = new Set();
  const lista = [];
  state.REPOSICOES.forEach(rep => {
    if (!STATUS_NA_CHAMADA.includes(rep.status) || rep.aula !== aula) return;
    if (opcaoEscolhida(rep)?.turma_destino_id !== turmaId) return;
    const aluno = state.ALUNOS.find(a => a.id === rep.aluno_id);
    if (!aluno || !aluno.ativo || aluno.turma_id === turmaId || jaListados.has(aluno.id)) return;
    jaListados.add(aluno.id);
    lista.push({ rep, aluno });
  });
  return lista;
}

// Reposição (agendada ou já feita) de uma aula perdida — usada na chamada da
// turma de origem para avisar que aquela aula está sendo reposta em outra
// turma (e explicar de onde veio o lançamento, se já foi marcada lá).
export function reposicaoDaAulaPerdida(alunoId, aula) {
  return state.REPOSICOES.find(rep =>
    rep.aluno_id === alunoId && rep.aula === aula && STATUS_NA_CHAMADA.includes(rep.status)
  ) || null;
}
