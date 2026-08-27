# Host permissions

## Why some sites are optional

FreeMiD is published on the Chrome Web Store. Adding a **required** host
permission to a published extension makes Chrome **disable it for every
existing user** until each of them manually re-approves the new permission
list. No error, no warning to the developer — installs simply go quiet and
support reports arrive later.

That cost is unreasonable for a per-site feature: someone who only uses TIDAL
should not have their extension disabled because SoundCloud support shipped.

So sites added after the initial release declare their host access as
**optional**, and the popup requests it the first time the user enables that
site's toggle. Nobody else is interrupted, and the granted permission set stays
honest about what is actually in use.

## How it is wired

| Piece | Responsibility |
| --- | --- |
| `activities/registry.ts` | `optionalPermission: true` on the activity |
| `public/manifest.json` | origins listed under `optional_host_permissions`, **not** `host_permissions` |
| `popup/helpers.ts` | `optionalOriginsFor(siteId)` reads the origins back off the registry |
| `popup/index.ts` | requests them from the toggle's click handler |
| `background/optionalSites.ts` | the starting toggle state, and which sites no longer hold their origins |
| `background/index.ts` | listens for `permissions.onRemoved` and applies the result |

The request origins come from the registry's own `matches`, so the permission
asked for and the URL pattern injected on cannot drift apart. There is a test
asserting the manifest agrees with the registry in both directions.

## The gesture constraint

`chrome.permissions.request()` requires a user gesture, and **any `await`
before it spends that gesture** — after which Chrome rejects the call outright,
with an error that reads as though the permission were denied.

So the request must be the first async boundary in the click handler:

```ts
btn.addEventListener('click', () => {
  const origins = nowEnabled ? optionalOriginsFor(siteId) : undefined;
  if (origins) {
    chrome.permissions.request({ origins }).then(...);   // no await before this
    return;
  }
  ...
});
```

Reading DOM state synchronously beforehand is fine. Reading `chrome.storage`,
awaiting a `sendMessage`, or checking `permissions.contains()` first is not.

## What the user sees

A site awaiting a grant renders as a **"Grant"** action rather than an off
switch, and reverts to an ordinary toggle once granted.

Without that it reads as a broken or beta feature — the row sits off while
every neighbour sits on, and clicking it raises a Chrome dialog the user had no
reason to expect. Naming the action makes the prompt something they asked for.

The grant state is read with `permissions.contains()` when the popup opens.
That is independent of the background status round-trip, since the answer lives
in Chrome rather than in the worker. An unreadable permission state is treated
as granted: showing a real toggle that does nothing is a smaller failure than
hiding a working site behind a prompt that never resolves.

The row also stops advertising itself as a switch while it is an action —
`role="button"` and no `aria-checked`, so assistive tech does not read "off"
for something that was never a switch. `setToggle()` skips these rows so the
render loop cannot relabel them back.

## Behaviour notes

- **Declining** leaves the toggle untouched. The visual state is driven by the
  background's status broadcast, so nothing needs reverting — the message is
  simply never sent.
- **Re-enabling** after a previous grant shows no prompt. `request()` resolves
  `true` immediately when the permission is already held.
- **Disabling the toggle does not revoke** the permission. The site toggle is a
  presence switch, not a permission manager, and silently revoking would make
  every re-enable prompt again. With the toggle off no injection happens
  regardless, so the retained grant goes unused.
- **Revoking from `chrome://extensions`** is handled: `permissions.onRemoved`
  turns the matching site toggle off. Without that the toggle would read as on
  while injection failed silently, which looks like a broken extension.
  The event is used only as a signal that *something* changed; which sites it
  leaves unusable is read back with `permissions.contains()`. Comparing against
  the origins the event carries would only work while a revoked origin is
  reported in exactly the form it was requested.
- **The same check runs at startup.** The listener only covers a revocation the
  worker is awake to see, and an MV3 worker is torn down constantly — an event
  missed once would leave a site enabled with nothing granted, which is the
  state the listener exists to prevent. Reconciling at boot makes "enabled
  implies granted" an invariant rather than a hope.

## Adding another optional site

1. `optionalPermission: true` on its registry entry
2. origins under `optional_host_permissions` in the manifest
3. default it to `false` in `DEFAULT_ENABLED_SITES`

All three are guarded. `popup/optionalPermissions.test.ts` fails if 1 and 2
disagree; `background/optionalSites.test.ts` fails if 3 is left on, which
would have the site attempt injection with nothing granted.
