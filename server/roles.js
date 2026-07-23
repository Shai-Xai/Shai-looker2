// ─── Roles & permissions (catalog) ───────────────────────────────────────────
// The single source of truth for what client-side roles exist and what each can
// do. Roles are NAMED BUNDLES of atomic permissions — enforcement code always
// checks a permission key, never a role name, so adding/retuning a role never
// touches the gates. The client-side role lives on the membership
// (user_entities.role), so one person can hold different roles at different
// clients. Howler admins (users.role==='admin') bypass all of this with full
// access.
//
// Fixed catalog for now; can later become per-client-customisable on the same
// foundation (resolve role→permissions from a per-client override table).

// Atomic permissions. Group by area for readability; the strings are the gates.
const PERMISSIONS = {
  DASHBOARDS_VIEW: 'dashboards.view',        // see dashboards at all (scoped further by visibility)
  CAMPAIGNS_VIEW: 'campaigns.view',          // see the Actions area + campaign reports
  CAMPAIGNS_APPROVE: 'campaigns.approve',    // create/approve/send campaigns
  GOALS_MANAGE: 'goals.manage',              // set/edit event goals + targets (Results)
  ALERTS_MANAGE: 'alerts.manage',            // create/edit metric alerts (threshold/low-stock/sold-out)
  DIGESTS_MANAGE: 'digests.manage',          // create/edit scheduled digests
  SETTLEMENTS_VIEW: 'settlements.view',      // see settlements + documents
  SETTLEMENTS_MANAGE: 'settlements.manage',  // (reserved) edit settlement notes etc.
  BRANDING_MANAGE: 'branding.manage',        // edit branding / colours / logo
  INTEGRATIONS_MANAGE: 'integrations.manage',// edit Looker/Anthropic + CC-the-Owl
  TEAM_MANAGE: 'team.manage',                // manage this client's own logins + roles
  EVENTOPS_MANAGE: 'eventops.manage',        // operate Event Ops — devices, stations, scans, issues
  MODERATION_MANAGE: 'moderation.manage',    // social moderation: banned lists + review queue (MODERATION_CONTRACT.md)
  MAP_MANAGE: 'map.manage',                  // build & publish the event map (Map Studio)
};
const ALL = Object.values(PERMISSIONS);
const P = PERMISSIONS;

// The fixed role catalog. `lens` ties a role to a briefing/digest focus for
// personalization (reuses the existing digest lenses). Order = display order.
const ROLES = [
  {
    key: 'owner', label: 'Owner', lens: 'exec',
    description: 'Full access to this client - dashboards, campaigns, settlements, branding, integrations and the team.',
    permissions: ALL,
  },
  {
    key: 'manager', label: 'Manager', lens: 'exec',
    description: 'All dashboards, digests and campaigns. No branding, integrations or team management.',
    permissions: [P.DASHBOARDS_VIEW, P.CAMPAIGNS_VIEW, P.CAMPAIGNS_APPROVE, P.GOALS_MANAGE, P.ALERTS_MANAGE, P.DIGESTS_MANAGE, P.SETTLEMENTS_VIEW, P.EVENTOPS_MANAGE, P.MODERATION_MANAGE, P.MAP_MANAGE],
  },
  {
    key: 'marketing', label: 'Marketing', lens: 'marketing',
    description: 'Marketing & ticketing dashboards and campaigns, with a marketing briefing focus.',
    permissions: [P.DASHBOARDS_VIEW, P.CAMPAIGNS_VIEW, P.CAMPAIGNS_APPROVE, P.GOALS_MANAGE, P.ALERTS_MANAGE, P.DIGESTS_MANAGE, P.MAP_MANAGE],
  },
  {
    key: 'finance', label: 'Finance', lens: 'finance',
    description: 'Finance, revenue & settlement dashboards, with a finance briefing focus. No campaigns.',
    permissions: [P.DASHBOARDS_VIEW, P.SETTLEMENTS_VIEW, P.SETTLEMENTS_MANAGE, P.GOALS_MANAGE, P.ALERTS_MANAGE, P.DIGESTS_MANAGE],
  },
  {
    key: 'viewer', label: 'Viewer', lens: 'exec',
    description: 'Read-only access to the dashboards they’re given. No campaigns, settings or team.',
    permissions: [P.DASHBOARDS_VIEW],
  },
  {
    key: 'ops', label: 'Event Ops', lens: 'exec',
    description: 'On-the-ground event operations ONLY - devices, stations, staff, issues & checkpoints. No dashboards, campaigns or settings.',
    permissions: [P.EVENTOPS_MANAGE, P.MAP_MANAGE],
  },
  {
    key: 'moderator', label: 'Moderator', lens: 'exec',
    description: 'Community trust & safety ONLY - this client\'s banned lists and the review queue for its communities and chat channels. No dashboards, campaigns or settings.',
    permissions: [P.MODERATION_MANAGE],
  },
];

