// A biblioteca de planilhas (xlsx, ~1 MB) só é usada para importar alunos e
// exportar o relatório. Antes ela vinha num <script> no <head> do index.html
// e travava a abertura do sistema inteiro até baixar; agora é buscada na
// primeira vez que alguém importa ou exporta, e fica no global `XLSX`.
const URL_XLSX = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
const INTEGRIDADE_XLSX = 'sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT';

let carregando = null;

export function carregarXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  carregando ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = URL_XLSX;
    script.integrity = INTEGRIDADE_XLSX;
    script.crossOrigin = 'anonymous';
    script.onload = () => resolve(window.XLSX);
    script.onerror = () => {
      carregando = null; // deixa tentar de novo no próximo clique
      script.remove();
      reject(new Error('Não foi possível carregar a biblioteca de planilhas.'));
    };
    document.head.appendChild(script);
  });
  return carregando;
}
