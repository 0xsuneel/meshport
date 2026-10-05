// Boot scripts (moved out of index.html so the Content-Security-Policy can
// forbid inline scripts). Loaded synchronously in <head>, before any CSS
// paints, exactly where the theme script used to run.

// ── Theme bootstrap ──
      (function () {
        try {
          var mode = 'system';
          var stored = localStorage.getItem('meshport-theme-v1');
          if (stored) {
            var parsed = JSON.parse(stored);
            mode = (parsed && parsed.state && parsed.state.mode) || 'system';
          }
          var resolved = mode === 'system'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
            : mode;
          document.documentElement.setAttribute('data-theme', resolved);
          document.documentElement.style.colorScheme = resolved;
        } catch (e) {
          document.documentElement.setAttribute('data-theme', 'dark');
        }
      })();

// ── Quiet splash on refresh ──
      // Only a real app open gets the teal opening screen; a refresh in the
      // same tab (App.tsx sets the flag once loaded) gets the quiet version.
      try { if (sessionStorage.getItem('mp_opened')) document.documentElement.classList.add('mp-refresh'); } catch (e) {}

// ── Splash watchdog ──
      // ── Splash watchdog — pure vanilla JS, runs independently of the React
      // bundle ever loading at all. If the app hasn't mounted (and removed
      // #splash) within 10s, something is genuinely stuck — most likely a
      // stale cached index.html referencing a main bundle filename that's
      // since been replaced by a newer deploy, so the <script type="module">
      // tag below 404s silently with no error surfaced anywhere. Without
      // this, that failure mode hangs on the splash forever with no
      // indication anything is wrong and no way to recover except knowing
      // to manually clear site data. This turns a silent infinite hang into
      // a clear, one-tap fix.
      setTimeout(function () {
        var splash = document.getElementById('splash');
        if (!splash || splash.classList.contains('splash-hide')) return;
        // The splash is brand teal in both themes (also after a refresh).
        document.documentElement.classList.remove('mp-refresh');
        var fg = '#FFFFFF';
        var muted = '#A9D9CF';
        splash.innerHTML =
          '<div style="display:flex;flex-direction:column;align-items:center;gap:16px;padding:0 32px;text-align:center;">' +
            '<div style="color:' + fg + ';font-size:15px;font-weight:600;">Taking longer than usual to load</div>' +
            '<div style="color:' + muted + ';font-size:13px;line-height:1.5;">This can happen right after an update. Tap below to get the latest version.</div>' +
            '<button id="mp-reload" style="background:#FFFFFF;color:#0F5C57;border:none;border-radius:14px;padding:12px 28px;font-size:14px;font-weight:700;cursor:pointer;">Reload</button>' +
          '</div>';
        var rb = document.getElementById('mp-reload');
        if (rb) rb.addEventListener('click', function () { window.location.reload(); });
      }, 10000);
