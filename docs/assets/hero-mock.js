// Hero mock — per-session side panel + per-artefact preview
(function () {
  const sessions = {
    s1: {
      title: 'Refactor checkout flow',
      status: 'hm-status-g',
      meta: 'claude-code · acme-app · 2m ago',
      transcript: [
        ['user', '↳ Refactor billing module to handle multi-currency.'],
        ['', 'Reading src/checkout/cart.ts and the payment flow…'],
        ['tool', 'edit_file: src/checkout/cart.ts'],
        ['tool', 'edit_file: src/checkout/payment.ts'],
        ['tool', 'run: npm test'],
      ],
      memories: ['Customer prefers email summaries on Fridays — keep under 200 words.'],
      artefacts: ['Onboarding', 'Settings UI'],
      files: [['cart.ts', 24, 3], ['payment.ts', 18, 7], ['checkout.test.ts', 9, 0]],
    },
    s2: {
      title: 'Stakeholder pitch v3',
      status: 'hm-status-a',
      meta: 'cursor · pitch-deck · awaiting',
      transcript: [
        ['user', '↳ Refresh the Q4 deck with the new pricing slide.'],
        ['', 'Pulled 1 memory about the pricing decision.'],
        ['tool', 'edit_file: pitch-deck/04-pricing.md'],
        ['', 'Awaiting your review on slide 4.'],
      ],
      memories: ['Pitch deck needs the revised pricing slide before Wednesday’s review.'],
      artefacts: ['Q4 Pitch'],
      files: [['04-pricing.md', 32, 8], ['outline.md', 4, 0]],
    },
    s3: {
      title: 'Investigate API latency',
      status: 'hm-status-r',
      meta: 'claude-code · acme-app · 1h ago',
      transcript: [
        ['user', '↳ p99 spiking on /api/checkout — can you take a look?'],
        ['tool', 'read_file: server/logs/2026-05-01.log'],
        ['', 'Database query taking 2.3s — missing index on orders.created_at.'],
        ['tool', 'edit_file: migrations/0042_orders_index.sql'],
        ['', 'Connection lost. Resume with: claude -c <id>'],
      ],
      memories: [],
      artefacts: ['Onboarding'],
      files: [['0042_orders_index.sql', 8, 0]],
    },
    s4: {
      title: 'Weekly retro write-up',
      status: 'hm-status-d',
      meta: 'claude-code · field-notes · yesterday',
      transcript: [
        ['user', '↳ Summarise this week — wins, blockers, decisions.'],
        ['tool', 'list_artifacts: field-notes'],
        ['', 'Collated 7 sessions into a retro doc. Ready for review.'],
        ['tool', 'edit_file: field-notes/2026-04-29.md'],
      ],
      memories: [],
      artefacts: ['Launch list'],
      files: [['2026-04-29.md', 142, 0]],
    },
  };

  const memories = {
    m1: {
      text: 'Customer prefers email summaries on Fridays — keep under 200 words and lead with decisions, not analysis.',
      meta: 'acme-app · claude-code · 4h ago',
      writtenBy: { agent: 'claude-code', session: 'Refactor checkout flow', state: 'g' },
      pulledBy: [
        { title: 'Refactor checkout flow', state: 'g' },
        { title: 'Investigate API latency', state: 'd' },
      ],
      artefacts: ['Onboarding'],
    },
    m2: {
      text: 'Pitch deck needs the revised pricing slide before Wednesday’s stakeholder review.',
      meta: 'pitch-deck · cursor · yesterday',
      writtenBy: { agent: 'cursor', session: 'Stakeholder pitch v3', state: 'a' },
      pulledBy: [
        { title: 'Stakeholder pitch v3', state: 'a' },
      ],
      artefacts: ['Q4 Pitch'],
    },
  };

  const status = document.getElementById('hm-side-status');
  const title = document.getElementById('hm-side-title');
  const meta = document.getElementById('hm-side-meta');
  const body = document.getElementById('hm-side-body');
  if (!status || !body) return;

  function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  function block(name, html) {
    return '<div class="hm-side-block"><div class="hm-side-block-name">' + name + '</div>' + html + '</div>';
  }

  function renderSession(id) {
    const s = sessions[id];
    if (!s) return;
    status.className = 'hm-status ' + s.status;
    title.textContent = s.title;
    meta.textContent = s.meta;

    const transcript = s.transcript.map(([k, t]) =>
      '<div class="hm-side-line' + (k ? ' ' + k : '') + '">' + esc(t) + '</div>'
    ).join('');

    const mems = s.memories.length
      ? s.memories.map(m => '<div class="hm-side-mem">' + esc(m) + '</div>').join('')
      : '<div class="hm-side-empty">No memories pulled.</div>';

    const arts = '<div class="hm-side-arts">' + (s.artefacts.length
      ? s.artefacts.map(a => '<span class="hm-side-art-chip">' + esc(a) + '</span>').join('')
      : '<div class="hm-side-empty">No artefacts touched.</div>') + '</div>';

    const files = s.files.length
      ? s.files.map(([n, a, r]) =>
        '<div class="hm-side-file"><span class="hm-side-file-name">' + esc(n) + '</span>' +
        (a ? '<span class="add">+' + a + '</span>' : '') +
        (r ? '<span class="rm">−' + r + '</span>' : '') + '</div>'
      ).join('')
      : '<div class="hm-side-empty">No files touched.</div>';

    body.innerHTML = block('Transcript', transcript) + block('Memories', mems) + block('Artefacts', arts) + block('Files touched', files);
  }

  function renderMemory(id) {
    const m = memories[id];
    if (!m) return;
    status.className = 'hm-status hm-status-mem';
    title.textContent = 'Memory';
    meta.textContent = m.meta;

    const text = '<div class="hm-side-bigtext">' + esc(m.text) + '</div>';

    const written = '<div class="hm-side-pill"><span class="pip-' + m.writtenBy.state + '"></span>' +
      esc(m.writtenBy.session) + ' · ' + esc(m.writtenBy.agent) + '</div>';

    const pulled = m.pulledBy.length
      ? m.pulledBy.map(p => '<div class="hm-side-pill"><span class="pip-' + p.state + '"></span>' + esc(p.title) + '</div>').join('')
      : '<div class="hm-side-empty">Not yet recalled.</div>';

    const arts = '<div class="hm-side-arts">' + (m.artefacts.length
      ? m.artefacts.map(a => '<span class="hm-side-art-chip">' + esc(a) + '</span>').join('')
      : '<div class="hm-side-empty">No artefacts linked.</div>') + '</div>';

    body.innerHTML = text + block('Written by', written) + block('Pulled by', pulled) + block('Linked artefacts', arts);
  }

  const mock = document.querySelector('.hero-mock');
  const sidePanel = mock.querySelector('.hm-side');
  const previewPanel = mock.querySelector('.hm-preview');
  const sideBack = document.getElementById('hm-side-back');
  // Remember which element opened the panel so we can restore focus on close — keyboard navigation
  // shouldn't dump users back at the document root after dismissing.
  let lastSideFocus = null;
  let lastPreviewFocus = null;

  // Hover (desktop) renders content into the side panel transiently — CSS handles the reveal.
  // Click / Enter / Space pins the panel open: renders content AND adds .is-side-open to the mock,
  // so taps on touch devices work and desktop users can "pin" a session for closer reading.
  function clearActive() {
    mock.querySelectorAll('.hm-tile.is-active, .hm-mem.is-active').forEach(el => el.classList.remove('is-active'));
  }
  function openSide(originEl) {
    if (!mock.classList.contains('is-side-open')) lastSideFocus = originEl || document.activeElement;
    mock.classList.add('is-side-open');
    if (sidePanel) sidePanel.setAttribute('aria-hidden', 'false');
    if (sideBack) requestAnimationFrame(() => sideBack.focus());
  }
  function pinSession(tile) {
    clearActive();
    tile.classList.add('is-active');
    renderSession(tile.dataset.session);
    openSide(tile);
  }
  function pinMemory(mem) {
    clearActive();
    mem.classList.add('is-active');
    renderMemory(mem.dataset.memory);
    openSide(mem);
  }
  function closeSide() {
    mock.classList.remove('is-side-open');
    if (sidePanel) sidePanel.setAttribute('aria-hidden', 'true');
    clearActive();
    if (lastSideFocus && document.contains(lastSideFocus)) lastSideFocus.focus();
    lastSideFocus = null;
  }

  // Hover is the transient "peek" — but stop swapping content once the user has pinned a panel,
  // otherwise the active highlight on one tile would mismatch the content showing for another.
  document.querySelectorAll('.hm-tile').forEach(tile => {
    // Tiles marked .hm-tile-running are the demo entry point for the running
    // terminal — handled in the running-terminals block further down. Skip the
    // generic side-panel wiring so hovering doesn't pop the side panel.
    if (tile.classList.contains('hm-tile-running')) return;
    tile.addEventListener('mouseenter', () => {
      if (mock.classList.contains('is-side-open')) return;
      renderSession(tile.dataset.session);
    });
    tile.addEventListener('click', e => { e.stopPropagation(); pinSession(tile); });
    tile.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pinSession(tile); }
    });
  });
  document.querySelectorAll('.hm-mem[data-memory]').forEach(mem => {
    mem.addEventListener('mouseenter', () => {
      if (mock.classList.contains('is-side-open')) return;
      renderMemory(mem.dataset.memory);
    });
    mem.addEventListener('click', e => { e.stopPropagation(); pinMemory(mem); });
    mem.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pinMemory(mem); }
    });
  });

  if (sideBack) sideBack.addEventListener('click', e => { e.stopPropagation(); closeSide(); });

  renderSession('s1');

  // Artefact preview content
  const artefacts = {
    onboarding: {
      title: 'Onboarding · acme-app',
      body: `<div class="pv-app-grid">
        <div class="pv-card"><div class="pv-card-label">step 1</div><div class="pv-card-title">Profile</div></div>
        <div class="pv-card"><div class="pv-card-label">step 2</div><div class="pv-card-title">Connect repo</div></div>
        <div class="pv-card"><div class="pv-card-label">step 3</div><div class="pv-card-title">Invite team</div></div>
        <div class="pv-card"><div class="pv-card-label">step 4</div><div class="pv-card-title">First task</div></div>
      </div>`,
    },
    pitch: {
      title: 'Q4 Pitch · 04 of 12',
      body: `<div class="pv-slide">
        <div class="pv-slide-num">04 / 12 · pricing</div>
        <h4>What changes in Q4</h4>
        <ul>
          <li>$20/month for Pro, individual</li>
          <li>$192/year — save 20%</li>
          <li>Free tier stays unlimited</li>
        </ul>
      </div>`,
    },
    auth: {
      title: 'Auth flow · diagram',
      body: `<div class="pv-diag">
        <div class="pv-node">User</div>
        <div class="pv-arrow"></div>
        <div class="pv-node">Magic link</div>
        <div class="pv-arrow"></div>
        <div class="pv-node">Session</div>
        <div class="pv-arrow"></div>
        <div class="pv-node">Workspace</div>
      </div>`,
    },
    settings: {
      title: 'Settings · acme-app',
      body: `<div class="pv-settings">
        <div class="pv-set-row"><span class="pv-set-label">Notifications</span><span class="pv-toggle on" role="switch" aria-checked="true" tabindex="0"></span></div>
        <div class="pv-set-row"><span class="pv-set-label">Default agent</span><span class="pv-set-value">Claude Code</span></div>
        <div class="pv-set-row"><span class="pv-set-label">Theme</span><span class="pv-set-value">Dark</span></div>
        <div class="pv-set-row"><span class="pv-set-label">Auto-sync</span><span class="pv-toggle on" role="switch" aria-checked="true" tabindex="0"></span></div>
        <div class="pv-set-row"><span class="pv-set-label">Share usage data</span><span class="pv-toggle" role="switch" aria-checked="false" tabindex="0"></span></div>
      </div>`,
    },
    launch: {
      title: 'Launch list · field-notes',
      body: `<div class="pv-list">
        <h4>Launch checklist</h4>
        <ul>
          <li class="done" role="checkbox" aria-checked="true" tabindex="0"><span class="pv-chk done">✓</span>Pricing page live</li>
          <li class="done" role="checkbox" aria-checked="true" tabindex="0"><span class="pv-chk done">✓</span>Hero mock approved</li>
          <li class="done" role="checkbox" aria-checked="true" tabindex="0"><span class="pv-chk done">✓</span>0.5.0-beta.1 published</li>
          <li role="checkbox" aria-checked="false" tabindex="0"><span class="pv-chk"></span>Beta to Henry</li>
          <li role="checkbox" aria-checked="false" tabindex="0"><span class="pv-chk"></span>Reddit announcement</li>
          <li role="checkbox" aria-checked="false" tabindex="0"><span class="pv-chk"></span>HN post</li>
        </ul>
      </div>`,
    },
  };

  const previewTitle = document.getElementById('hm-preview-title');
  const previewBody = document.getElementById('hm-preview-body');

  function renderArtefact(cell) {
    const a = artefacts[cell.dataset.artefact];
    if (!a) return;
    previewTitle.textContent = a.title;
    previewBody.innerHTML = a.body;
  }

  function pinArtefact(cell) {
    if (!mock.classList.contains('is-preview-open')) lastPreviewFocus = cell;
    mock.querySelectorAll('.hm-art-cell.is-active').forEach(el => el.classList.remove('is-active'));
    cell.classList.add('is-active');
    renderArtefact(cell);
    mock.classList.add('is-preview-open');
    if (previewPanel) previewPanel.setAttribute('aria-hidden', 'false');
    const closeBtn = document.getElementById('hm-preview-close');
    if (closeBtn) requestAnimationFrame(() => closeBtn.focus());
  }

  document.querySelectorAll('.hm-art-cell[data-artefact]').forEach(cell => {
    cell.addEventListener('mouseenter', () => {
      if (mock.classList.contains('is-preview-open')) return;
      renderArtefact(cell);
    });
    // The rocket-ship cell owns its own click handler (launches the easter egg) — don't shadow it.
    if (cell.classList.contains('hm-art-cell-launchable')) return;
    cell.addEventListener('click', e => { e.stopPropagation(); pinArtefact(cell); });
    cell.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pinArtefact(cell); }
    });
    // Pointer-events safety net for touch: pointerup fires reliably for mouse/pen/touch even when
    // Safari's hover-tap interpretation eats the click event. Idempotent with the click handler.
    cell.addEventListener('pointerup', e => {
      if (e.pointerType === 'mouse') return;
      e.stopPropagation();
      pinArtefact(cell);
    });
  });

  const previewClose = document.getElementById('hm-preview-close');
  function closePreview() {
    mock.classList.remove('is-preview-open');
    if (previewPanel) previewPanel.setAttribute('aria-hidden', 'true');
    mock.querySelectorAll('.hm-art-cell.is-active').forEach(el => el.classList.remove('is-active'));
    if (lastPreviewFocus && document.contains(lastPreviewFocus)) lastPreviewFocus.focus();
    lastPreviewFocus = null;
  }
  if (previewClose) previewClose.addEventListener('click', e => { e.stopPropagation(); closePreview(); });

  // Interactive preview content — event delegation so handlers survive content swaps.
  function toggleListItem(li) {
    const chk = li.querySelector('.pv-chk');
    const nowDone = li.classList.toggle('done');
    if (chk) {
      chk.classList.toggle('done', nowDone);
      chk.textContent = nowDone ? '✓' : '';
    }
    li.setAttribute('aria-checked', nowDone ? 'true' : 'false');
  }
  function togglePvToggle(toggle) {
    const nowOn = toggle.classList.toggle('on');
    toggle.setAttribute('aria-checked', nowOn ? 'true' : 'false');
  }
  previewBody.addEventListener('click', e => {
    e.stopPropagation();
    const li = e.target.closest('.pv-list li');
    if (li) { toggleListItem(li); return; }
    const toggle = e.target.closest('.pv-toggle');
    if (toggle) { togglePvToggle(toggle); return; }
  });
  previewBody.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const li = e.target.closest('.pv-list li');
    if (li) { e.preventDefault(); toggleListItem(li); return; }
    const toggle = e.target.closest('.pv-toggle');
    if (toggle) { e.preventDefault(); togglePvToggle(toggle); return; }
  });

  // Space-filter pills: tap toggles the filter; tap again clears it.
  const FILTER_CLASSES = ['is-filter-acme-app', 'is-filter-pitch-deck', 'is-filter-field-notes'];
  document.querySelectorAll('.hm-pill[data-space]').forEach(pill => {
    pill.addEventListener('click', e => {
      e.stopPropagation();
      const space = pill.dataset.space;
      const cls = 'is-filter-' + space;
      const wasActive = mock.classList.contains(cls);
      mock.classList.remove(...FILTER_CLASSES);
      mock.querySelectorAll('.hm-pill[data-space].is-filter-on').forEach(p => p.classList.remove('is-filter-on'));
      if (!wasActive) {
        mock.classList.add(cls);
        pill.classList.add('is-filter-on');
      }
    });
  });

  // ----------------------------------------------------------------
  // Running-terminals demo: pill, popover, simulated terminal panel.
  // Inspired by the in-app RunningTerminalsPill + TerminalWindow.
  // ----------------------------------------------------------------
  const pill = document.getElementById('hm-rtp-pill');
  const popover = document.getElementById('hm-rtp-popover');
  const row = document.getElementById('hm-rtp-row');
  const activity = document.getElementById('hm-rtp-activity');
  const term = document.getElementById('hm-terminal');
  const termBody = document.getElementById('hm-terminal-body');
  const termClose = document.getElementById('hm-terminal-close');

  if (!pill || !popover || !row || !term || !termBody) return;

  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Canned scrollback — short, believable Claude Code session. The last entry
  // is the session-ended marker that ends the run; demo loops after a pause.
  const SCRIPT = [
    { delay: 0,    kind: 'user', text: 'refactor billing module to handle multi-currency' },
    { delay: 700,  kind: 'tool', text: 'Read(src/checkout/cart.ts)' },
    { delay: 1300, kind: 'tool', text: 'Read(src/checkout/payment.ts)' },
    { delay: 2100, kind: 'tool', text: 'Edit(src/checkout/cart.ts)',     result: '24 lines changed' },
    { delay: 3000, kind: 'tool', text: 'Edit(src/checkout/payment.ts)',  result: '18 lines changed' },
    { delay: 3900, kind: 'tool', text: 'Bash(npm test)',                 result: '9 passed in 1.2s' },
    { delay: 5000, kind: 'tool', text: 'Bash(gh pr create)',             result: 'opened PR #218' },
    { delay: 6100, kind: 'text', text: 'Ready for review — handing back to you.' },
    { delay: 7000, kind: 'exit', text: '[session ended (exit 0)]' },
  ];
  const LOOP_PAUSE_MS = 2400;
  const ACTIVITY_TICK_MS = 1000;

  let popoverPinned = false;
  let terminalOpen = false;
  let playTimers = [];
  let loopTimer = null;
  let activityTimer = null;
  let activitySeconds = 4;
  let closeGraceTimer = null;
  const CLOSE_GRACE_MS = 220;   // forgive cursor crossings between hover zones

  function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  function setActivity(text) { if (activity) activity.textContent = text; }

  function startActivityTicker() {
    stopActivityTicker();
    activityTimer = setInterval(() => {
      activitySeconds += 1;
      setActivity('cooking ' + activitySeconds + 's');
    }, ACTIVITY_TICK_MS);
  }
  function stopActivityTicker() {
    if (activityTimer) { clearInterval(activityTimer); activityTimer = null; }
  }

  function pinPopover() {
    popoverPinned = true;
    popover.classList.add('is-pinned');
    pill.setAttribute('aria-expanded', 'true');
  }
  function unpinPopover() {
    popoverPinned = false;
    popover.classList.remove('is-pinned');
    pill.setAttribute('aria-expanded', 'false');
  }

  function clearPlayTimers() {
    playTimers.forEach(t => clearTimeout(t));
    playTimers = [];
    if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
  }

  function renderBanner() {
    const banner = document.createElement('div');
    banner.className = 'hm-term-banner';
    banner.innerHTML = '<span class="accent">✻ Welcome to Claude Code</span>  <span style="color: rgba(207,227,225,0.35)">/Users/you/acme-app</span>';
    termBody.appendChild(banner);
  }

  function appendLine(step) {
    const line = document.createElement('div');
    line.className = 'hm-term-line ' + step.kind;
    if (step.kind === 'user') {
      line.innerHTML = '<span class="pfx-user">&gt;</span>' + esc(step.text);
    } else if (step.kind === 'tool') {
      const result = step.result ? '  <span class="pfx-dim">⎿</span><span style="color: rgba(207,227,225,0.55)">' + esc(step.result) + '</span>' : '';
      line.innerHTML = '<span class="pfx-tool">⏺</span>' + esc(step.text) + result;
    } else if (step.kind === 'text') {
      line.innerHTML = '<span class="pfx-tool">⏺</span><span style="color: #cfe3e1">' + esc(step.text) + '</span>';
    } else if (step.kind === 'exit') {
      line.textContent = step.text;
    }
    termBody.appendChild(line);
  }

  function appendCursor() {
    if (termBody.querySelector('.hm-term-cursor')) return;
    const last = termBody.querySelector('.hm-term-line:last-child');
    if (!last) return;
    const c = document.createElement('span');
    c.className = 'hm-term-cursor';
    last.appendChild(c);
  }
  function removeCursor() {
    const c = termBody.querySelector('.hm-term-cursor');
    if (c) c.remove();
  }

  function playOnce() {
    clearPlayTimers();
    termBody.innerHTML = '';
    renderBanner();

    if (reducedMotion) {
      SCRIPT.forEach(s => appendLine(s));
      return;
    }

    SCRIPT.forEach((step, idx) => {
      const t = setTimeout(() => {
        removeCursor();
        appendLine(step);
        if (step.kind === 'exit') {
          loopTimer = setTimeout(() => {
            if (terminalOpen) playOnce();
          }, LOOP_PAUSE_MS);
        } else if (idx < SCRIPT.length - 1) {
          appendCursor();
        }
      }, step.delay);
      playTimers.push(t);
    });
  }

  function openTerminal() {
    if (terminalOpen) return;
    terminalOpen = true;
    activitySeconds = 1;
    setActivity('cooking 1s');
    term.setAttribute('aria-hidden', 'false');
    mock.classList.remove('is-side-open', 'is-preview-open');
    mock.classList.add('is-terminal-open');
    unpinPopover();
    playOnce();
  }

  function closeTerminal() {
    if (!terminalOpen) return;
    terminalOpen = false;
    activitySeconds = 1;
    setActivity('cooking 1s');
    term.setAttribute('aria-hidden', 'true');
    mock.classList.remove('is-terminal-open');
    clearPlayTimers();
  }

  // --- Wire interactions ---
  // CSS :hover and :focus-within reveal the popover on desktop. Tap on touch
  // pins it open via .is-pinned.
  pill.addEventListener('click', e => {
    e.stopPropagation();
    if (popoverPinned) unpinPopover(); else pinPopover();
  });
  pill.addEventListener('keydown', e => {
    if (e.key === 'Escape' && popoverPinned) { unpinPopover(); pill.blur(); }
  });

  // Hover-driven open/close across three zones — the popover row, the
  // "running" top session tile, and the terminal panel itself. Cursor crossing
  // between zones is forgiven by CLOSE_GRACE_MS so the panel doesn't flicker.
  function cancelGraceClose() {
    if (closeGraceTimer) { clearTimeout(closeGraceTimer); closeGraceTimer = null; }
  }
  function scheduleGraceClose() {
    cancelGraceClose();
    closeGraceTimer = setTimeout(() => {
      closeGraceTimer = null;
      closeTerminal();
    }, CLOSE_GRACE_MS);
  }

  row.addEventListener('mouseenter', () => { cancelGraceClose(); if (!terminalOpen) openTerminal(); });
  row.addEventListener('mouseleave', scheduleGraceClose);
  row.addEventListener('click', e => {
    e.stopPropagation();
    cancelGraceClose();
    if (!terminalOpen) openTerminal();
  });
  row.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cancelGraceClose(); openTerminal(); }
  });

  // Top session tile — same trigger as the popover row.
  const runningTile = mock.querySelector('.hm-tile-running');
  if (runningTile) {
    runningTile.addEventListener('mouseenter', () => { cancelGraceClose(); if (!terminalOpen) openTerminal(); });
    runningTile.addEventListener('mouseleave', scheduleGraceClose);
    runningTile.addEventListener('click', e => {
      e.stopPropagation();
      cancelGraceClose();
      if (!terminalOpen) openTerminal();
    });
    runningTile.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cancelGraceClose(); openTerminal(); }
    });
  }

  // Hovering the terminal itself keeps it open.
  term.addEventListener('mouseenter', cancelGraceClose);
  term.addEventListener('mouseleave', scheduleGraceClose);

  termClose.addEventListener('click', e => { e.stopPropagation(); cancelGraceClose(); closeTerminal(); });

  // Click-outside unpins the popover. Only matters for touch tap-pin.
  document.addEventListener('mousedown', e => {
    if (!popoverPinned) return;
    if (e.target.closest('.hm-rtp-wrap')) return;
    unpinPopover();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && popoverPinned) unpinPopover();
  });

  // The terminal panel shares its bottom footprint with the side and preview
  // panels — close the terminal when another overlay opens. The running tile
  // is excluded since clicking it is *how* you open the terminal.
  document.querySelectorAll('.hm-tile:not(.hm-tile-running), .hm-mem[data-memory], .hm-art-cell[data-artefact]').forEach(el => {
    el.addEventListener('click', () => {
      unpinPopover();
      if (terminalOpen) closeTerminal();
    });
  });

  // Kick the demo into life — the activity counter ticks even before any hover.
  startActivityTicker();
})();
