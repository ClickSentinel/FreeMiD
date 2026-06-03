# Asset Inventory

## Extension branding icons

These files are packaged with the Chrome extension and are used by the manifest, toolbar icon, and notification UI.

- `extension/public/icons/icon16.png`
- `extension/public/icons/icon48.png`
- `extension/public/icons/icon128.png`
- `extension/public/icons/icon128-cws.png`

## Discord Rich Presence assets

These are uploaded in the Discord Developer Portal for the FreeMiD application and referenced by asset key in presence payloads.

- `youtube-logo-1024` - YouTube service icon
- `ytmusic-logo-1024` - YouTube Music service icon
- `tidal-logo-1024` - TIDAL service icon

## Extension-local preview assets

These PNGs ship with the extension and are used by the popup service-logo preview.

- `extension/public/icons/youtube-logo-1024.png`
- `extension/public/icons/ytmusic-logo-1024.png`
- `extension/public/icons/tidal-logo-1024.png`

## Notes

- Keep Discord presence asset keys stable once published.
- Chrome Web Store packaging is unaffected by these keys because release artifacts are built from `extension/dist` in `.github/workflows/release.yml`.
