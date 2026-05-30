const CLIENT_ID = 'DISCORD_CLIENT_ID_REMOVED';
const HEADLESS_URL = 'https://discord.com/api/v10/users/@me/headless-sessions';
const log = document.getElementById('log');

function write(cls, msg) {
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = msg + '\n';
  log.appendChild(span);
}

const redirectURL = chrome.identity.getRedirectURL();
document.getElementById('redirectUrl').textContent = redirectURL;

document.getElementById('testBtn').addEventListener('click', async () => {
  const btn = document.getElementById('testBtn');
  btn.disabled = true;
  log.innerHTML = '';

  write('info', `Redirect URL: ${redirectURL}`);
  write('info', 'Launching Discord OAuth2 consent screen…\n');

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'token',
    redirect_uri: redirectURL,
    scope: 'activities.write identify',
    prompt: 'consent',
  });
  const authURL = `https://discord.com/oauth2/authorize?${params}`;

  let responseURL;
  try {
    responseURL = await chrome.identity.launchWebAuthFlow({ url: authURL, interactive: true });
  } catch (e) {
    write('err', `OAuth flow failed: ${e.message}`);
    write('warn', 'This usually means:\n  • The redirect URI was not registered in the Discord Developer Portal\n  • The user cancelled\n  • The extension ID changed (reload the extension and check the URL above)');
    btn.disabled = false;
    return;
  }

  const parsed = new URL(responseURL);
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  const query = new URLSearchParams(parsed.search);

  // Show raw keys AND values so we can read the error
  write('info', `  hash:  ${parsed.hash || '(empty)'}`);
  write('info', `  query: ${parsed.search || '(empty)'}`);

  // If Discord returned an error, surface it immediately
  const oauthError = fragment.get('error') ?? query.get('error');
  const oauthErrorDesc = fragment.get('error_description') ?? query.get('error_description');
  if (oauthError) {
    write('err', `\n✗ Discord OAuth error: ${oauthError}`);
    write('err', `  ${decodeURIComponent(oauthErrorDesc ?? '')}`);
    btn.disabled = false;
    return;
  }

  const accessToken = fragment.get('access_token') ?? null;
  const authCode = query.get('code') ?? null;
  const grantedScope = fragment.get('scope') ?? query.get('scope') ?? '';
  const tokenType = fragment.get('token_type') ?? query.get('token_type');
  const expiresIn = fragment.get('expires_in') ?? query.get('expires_in');

  if (authCode) {
    write('warn', `\n⚠ Discord returned an authorization CODE, not a token.\n  This means response_type=token (implicit) was rejected.\n  Auth-code exchange requires a client_secret which can't live in an extension.\n  This approach won't work without a backend server.\n`);
  }

  write('ok', '✓ OAuth flow completed');
  write('info', `  flow type:  ${accessToken ? 'implicit (token in hash)' : authCode ? 'auth-code (code in query)' : 'unknown'}`);
  write('info', `  token_type: ${tokenType}`);
  write('info', `  expires_in: ${expiresIn}s (~${Math.round(Number(expiresIn) / 3600)}h)`);
  write('info', `  scope granted: ${grantedScope}`);

  const hasActivitiesWrite = grantedScope.split(/\s+/).includes('activities.write');
  if (hasActivitiesWrite) {
    write('ok', '\n✓ activities.write was GRANTED — Discord approved the scope!\n');
  } else {
    write('err', '\n✗ activities.write was NOT granted — Discord refused or silently dropped it.\n');
    write('warn', 'The headless-sessions endpoint test will likely fail. Continuing anyway…\n');
  }

  write('info', 'Testing POST /users/@me/headless-sessions…');

  if (!accessToken) {
    write('err', '✗ No access token available — cannot test the endpoint.');
    write('warn', '  If Discord returned an auth code above, implicit flow was rejected.');
    btn.disabled = false;
    return;
  }
  const testActivity = {
    activities: [{
      application_id: CLIENT_ID,
      name: 'FreeMiD Test',
      type: 2,
      details: 'OAuth2 smoke test',
      state: 'Testing headless sessions',
      platform: 'desktop',
    }],
  };

  let res;
  try {
    res = await fetch(HEADLESS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(testActivity),
    });
  } catch (e) {
    write('err', `Fetch failed: ${e.message}`);
    btn.disabled = false;
    return;
  }

  const status = res.status;
  let body;
  try { body = await res.json(); } catch { body = await res.text().catch(() => '(no body)'); }

  if (status >= 200 && status < 300) {
    write('ok', `✓ ${status} — Endpoint accepted the request!`);
    write('ok', `  Response: ${JSON.stringify(body, null, 2)}`);
    write('ok', '\n🎉 EVERYTHING WORKS. Extension-only presence is confirmed possible.');
  } else {
    write('err', `✗ ${status} — ${JSON.stringify(body)}`);
    if (status === 401) write('warn', '  → 401 Unauthorized: token issue or scope not actually active');
    if (status === 403) write('warn', '  → 403 Forbidden: endpoint exists but app not approved for it');
    if (status === 404) write('err', '  → 404: endpoint does not exist on this Discord build');
    if (status === 400) write('warn', '  → 400: endpoint exists but our activity payload format is wrong');
  }

  btn.disabled = false;
});
