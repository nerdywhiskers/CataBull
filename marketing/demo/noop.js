// Suppress navigation on every demo control marked [data-noop]. Adds a
// short pulse so clicks feel acknowledged.
(function () {
  function bind() {
    document.querySelectorAll('[data-noop]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        el.classList.add('demo-pulse');
        setTimeout(() => el.classList.remove('demo-pulse'), 250);
      });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
