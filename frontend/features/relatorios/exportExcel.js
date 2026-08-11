import { state } from '../../state/store.js';
import { calcAluno, aulasDaTurma } from '../../../backend/domain/attendance.js';
import { professorNome } from '../../../backend/domain/status.js';
import { showToast } from '../../shared/dom.js';

// A biblioteca xlsx é carregada via <script> global no index.html (sem passo
// de build neste projeto). Ela só é usada aqui, então mantemos o acoplamento
// ao global `XLSX` isolado neste único arquivo.
export async function exportarExcel() {
  const btn = document.getElementById('btn-exportar');
  if (btn) { btn.disabled = true; btn.textContent = 'Gerando...'; }

  try {
    const wb = XLSX.utils.book_new();
    const resumoRows = [
      ['Relatório de Frequência — Todas as Turmas'],
      ['Gerado em: ' + new Date().toLocaleString('pt-BR')],
      [],
      ['Turma', 'Curso', 'Professor', 'Aluno', 'Status', 'Presenças', 'Faltas', '% Frequência', 'Faltas Consecutivas', 'Situação'],
    ];

    state.TURMAS.forEach(t => {
      state.ALUNOS.filter(a => a.turma_id === t.id).forEach(a => {
        const c = calcAluno(a);
        const situacao = !a.ativo ? 'Inativo' : c.emAlerta ? 'Alerta' : c.freq === null ? 'Sem registro' : c.freq >= 70 ? 'Regular' : 'Atenção';
        resumoRows.push([t.turma, t.curso, professorNome(t), a.nome, a.ativo ? 'Ativo' : 'Inativo', c.p, c.f, c.freq !== null ? c.freq / 100 : null, c.maxConsec, situacao]);
      });
    });

    const wsResumo = XLSX.utils.aoa_to_sheet(resumoRows);
    for (let r = 4; r < resumoRows.length; r++) {
      const cell = XLSX.utils.encode_cell({ r, c: 7 });
      if (wsResumo[cell] && typeof wsResumo[cell].v === 'number') wsResumo[cell].z = '0%';
    }
    wsResumo['!cols'] = [{ wch: 20 }, { wch: 16 }, { wch: 18 }, { wch: 35 }, { wch: 8 }, { wch: 10 }, { wch: 8 }, { wch: 13 }, { wch: 18 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, wsResumo, 'Resumo Geral');

    const nomesUsados = new Set();
    state.TURMAS.forEach(t => {
      const alunosDaTurma = state.ALUNOS.filter(a => a.turma_id === t.id);
      if (!alunosDaTurma.length) return;
      const aulasTurma = aulasDaTurma(t);
      const aulasComDados = aulasTurma.filter(aula => {
        const key = `${t.id}_${aula}`;
        return state.PRESENCAS[key] && Object.keys(state.PRESENCAS[key]).length > 0;
      });
      const aulasCols = aulasComDados.length > 0 ? aulasComDados : aulasTurma;
      const header = ['Aluno', 'Status', ...aulasCols, 'Presenças', 'Faltas', '% Freq.', 'Faltas Consec.'];
      const rows = [
        [t.turma + ' — ' + t.curso + ' — Prof. ' + professorNome(t)],
        ['Gerado em: ' + new Date().toLocaleString('pt-BR')],
        [],
        header,
      ];
      alunosDaTurma.forEach(a => {
        const row = [a.nome, a.ativo ? 'Ativo' : 'Inativo'];
        aulasCols.forEach(aula => {
          const key = `${t.id}_${aula}`;
          row.push((state.PRESENCAS[key] && state.PRESENCAS[key][a.id]) || '');
        });
        const c = calcAluno(a);
        row.push(c.p, c.f, c.freq !== null ? c.freq / 100 : null, c.maxConsec);
        rows.push(row);
      });
      const ws = XLSX.utils.aoa_to_sheet(rows);
      const pctColIdx = 2 + aulasCols.length + 2;
      for (let r = 4; r < rows.length; r++) {
        const cell = XLSX.utils.encode_cell({ r, c: pctColIdx });
        if (ws[cell] && typeof ws[cell].v === 'number') ws[cell].z = '0%';
      }
      ws['!cols'] = [{ wch: 35 }, { wch: 8 }, ...aulasCols.map(() => ({ wch: 7 })), { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 14 }];

      let nomeAba = (t.turma || t.curso || 'Turma').substring(0, 31);
      if (nomesUsados.has(nomeAba)) {
        let contador = 2;
        while (nomesUsados.has(nomeAba.substring(0, 28) + ' ' + contador)) contador++;
        nomeAba = nomeAba.substring(0, 28) + ' ' + contador;
      }
      nomesUsados.add(nomeAba);
      XLSX.utils.book_append_sheet(wb, ws, nomeAba);
    });

    const alertaRows = [
      ['Alunos em Alerta — 3 ou mais faltas consecutivas'],
      ['Gerado em: ' + new Date().toLocaleString('pt-BR')],
      [],
      ['Turma', 'Curso', 'Professor', 'Aluno', 'Faltas Consecutivas', 'Total Faltas', '% Frequência'],
    ];
    state.TURMAS.forEach(t => {
      state.ALUNOS.filter(a => a.ativo && a.turma_id === t.id).forEach(a => {
        const c = calcAluno(a);
        if (c.emAlerta) alertaRows.push([t.turma, t.curso, professorNome(t), a.nome, c.maxConsec, c.f, c.freq !== null ? c.freq / 100 : null]);
      });
    });
    const wsAlerta = XLSX.utils.aoa_to_sheet(alertaRows);
    for (let r = 4; r < alertaRows.length; r++) {
      const cell = XLSX.utils.encode_cell({ r, c: 6 });
      if (wsAlerta[cell] && typeof wsAlerta[cell].v === 'number') wsAlerta[cell].z = '0%';
    }
    wsAlerta['!cols'] = [{ wch: 20 }, { wch: 16 }, { wch: 18 }, { wch: 35 }, { wch: 18 }, { wch: 12 }, { wch: 13 }];
    XLSX.utils.book_append_sheet(wb, wsAlerta, 'Alertas');

    XLSX.writeFile(wb, 'frequencia_' + new Date().toISOString().slice(0, 10) + '.xlsx');
    showToast('Excel gerado com sucesso!', 'green');

  } catch (err) {
    console.error('Erro ao exportar Excel:', err);
    showToast('Erro ao gerar Excel. Veja o console.', 'red');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Exportar Excel'; }
  }
}
