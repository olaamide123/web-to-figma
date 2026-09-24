'use strict';

/**
 * Multi-state capture.
 *
 * A page snapshot only ever contains one state. Tabs, accordions and disclosure
 * widgets keep their other panels in `display: none`, so nothing downstream can
 * see them — three quarters of a tab component is simply absent from the
 * capture. This drives the page instead: find the groups, click each option,
 * and serialise the panel each time.
 *
 * Discovery is ARIA-first because that is what the pattern is actually defined
 * by (role=tablist/tab/tabpanel, aria-expanded, aria-selected). Framework
 * attributes cover the common libraries that predate it, and the caller can
 * always pass explicit selectors for a hand-rolled widget.
 */

/** Returns the groups found on the page, without changing any state. */
async function discoverGroups(page, extraSelectors = []) {
  return page.evaluate((extra) => {
    const cssPath = (el) => {
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      let n = el;
      while (n && n.nodeType === 1 && parts.length < 6) {
        let seg = n.tagName.toLowerCase();
        if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
        const sibs = n.parentElement ? Array.from(n.parentElement.children).filter((c) => c.tagName === n.tagName) : [];
        if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
        parts.unshift(seg);
        n = n.parentElement;
      }
      return parts.join(' > ');
    };

    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };

    const groups = [];
    const seen = new Set();

    // --- ARIA tabs -------------------------------------------------------
    document.querySelectorAll('[role="tablist"]').forEach((list) => {
      const tabs = Array.from(list.querySelectorAll('[role="tab"]')).filter(visible);
      if (tabs.length < 2) return;
      const panels = tabs.map((t) => {
        const id = t.getAttribute('aria-controls');
        return id ? document.getElementById(id) : null;
      });
      // The container that holds every panel is what we serialise per state.
      let host = panels.find(Boolean) ? panels.find(Boolean).parentElement : list.parentElement;
      if (!host) return;
      groups.push({
        kind: 'tabs',
        label: (list.getAttribute('aria-label') || 'Tabs').slice(0, 40),
        hostSelector: cssPath(host),
        options: tabs.map((t, i) => ({
          selector: cssPath(t),
          label: (t.textContent || ('Tab ' + (i + 1))).replace(/\s+/g, ' ').trim().slice(0, 30) || ('Tab ' + (i + 1))
        }))
      });
      seen.add(list);
    });

    // --- framework tabs without ARIA -------------------------------------
    const FW = '[data-bs-toggle="tab"],[data-bs-toggle="pill"],[data-toggle="tab"],[data-tab],[data-tabs-target]';
    const fwTabs = Array.from(document.querySelectorAll(FW)).filter(visible);
    if (fwTabs.length >= 2) {
      const byParent = new Map();
      fwTabs.forEach((t) => {
        const p = t.parentElement;
        if (!p || seen.has(p)) return;
        if (!byParent.has(p)) byParent.set(p, []);
        byParent.get(p).push(t);
      });
      byParent.forEach((tabs, parent) => {
        if (tabs.length < 2) return;
        const host = parent.parentElement || parent;
        groups.push({
          kind: 'tabs',
          label: 'Tabs',
          hostSelector: cssPath(host),
          options: tabs.map((t, i) => ({
            selector: cssPath(t),
            label: (t.textContent || ('Tab ' + (i + 1))).replace(/\s+/g, ' ').trim().slice(0, 30) || ('Tab ' + (i + 1))
          }))
        });
      });
    }

    // --- accordions / disclosures ----------------------------------------
    const disclosures = Array.from(document.querySelectorAll('[aria-expanded]')).filter(visible);
    disclosures.slice(0, 6).forEach((d, i) => {
      const id = d.getAttribute('aria-controls');
      const panel = id ? document.getElementById(id) : null;
      const host = panel ? (panel.parentElement || panel) : d.parentElement;
      if (!host) return;
      groups.push({
        kind: 'disclosure',
        label: (d.textContent || ('Item ' + (i + 1))).replace(/\s+/g, ' ').trim().slice(0, 30) || ('Item ' + (i + 1)),
        hostSelector: cssPath(host),
        options: [
          { selector: cssPath(d), label: 'Collapsed', expect: 'false' },
          { selector: cssPath(d), label: 'Expanded', expect: 'true' }
        ]
      });
    });

    // --- caller-supplied ---------------------------------------------------
    (extra || []).forEach((sel, gi) => {
      const els = Array.from(document.querySelectorAll(sel)).filter(visible);
      if (els.length < 2) return;
      const host = els[0].parentElement ? (els[0].parentElement.parentElement || els[0].parentElement) : document.body;
      groups.push({
        kind: 'custom',
        label: 'Group ' + (gi + 1),
        hostSelector: cssPath(host),
        options: els.map((e, i) => ({
          selector: cssPath(e),
          label: (e.textContent || ('Option ' + (i + 1))).replace(/\s+/g, ' ').trim().slice(0, 30) || ('Option ' + (i + 1))
        }))
      });
    });

    return groups;
  }, extraSelectors);
}

/**
 * Click through every option in every group, serialising the host subtree each
 * time. Returns the states plus any extra asset URLs they pulled in.
 */
async function captureStates(page, { serializer, maxGroups = 6, maxOptions = 8, maxNodes = 12000, deadline = 0 } = {}, groups) {
  const states = [];
  const assets = new Set();
  const outOfTime = () => deadline > 0 && Date.now() > deadline;
  let truncated = false;

  for (const group of groups.slice(0, maxGroups)) {
    if (outOfTime()) { truncated = true; break; }
    const variants = [];

    for (const opt of group.options.slice(0, maxOptions)) {
      // Stop between options rather than mid-serialisation, so what we return
      // is always a whole variant.
      if (outOfTime()) { truncated = true; break; }
      try {
        const clicked = await page.evaluate((s) => {
          const el = document.querySelector(s.selector);
          if (!el) return false;
          // For a disclosure we only click when it is not already in the state
          // we want, otherwise we toggle away from it.
          if (s.expect !== undefined && el.getAttribute('aria-expanded') === s.expect) return true;
          el.click();
          return true;
        }, opt);
        if (!clicked) continue;

        await page.waitForTimeout(320); // let the panel swap and settle
        await page.evaluate(serializer);
        const sub = await page.evaluate(
          (o) => window.__W2F__.serialize({ maxNodes: o.maxNodes, rootSelector: o.rootSelector }),
          { maxNodes, rootSelector: group.hostSelector }
        );
        if (!sub || !sub.root) continue;

        (sub.assets || []).forEach((a) => assets.add(a));
        variants.push({ label: opt.label, root: sub.root, fonts: sub.fonts || [] });
      } catch (e) { /* a widget that refuses to switch just yields fewer variants */ }
    }

    if (variants.length >= 2) {
      states.push({ kind: group.kind, label: group.label, hostSelector: group.hostSelector, variants });
    }
  }

  return { states, assets: Array.from(assets), truncated };
}

module.exports = { discoverGroups, captureStates };
