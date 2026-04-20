// Fire a cancelable `qwen-web-orientation-change` event on device rotation.
// If no listener calls preventDefault(), we fall back to a full page reload
// (safe default for stateless pages like /login.html, /admin.html).
// Pages that can handle rotation without a reload (the terminal reconnects
// its WebSocket + refits the xterm canvas) cancel the event.
//
// Using screen.orientation so normal desktop window resizing doesn't
// trigger anything. Aspect-ratio fallback for browsers that lack it.
(() => {
  const fire = () => {
    const ev = new Event('qwen-web-orientation-change', { cancelable: true });
    const accepted = window.dispatchEvent(ev);
    if (accepted && !ev.defaultPrevented) {
      setTimeout(() => location.reload(), 50);
    }
  };

  if (screen && screen.orientation && typeof screen.orientation.addEventListener === 'function') {
    let last = screen.orientation.type;
    screen.orientation.addEventListener('change', () => {
      if (screen.orientation.type !== last) {
        last = screen.orientation.type;
        fire();
      }
    });
    return;
  }

  let orientation = window.innerWidth >= window.innerHeight ? 'l' : 'p';
  let timer = null;
  const onMaybeChange = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const now = window.innerWidth >= window.innerHeight ? 'l' : 'p';
      if (now !== orientation) {
        orientation = now;
        fire();
      }
    }, 250);
  };
  window.addEventListener('orientationchange', onMaybeChange);
  window.addEventListener('resize', onMaybeChange);
})();
