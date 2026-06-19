# Static assets

Files in this folder are served at the web root by Vite.

## Brand logo

Save the product logo here as **`logo.png`** (a square image works best — it's
shown rounded in the header, login screen, and as the browser favicon):

    client/public/logo.png

Until that file exists, the app shows an on-brand gradient fallback mark, so
nothing looks broken. After adding/replacing `logo.png`, rebuild the client
(`npm run build`) — or just hard-refresh during `npm run dev`.
