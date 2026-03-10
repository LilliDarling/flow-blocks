import type { CalendarProvider } from './types.js';

const providers = new Map<string, CalendarProvider>();

export function registerProvider(provider: CalendarProvider): void {
  providers.set(provider.id, provider);
}

export function getProvider(id: string): CalendarProvider | undefined {
  return providers.get(id);
}

export function getAllProviders(): CalendarProvider[] {
  return [...providers.values()];
}
