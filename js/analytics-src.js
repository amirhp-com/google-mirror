/**
 * Vercel Web Analytics Initialization (Source)
 * 
 * This file initializes Vercel Web Analytics for the application.
 * The inject() function automatically tracks page views and provides
 * real-time traffic insights.
 * 
 * This file gets bundled by esbuild into analytics.bundle.js
 */
import { inject } from '@vercel/analytics';

// Initialize Vercel Analytics
// - Auto mode: automatically detects the environment
// - In production: sends events to Vercel Analytics
// - In development: logs events to console
inject({
  mode: 'auto',
  debug: true
});
