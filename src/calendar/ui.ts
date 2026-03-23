import { state } from '../state.js';
import { $id } from '../utils.js';
import { getAllProviders } from './registry.js';
import { renderTimeline } from '../timeline.js';

export function initCalendarUI(): void {
  $id('calendarSettingsBtn').addEventListener('click', () => {
    const panel = $id('calPanel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    if (panel.style.display === 'block') renderCalendarPanel();
  });

  $id('calPanelClose').addEventListener('click', () => {
    $id('calPanel').style.display = 'none';
  });
}

export function renderCalendarPanel(): void {
  const connectionsEl = $id('calConnections');
  const connections = state.calendarConnections;

  if (connections.length === 0) {
    connectionsEl.innerHTML = `<p class="cal-empty">No calendars connected yet.</p>`;
  } else {
    connectionsEl.innerHTML = connections.map(c => `
      <div class="cal-connection${c._needsReconnect ? ' cal-connection--stale' : ''}">
        <div class="cal-connection-info">
          <span class="cal-provider-badge">${c.provider}</span>
          <span class="cal-connection-name">${c.display_name}</span>
          ${c._needsReconnect ? '<span class="cal-reconnect-badge">Reconnect needed</span>' : ''}
        </div>
        <button class="cal-disconnect-btn" data-conn-id="${c.id}">Disconnect</button>
      </div>
    `).join('');

    connectionsEl.querySelectorAll('.cal-disconnect-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const connId = (btn as HTMLElement).dataset.connId!;
        await state.removeCalendarConnection(connId);
        renderCalendarPanel();
        renderTimeline();
      });
    });
  }

  // Render "add provider" buttons — label reflects that multiple accounts are supported
  const providers = getAllProviders();
  const buttonsEl = $id('calProviderButtons');
  buttonsEl.innerHTML = providers.map(p => {
    const hasExisting = connections.some(c => c.provider === p.id);
    const label = hasExisting ? `+ Add another ${p.name} account` : `Connect ${p.name}`;
    return `<button class="cal-provider-btn" data-provider="${p.id}">${label}</button>`;
  }).join('');

  buttonsEl.querySelectorAll('.cal-provider-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const providerId = (btn as HTMLElement).dataset.provider!;
      const provider = providers.find(p => p.id === providerId);
      if (provider) provider.startAuth();
    });
  });
}
