import type { BuiltinAccountClient, ProfileItem } from './hub-accounts.types';

function inferBuiltinClient(profile: ProfileItem): BuiltinAccountClient | undefined {
  if (profile.clientId) return profile.clientId;
  if (profile.oauthLikeClient === 'dare' || profile.oauthLikeClient === 'opencode') return profile.oauthLikeClient;
  const normalizedId = `${profile.id} ${profile.provider ?? ''} ${profile.displayName} ${profile.name}`.toLowerCase();
  if (normalizedId.includes('claude')) return 'anthropic';
  if (normalizedId.includes('codex')) return 'openai';
  if (normalizedId.includes('gemini')) return 'google';
  if (normalizedId.includes('kimi') || normalizedId.includes('moonshot')) return 'kimi';
  if (normalizedId.includes('dare')) return 'dare';
  if (normalizedId.includes('opencode')) return 'opencode';
  return undefined;
}

const BUILTIN_OAUTH_DEFAULTS: Array<{ id: string; clientId: BuiltinAccountClient; displayName: string }> = [
  { id: 'claude', clientId: 'anthropic', displayName: 'Claude (OAuth)' },
  { id: 'codex', clientId: 'openai', displayName: 'Codex (OAuth)' },
  { id: 'gemini', clientId: 'google', displayName: 'Gemini (OAuth)' },
  { id: 'kimi', clientId: 'kimi', displayName: 'Kimi (OAuth)' },
  { id: 'dare', clientId: 'dare', displayName: 'Dare (OAuth)' },
  { id: 'opencode', clientId: 'opencode', displayName: 'OpenCode (OAuth)' },
];

function synthesizeMissingBuiltinOAuth(profiles: ProfileItem[]): ProfileItem[] {
  const result = [...profiles];
  const existingBuiltins = new Set(profiles.filter((p) => p.builtin).map((p) => p.id));
  for (const def of BUILTIN_OAUTH_DEFAULTS) {
    if (existingBuiltins.has(def.id)) continue;
    result.push({
      id: def.id,
      displayName: def.displayName,
      name: def.displayName,
      authType: 'oauth',
      kind: 'builtin',
      builtin: true,
      mode: 'subscription',
      clientId: def.clientId,
      hasApiKey: false,
      createdAt: '',
      updatedAt: '',
    });
  }
  return result;
}

export function ensureBuiltinAccounts(profiles: ProfileItem[]): ProfileItem[] {
  return synthesizeMissingBuiltinOAuth(normalizeBuiltinClientIds(profiles));
}

export function normalizeBuiltinClientIds(profiles: ProfileItem[]): ProfileItem[] {
  return profiles.map((profile) => {
    if (!profile.builtin) return profile;
    const builtinClient = inferBuiltinClient(profile);
    return builtinClient ? { ...profile, clientId: builtinClient } : profile;
  });
}

export function builtinClientLabel(client?: BuiltinAccountClient): string {
  switch (client) {
    case 'anthropic':
      return 'Claude';
    case 'openai':
      return 'Codex';
    case 'google':
      return 'Gemini';
    case 'kimi':
      return 'Kimi';
    case 'dare':
      return 'Dare';
    case 'opencode':
      return 'OpenCode';
    default:
      return 'Builtin';
  }
}

export function accountTone(profile: ProfileItem): 'purple' | 'green' | 'orange' {
  if (profile.authType === 'oauth') return 'orange';
  if (profile.baseUrl?.toLowerCase().includes('google')) return 'green';
  return 'purple';
}

export function resolveAccountActionId(profile: ProfileItem): string {
  return profile.id;
}