const ROLE_KEYS = ROLES.map((r) => r.key);
const DEFAULT_ROLE = 'owner';               // safe non-breaking default for existing/new memberships

// ─── Super Admin (global designation) ─────────────────────────────────────────
// Not a per-client role — a GLOBAL tag carried in users.roles (the same array as
// 'dev'/'portal'). It gates the highest-risk platform controls (global campaign
// billing, integrations, status notices, backup/restore) to a small trusted set
// of Howler staff. Only a Howler admin (users.role==='admin') can BE a super
// admin; a client login carrying the tag is not one. Enforcement always checks
// isSuperAdmin(), never a role name — see auth.requireSuperAdmin.
const SUPER_ADMIN = 'super_admin';
function isSuperAdmin(user) {
  return !!(user && user.role === 'admin' && (user.roles || []).includes(SUPER_ADMIN));
}

// ─── Platform moderator (global designation) ──────────────────────────────────
// Same mechanic as SUPER_ADMIN: a global tag in users.roles, valid only on a
// Howler admin login. Gates WRITES on the platform moderation surface (the
// platform-wide banned lists + platform review queue — MODERATION_CONTRACT.md
// §10); any Howler admin can view.
const PLATFORM_MODERATOR = 'platform_moderator';
function isPlatformModerator(user) {
  return !!(user && user.role === 'admin' && (user.roles || []).includes(PLATFORM_MODERATOR));
}

// Howler-staff job titles — the kind of support a client deals with. Only applies
// to admin (Howler) logins; shown when creating an admin and surfaced to clients
// as their "Howler Support" contact.
const HOWLER_ROLES = [
  { key: 'senior_kam', label: 'Senior Key Account Manager' },
  { key: 'kam', label: 'Key Account Manager' },
  { key: 'am', label: 'Account Manager' },
  { key: 'support', label: 'Support' },
];
const HOWLER_ROLE_KEYS = HOWLER_ROLES.map((r) => r.key);
function howlerRoleLabel(key) { return (HOWLER_ROLES.find((r) => r.key === key) || {}).label || ''; }
const byKey = Object.fromEntries(ROLES.map((r) => [r.key, r]));

function getRole(key) { return byKey[key] || byKey[DEFAULT_ROLE]; }
function permissionsForRole(key) { return new Set(getRole(key).permissions); }
function lensForRole(key) { return getRole(key).lens || 'exec'; }
// Public catalog (no internals) for the admin UI.
function catalog() { return ROLES.map((r) => ({ key: r.key, label: r.label, description: r.description, lens: r.lens, permissions: r.permissions })); }

module.exports = { PERMISSIONS, ROLES, ROLE_KEYS, DEFAULT_ROLE, getRole, permissionsForRole, lensForRole, catalog, HOWLER_ROLES, HOWLER_ROLE_KEYS, howlerRoleLabel, SUPER_ADMIN, isSuperAdmin, PLATFORM_MODERATOR, isPlatformModerator };
