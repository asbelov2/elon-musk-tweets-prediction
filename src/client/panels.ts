const storageKey = 'tweetscope:collapsed-panels:v1';

export function initializePanels() {
  let collapsed: Record<string, boolean> = {};
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved))
      for (const [key, value] of Object.entries(saved))
        if (typeof value === 'boolean') collapsed[key] = value;
  } catch {
    /* Storage may be unavailable in private browsing. */
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-panel]')) {
    const id = panel.dataset.panel!;
    const title = panel.querySelector('h2');
    if (!title) continue;
    let header = panel.querySelector<HTMLElement>(
      ':scope > .section-heading, :scope > .chart-heading, :scope > .activity-heading, :scope > .budget-heading',
    );
    if (!header) {
      header = document.createElement('div');
      panel.prepend(header);
      header.append(title);
    }
    header.classList.add('panel-heading');
    const content = document.createElement('div');
    content.id = `panel-${id}-content`;
    content.className = 'panel-content';
    for (const child of [...panel.childNodes]) if (child !== header) content.append(child);
    panel.append(content);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'panel-toggle';
    button.setAttribute('aria-controls', content.id);
    function update() {
      const isCollapsed = collapsed[id] === true;
      content.hidden = isCollapsed;
      panel.classList.toggle('is-collapsed', isCollapsed);
      button.textContent = isCollapsed ? '⌄' : '⌃';
      button.setAttribute('aria-expanded', String(!isCollapsed));
      button.setAttribute(
        'aria-label',
        `${isCollapsed ? 'Развернуть' : 'Свернуть'} блок: ${title!.textContent}`,
      );
      button.title = isCollapsed ? 'Развернуть блок' : 'Свернуть блок';
    }
    button.addEventListener('click', () => {
      collapsed[id] = !collapsed[id];
      update();
      try {
        localStorage.setItem(storageKey, JSON.stringify(collapsed));
      } catch {
        /* Optional preference. */
      }
    });
    header.append(button);
    update();
  }
}
