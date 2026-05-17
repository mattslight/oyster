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

  // Hover (desktop) renders content into the side panel transiently — CSS handles the reveal.
  // Click (any device) pins the panel open: renders content AND adds .is-side-open to the mock,
  // so taps on touch devices work and desktop users can "pin" a session for closer reading.
  function clearActive() {
    mock.querySelectorAll('.hm-tile.is-active, .hm-mem.is-active').forEach(el => el.classList.remove('is-active'));
  }
  function pinSession(tile) {
    clearActive();
    tile.classList.add('is-active');
    renderSession(tile.dataset.session);
    mock.classList.add('is-side-open');
  }
  function pinMemory(mem) {
    clearActive();
    mem.classList.add('is-active');
    renderMemory(mem.dataset.memory);
    mock.classList.add('is-side-open');
  }
  function closeSide() {
    mock.classList.remove('is-side-open');
    clearActive();
  }

  // Hover is the transient "peek" — but stop swapping content once the user has pinned a panel,
  // otherwise the active highlight on one tile would mismatch the content showing for another.
  document.querySelectorAll('.hm-tile').forEach(tile => {
    tile.addEventListener('mouseenter', () => {
      if (mock.classList.contains('is-side-open')) return;
      renderSession(tile.dataset.session);
    });
    tile.addEventListener('click', e => { e.stopPropagation(); pinSession(tile); });
  });
  document.querySelectorAll('.hm-mem[data-memory]').forEach(mem => {
    mem.addEventListener('mouseenter', () => {
      if (mock.classList.contains('is-side-open')) return;
      renderMemory(mem.dataset.memory);
    });
    mem.addEventListener('click', e => { e.stopPropagation(); pinMemory(mem); });
  });

  const sideBack = document.getElementById('hm-side-back');
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
          <li class="done"><span class="pv-chk done">✓</span>Pricing page live</li>
          <li class="done"><span class="pv-chk done">✓</span>Hero mock approved</li>
          <li class="done"><span class="pv-chk done">✓</span>0.5.0-beta.1 published</li>
          <li><span class="pv-chk"></span>Beta to Henry</li>
          <li><span class="pv-chk"></span>Reddit announcement</li>
          <li><span class="pv-chk"></span>HN post</li>
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
    mock.querySelectorAll('.hm-art-cell.is-active').forEach(el => el.classList.remove('is-active'));
    cell.classList.add('is-active');
    renderArtefact(cell);
    mock.classList.add('is-preview-open');
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
  if (previewClose) previewClose.addEventListener('click', e => {
    e.stopPropagation();
    mock.classList.remove('is-preview-open');
    mock.querySelectorAll('.hm-art-cell.is-active').forEach(el => el.classList.remove('is-active'));
  });

  // Interactive preview content — event delegation so handlers survive content swaps.
  previewBody.addEventListener('click', e => {
    e.stopPropagation();
    const li = e.target.closest('.pv-list li');
    if (li) {
      const chk = li.querySelector('.pv-chk');
      const nowDone = li.classList.toggle('done');
      if (chk) {
        chk.classList.toggle('done', nowDone);
        chk.textContent = nowDone ? '✓' : '';
      }
      return;
    }
    const toggle = e.target.closest('.pv-toggle');
    if (toggle) {
      const nowOn = toggle.classList.toggle('on');
      toggle.setAttribute('aria-checked', nowOn ? 'true' : 'false');
      return;
    }
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
})();
