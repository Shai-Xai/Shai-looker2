// Where each Owl-created action can be viewed in the Pulse app — one source of
// truth so the web chat and WhatsApp both link to the same place. Adding a new
// act-tool means adding one line here (and the link comes for free on both doors).
const VIEW_PATHS = {
  createAlert: '/alerts',
  createLiveUpdate: '/alerts?tab=live',
  createSegment: '/engage/segments',
  draftCampaign: '/engage/campaigns',
};

// The in-app path for an action kind (e.g. '/alerts'), or '' if unknown.
function actionViewPath(kind) { return VIEW_PATHS[kind] || ''; }

// An absolute URL to view the action, given the app's public base. Returns ''
// when the kind is unknown or no base is available (callers omit the link then).
function actionViewUrl(base, kind) {
  const path = actionViewPath(kind);
  const b = String(base || '').replace(/\/$/, '');
  return path && b ? `${b}${path}` : '';
}

module.exports = { VIEW_PATHS, actionViewPath, actionViewUrl };
