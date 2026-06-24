# FreeMiD Roadmap

## Uninstall

Uninstall runs through the standard Windows **Apps & Features** entry — the ARP
`UninstallString` invokes `freemid-setup.exe --uninstall --silent`. This is the
intended path; there is deliberately **no** in-app / GUI uninstall flow.

The uninstaller removes the binary, native-messaging manifest, registry keys,
logs, and the install directory itself (the running `freemid-setup.exe` deletes
itself via a deferred `cmd.exe` cleanup after the process exits).

Remaining: smoke-test the uninstall across the browser matrix (Chrome, Chromium,
Brave, Edge, Vivaldi).
