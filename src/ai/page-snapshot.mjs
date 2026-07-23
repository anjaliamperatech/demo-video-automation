/**
 * Reduces the live page down to a short, LLM-friendly list of the things a
 * person could see and interact with. This is what the AI planner uses
 * instead of a screenshot, since visible text/labels map directly onto the
 * "friendly" actions (clickText, fillLabel, ...) the runner already supports.
 */
export async function snapshotInteractiveElements(page, { max = 60 } = {}) {
  return page.evaluate(maxItems => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function labelFor(el) {
      if (el.labels && el.labels.length) return el.labels[0].textContent.trim();
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel.trim();
      const id = el.getAttribute('id');
      if (id) {
        const associated = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (associated) return associated.textContent.trim();
      }
      return null;
    }

    const items = [];

    document.querySelectorAll('button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"]').forEach(el => {
      if (items.length >= maxItems || !isVisible(el)) return;
      const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!text) return;
      items.push({ kind: 'clickable', text });
    });

    document.querySelectorAll('input, textarea').forEach(el => {
      if (items.length >= maxItems || !isVisible(el)) return;
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'checkbox', 'radio'].includes(type)) return;
      items.push({
        kind: 'field',
        type,
        label: labelFor(el),
        placeholder: el.getAttribute('placeholder') || null
      });
    });

    document.querySelectorAll('input[type="checkbox"], input[type="radio"]').forEach(el => {
      if (items.length >= maxItems || !isVisible(el)) return;
      const wrappingLabel = el.closest('label');
      const labelText = wrappingLabel?.innerText || labelFor(el) || '';
      const firstLine = labelText.split('\n').map(line => line.trim()).find(Boolean) || '';
      const text = firstLine.replace(/\s+/g, ' ').slice(0, 80);
      if (!text) return;
      items.push({ kind: 'checkbox', checked: el.checked, text });
    });

    document.querySelectorAll('select').forEach(el => {
      if (items.length >= maxItems || !isVisible(el)) return;
      items.push({
        kind: 'select',
        label: labelFor(el),
        options: Array.from(el.options).map(option => option.textContent.trim()).slice(0, 20)
      });
    });

    return items.slice(0, maxItems);
  }, max);
}
