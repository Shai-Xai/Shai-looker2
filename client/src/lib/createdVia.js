// Provenance labels for things created through an AI/external door
// (segments, campaigns, alerts). '' / unknown → no badge (hand-made in-app).
const VIA = {
  owl: { icon: '🦉', label: 'Owl' },
  whatsapp: { icon: '💬', label: 'WhatsApp' },
  claude: { icon: '✨', label: 'Claude' },
  chatgpt: { icon: '✨', label: 'ChatGPT' },
  api: { icon: '🔌', label: 'API' },
};
export function viaBadge(via) { return VIA[via] || null; }

// A ready-to-use chip style matching the existing source chips.
export const viaChipStyle = {
  fontSize: 10.5, fontWeight: 700, borderRadius: 980, padding: '2px 9px',
  background: 'rgba(124,58,237,0.12)', color: 'var(--brand, #7C3AED)', whiteSpace: 'nowrap',
};
