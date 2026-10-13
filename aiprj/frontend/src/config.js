// Single source of truth for the Express backend URL. Set VITE_API_URL in
// .env to point this at a different host during the prototype demo.
//
// An explicitly empty VITE_API_URL (see .env) means "same origin as the
// page" -- requests go out as relative /api/... paths, which Vite's dev
// server proxy (see vite.config.js) then forwards to the backend. That's
// what lets a phone talk to just ONE HTTPS origin (5173) instead of
// needing to separately trust the backend's own self-signed cert on 5443.
// `??` (not `||`) is required here so that empty string is respected
// instead of falling through to the localhost default.
export const API_BASE_URL = import.meta.env.VITE_API_URL || '';
