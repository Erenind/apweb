// Chromium needs a single worker entry point. Load the shared classic scripts
// synchronously so the background listeners are registered before startup ends.
importScripts('shared/i18n.js', 'shared/ai.js', 'background.js')
