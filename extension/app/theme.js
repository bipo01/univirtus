// Aplica o tema antes de a página aparecer (evita "piscar"). Padrão: claro.
try {
  document.documentElement.dataset.theme = localStorage.getItem('ava-theme') === 'dark' ? 'dark' : 'light';
} catch {
  document.documentElement.dataset.theme = 'light';
}
