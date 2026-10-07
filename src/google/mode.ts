import { getEnv } from '@/lib/env';

export function getGoogleMode(): 'mock' | 'live' {
  return getEnv().GOOGLE_MODE;
}

export function isMock(): boolean {
  return getGoogleMode() === 'mock';
}
