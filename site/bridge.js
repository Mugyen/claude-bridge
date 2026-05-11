/* claude-bridge landing — animation script
 * No frameworks. SVG + requestAnimationFrame.
 * The choreography below tells a self-contained story that loops.
 */

(() => {
  'use strict';

  // ── 1. Text scramble on the "bridge" word ────────────────────────────────
  const scrambleEl = document.querySelector('[data-scramble]');
  if (scrambleEl) {
    const target = scrambleEl.textContent;
    const glyphs = '!<>-_\\/[]{}—=+*^?#________';
    let frame = 0;
    let queue = [];
    function scrambleTo(newText) {
      const length = Math.max(target.length, newText.length);
      queue = [];
      for (let i = 0; i < length; i++) {
        const from = scrambleEl.textContent[i] || '';
        const to = newText[i] || '';
        const start = Math.floor(Math.random() * 20);
        const end = start + Math.floor(Math.random() * 20);
        queue.push({ from, to, start, end, char: '' });
      }
      frame = 0;
      tick();
    }
    function tick() {
      let output = '';
      let complete = 0;
      for (let i = 0; i < queue.length; i++) {
        const q = queue[i];
        if (frame >= q.end) {
          complete++;
          output += q.to;
        } else if (frame >= q.start) {
          if (!q.char || Math.random() < 0.28) {
            q.char = glyphs[Math.floor(Math.random() * glyphs.length)];
          }
          output += q.char;
        } else {
          output += q.from;
        }
      }
      scrambleEl.textContent = output;
      if (complete < queue.length) {
        frame++;
        requestAnimationFrame(tick);
      }
    }
    const words = ['bridge', 'wire', 'thread', 'channel', 'bridge'];
    let idx = 0;
    setInterval(() => {
      idx = (idx + 1) % words.length;
      scrambleTo(words[idx]);
    }, 4200);
  }

  // ── 2. Copy install command ──────────────────────────────────────────────
  const copyBtn = document.querySelector('[data-copy]');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const text = copyBtn.getAttribute('data-copy') || '';
      const state = copyBtn.querySelector('.copy-state');
      try {
        await navigator.clipboard.writeText(text);
        if (state) state.textContent = '✓ copied';
      } catch (e) {
        if (state) state.textContent = '— copy failed';
      }
      setTimeout(() => { if (state) state.textContent = ''; }, 1800);
    });
  }

  // ── 3. The hero animation: messages travel along wires ──────────────────
  const svg = document.querySelector('.graph');
  if (!svg) return;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const packetsLayer = svg.querySelector('.packets');
  const transcript = document.getElementById('transcript');

  function wireFor(a, b) {
    const tryId = (x, y) => svg.querySelector(`#w-${x}${y}`);
    return tryId(a, b) || tryId(b, a);
  }
  function setNodeActive(id, mode) {
    const n = svg.querySelector(`.node[data-id="${id}"]`);
    if (!n) return;
    if (mode) n.setAttribute('data-active', mode);
    else n.removeAttribute('data-active');
  }
  function setWireHot(wire, hot) {
    if (!wire) return;
    if (hot) wire.setAttribute('data-hot', 'true');
    else wire.removeAttribute('data-hot');
  }

  const SCRIPT = [
    { kind: 'ask',   from: 'F', to: 'B', label: 'ask("/api shape?")' },
    { kind: 'reply', from: 'B', to: 'F', label: 'reply("POST /v1/x")' },
    { kind: 'ask',   from: 'B', to: 'D', label: 'ask("users schema?")' },
    { kind: 'reply', from: 'D', to: 'B', label: 'reply("id, email, ts")' },
    { kind: 'ask',   from: 'F', to: 'R', label: 'ask("a11y rule?")' },
    { kind: 'reply', from: 'R', to: 'F', label: 'reply("WCAG 2.2 AA")' },
    { kind: 'ask',   from: 'T', to: 'B', label: 'ask("test fixture?")' },
    { kind: 'reply', from: 'B', to: 'T', label: 'reply("see /fixtures")' },
    { kind: 'ask',   from: 'B', to: 'R', label: 'ask("rate limit?")' },
    { kind: 'reply', from: 'R', to: 'B', label: 'reply("60 req/min")' },
  ];

  const NODE_NAME = { F: 'frontend', B: 'backend', R: 'research', D: 'db', T: 'tests' };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function logTranscript(step) {
    if (!transcript) return;
    const isAsk = step.kind === 'ask';
    const li = document.createElement('li');
    li.appendChild(el('span', 'who', NODE_NAME[step.from]));
    li.appendChild(el('span', isAsk ? 'arrow' : 'reply-arrow', isAsk ? '→' : '←'));
    li.appendChild(el('span', 'who', NODE_NAME[step.to]));
    li.appendChild(document.createTextNode('  ' + step.label));
    transcript.prepend(li);
    while (transcript.children.length > 6) transcript.removeChild(transcript.lastChild);
  }

  function makePacket(label, kind) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', `packet ${kind}`);
    const text = document.createElementNS(SVG_NS, 'text');
    text.textContent = label;
    text.setAttribute('x', 0);
    text.setAttribute('y', 0);
    const rect = document.createElementNS(SVG_NS, 'rect');
    g.appendChild(rect);
    g.appendChild(text);
    packetsLayer.appendChild(g);

    const bb = text.getBBox();
    const padX = 8, padY = 4;
    rect.setAttribute('x', bb.x - padX);
    rect.setAttribute('y', bb.y - padY);
    rect.setAttribute('width', bb.width + padX * 2);
    rect.setAttribute('height', bb.height + padY * 2);
    rect.setAttribute('rx', 2);

    return g;
  }

  function animatePacket(step, onDone) {
    const wire = wireFor(step.from, step.to);
    if (!wire) { onDone(); return; }

    const dir = wire.id === `w-${step.from}${step.to}` ? 1 : -1;
    const total = wire.getTotalLength();
    const pkt = makePacket(step.label, step.kind);

    setWireHot(wire, true);
    setNodeActive(step.from, 'true');

    const duration = 1400;
    const start = performance.now();

    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const e = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
      const d = dir === 1 ? e * total : total - e * total;
      const p = wire.getPointAtLength(d);
      pkt.setAttribute('transform', `translate(${p.x} ${p.y})`);

      if (t > 0.55) setNodeActive(step.to, 'receive');

      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        pkt.style.transition = 'opacity .35s';
        pkt.style.opacity = '0';
        setTimeout(() => pkt.remove(), 380);
        setWireHot(wire, false);
        setNodeActive(step.from, null);
        setTimeout(() => setNodeActive(step.to, null), 350);
        onDone();
      }
    }
    requestAnimationFrame(frame);
  }

  let i = 0;
  function next() {
    const step = SCRIPT[i % SCRIPT.length];
    i++;
    logTranscript(step);
    animatePacket(step, () => {
      const gap = step.kind === 'reply' ? 650 : 320;
      setTimeout(next, gap);
    });
  }

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    SCRIPT.slice(0, 4).forEach(logTranscript);
    return;
  }

  setTimeout(next, 600);
})();
