import { useProfile } from './profile.jsx';

// Client-side access gate for the ACTIVE client profile. Today it resolves
// role-based permissions (from /auth/me). It is deliberately shaped to carry a
// REASON, not just a boolean, so a future package/entitlement layer slots in
// here with no caller changes:
//   - role-denied  → hide the thing (not your job)
//   - package-denied → show it locked with an "Upgrade" upsell (future)
// The server is always the real boundary (403); this only drives presentation.
export function useAccess() {
  const { active, isAdmin, mode } = useProfile();
  const permissions = new Set(active?.permissions || []);
  const role = active?.role || (isAdmin && mode !== 'client' ? 'admin' : null);

  // can(permission) → boolean (admins always true).
  const can = (perm) => isAdmin || permissions.has(perm);

  // access(permission) → { allowed, reason } for nuanced UI. reason is 'ok' when
  // allowed; 'role' when blocked by role today. (Future: 'package'.)
  const access = (perm) => (can(perm) ? { allowed: true, reason: 'ok' } : { allowed: false, reason: 'role' });

  return { can, access, permissions, role, isAdmin };
}

// Permission keys — mirror server/roles.js so callers don't pass raw strings.
export const PERMS = {
  DASHBOARDS_VIEW: 'dashboards.view',
  CAMPAIGNS_VIEW: 'campaigns.view',
  CAMPAIGNS_APPROVE: 'campaigns.approve',
  DIGESTS_MANAGE: 'digests.manage',
  REPORTS_MANAGE: 'reports.manage',
  SETTLEMENTS_VIEW: 'settlements.view',
  SETTLEMENTS_MANAGE: 'settlements.manage',
  BRANDING_MANAGE: 'branding.manage',
  INTEGRATIONS_MANAGE: 'integrations.manage',
  TEAM_MANAGE: 'team.manage',
  EVENTOPS_MANAGE: 'eventops.manage',
};
