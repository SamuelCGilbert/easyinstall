// Light/dark theme. Loaded in <head> before the page paints, so there's no flash of the wrong theme.
// No saved choice means "follow the system setting".
(function () {
  var KEY = 'ei.theme';
  var root = document.documentElement;
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function apply() {
    var t = saved();
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t); else root.removeAttribute('data-theme');
    var dark = t === 'dark' || (t !== 'light' && mq.matches);
    root.classList.toggle('dark-ui', dark);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#161c27' : '#ffffff');
    window.dispatchEvent(new CustomEvent('ei-theme', { detail: { dark: dark } }));
  }
  apply();
  if (mq.addEventListener) mq.addEventListener('change', apply);
  window.eiTheme = {
    isDark: function () { return root.classList.contains('dark-ui'); },
    toggle: function () {
      try { localStorage.setItem(KEY, window.eiTheme.isDark() ? 'light' : 'dark'); } catch (e) {}
      apply();
    },
  };
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('[data-theme-toggle]')) window.eiTheme.toggle();
  });
})();
