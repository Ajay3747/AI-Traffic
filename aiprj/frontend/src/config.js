// Single source of truth for the Express backend URL. Set VITE_API_URL in
// .env to point this at a different host during the prototype demo.
export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5001';
