// Zeichnet eine Stempelkarte. Genutzt vom Karten-Editor, der Gast-Ansicht und der Kasse.
// Texte des Betriebs werden nur als textContent gesetzt, nie als HTML.
(() => {
  'use strict';

  const t = (texts) => (window.I18N ? window.I18N.t(texts) : texts.de);
  const INKS = ['tinte', 'blau', 'gruen', 'koralle'];

  const GIFT =
    '<svg class="gift" viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"><rect x="8" y="19" width="32" height="21" rx="2"/><rect x="6" y="13" width="36" height="7" rx="2"/><path d="M24 13v27"/><path d="M24 13c-2-6-9-7-9-3s6 3 9 3zm0 0c2-6 9-7 9-3s-6 3-9 3z"/></svg>';

  function stamp(i, isNew) {
    const rot = ((i * 47) % 30) - 15;
    return (
      `<svg class="stamp${isNew ? ' new' : ''}" viewBox="0 0 48 48" style="--rot:${rot}deg" aria-hidden="true">` +
      '<circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" stroke-width="2.5"/>' +
      '<circle cx="24" cy="24" r="16.5" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2.4"/>' +
      '<path d="M24 12l3.6 7.4 8.1 1.1-5.9 5.7 1.4 8.1L24 30.4l-7.2 3.9 1.4-8.1-5.9-5.7 8.1-1.1z" fill="currentColor"/></svg>'
    );
  }

  /** Spaltenzahl, bei der die letzte Reihe möglichst voll ist. */
  function columns(length) {
    let best = 5;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const c of [5, 4, 6, 3]) {
      const gap = length % c === 0 ? 0 : c - (length % c);
      if (gap < bestGap) {
        best = c;
        bestGap = gap;
      }
    }
    return best;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * card: { name, earnRule, ink, rewards: [{ threshold, text, claimed? }], stamps?, freshFrom? }
   * opts: { status: true } zeigt die Zeile „Noch 2 Stempel bis …“
   */
  function render(card, opts = {}) {
    const rewards = [...card.rewards].sort((a, b) => a.threshold - b.threshold);
    const length = rewards.length ? Math.max(...rewards.map((r) => r.threshold)) : 10;
    const stamps = card.stamps ?? 0;
    const root = el('div', 'card');
    root.style.setProperty('--stamp', `var(--ink-${INKS.includes(card.ink) ? card.ink : 'tinte'})`);

    const head = el('div', 'card-head');
    head.appendChild(el('h2', 'card-name', card.name || t({ de: 'Deine Karte', en: 'Your card' })));
    if (card.earnRule) {
      head.appendChild(
        el('p', 'card-earn', t({ de: `Einen Stempel gibt es für ${card.earnRule}.`, en: `One stamp for ${card.earnRule}.` })),
      );
    }
    root.appendChild(head);

    const slots = el('ol', 'slots');
    const cols = columns(length);
    slots.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    slots.style.maxWidth = `${cols * 104}px`;
    slots.setAttribute('aria-label', t({ de: `${stamps} von ${length} Stempeln`, en: `${stamps} of ${length} stamps` }));
    const rewardAt = new Set(rewards.map((r) => r.threshold));
    let html = '';
    for (let i = 0; i < length; i++) {
      const on = i < stamps;
      const isReward = rewardAt.has(i + 1);
      const inner = on ? stamp(i, i >= (card.freshFrom ?? Number.POSITIVE_INFINITY)) : isReward ? GIFT : `<span class="n">${i + 1}</span>`;
      html += `<li class="slot${isReward ? ' reward' : ''}${on ? ' on' : ''}">${inner}</li>`;
    }
    slots.innerHTML = html; // nur Zahlen und feste Grafiken, kein Text des Betriebs
    root.appendChild(slots);

    const legend = el('ul', 'legend');
    for (const r of rewards) {
      const free = r.threshold <= stamps && !r.claimed;
      const li = el('li', r.claimed ? 'done' : free ? 'free' : '');
      li.appendChild(el('span', 'at', t({ de: `${r.threshold} Stempel`, en: `${r.threshold} ${r.threshold === 1 ? 'stamp' : 'stamps'}` })));
      li.appendChild(el('span', 'txt', r.text));
      li.appendChild(
        el('span', r.claimed ? 'st pressed' : 'st', r.claimed ? t({ de: 'eingelöst', en: 'redeemed' }) : free ? t({ de: 'frei', en: 'ready' }) : ''),
      );
      legend.appendChild(li);
    }
    root.appendChild(legend);

    if (opts.status && rewards.length) {
      const status = el('p', 'card-status');
      const ready = rewards.filter((r) => r.threshold <= stamps && !r.claimed);
      const next = rewards.find((r) => r.threshold > stamps);
      if (ready.length) {
        status.classList.add('free');
        status.appendChild(el('strong', null, t({ de: 'Prämie bereit: ', en: 'Reward ready: ' })));
        status.appendChild(document.createTextNode(ready.map((r) => r.text).join(', ')));
      } else if (next) {
        const left = next.threshold - stamps;
        status.appendChild(el('strong', null, t({ de: `Noch ${left} Stempel`, en: `${left} more ${left === 1 ? 'stamp' : 'stamps'}` })));
        status.appendChild(document.createTextNode(t({ de: ` bis ${next.text}.`, en: ` until ${next.text}.` })));
      }
      root.appendChild(status);
    }
    return root;
  }

  window.StampCard = { render, INKS };
})();
