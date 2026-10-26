// Tema salvo antes de desenhar (a página não pode ter script embutido: CSP da extensão).
try {
  const t = localStorage.getItem('ava-theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
} catch {
  /* sem tema salvo */
}
