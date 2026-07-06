# grid.ponslink.com Secrets, Security Headers, and Release Checklist

## Secrets inventory

| Secret | Scope | Storage | Rotation | Redaction requirement |
|---|---|---|---|---|
| `PONSWARP_MESH_DATABASE_URL` | coordinator DB access | `/etc/ponswarp/grid.ponslink.env`, mode 0600 | rotate DB user password and restart coordinator | never log full URL; redact password |
| `PONSWARP_MESH_ADMIN_API_TOKEN` | admin/internal API | server-only env file | rotate immediately after operator change or suspected leak | never log raw token |
| `PONSWARP_NODE_TOKEN_PEPPER` | node token hash pepper | server-only env file | rotate with node token reissue plan | never expose in audit/client errors |
| `PONSWARP_TURN_STATIC_AUTH_SECRET` | TURN credential issuer | server-only env file | rotate with overlap window shorter than credential TTL | never log raw secret or generated credential |
| `PONSWARP_BUILD_SHA` | release metadata | env/build pipeline | every deploy | safe to expose |

## File permissions

```sh
sudo install -o root -g ponswarp -m 0640 grid.ponslink.env /etc/ponswarp/grid.ponslink.env
```

Private beta accepts `0640` when the coordinator runs as group `ponswarp`; use `0600` if systemd can read via root-managed credentials.

## Required web headers

The reverse proxy template must set:

- `Strict-Transport-Security`
- `Content-Security-Policy`
- `X-Content-Type-Options`
- `Referrer-Policy`
- `Permissions-Policy`
- `Cross-Origin-Opener-Policy`

`/assets/*` must be immutable-cacheable. `/`, `/index.html`, and `/version.json` must be no-cache.

## Release metadata

Every web build should expose `version.json` with:

```json
{
  "name": "ponswarp-grid",
  "version": "0.1.0",
  "commitSha": "<git sha or dev>",
  "coordinator": "https://grid.ponslink.com",
  "generatedAt": "<iso timestamp>"
}
```

## CLI/coordinator compatibility

CLI default coordinator and web release metadata must both point to `https://grid.ponslink.com`. CLI coordinator requests must use `/api/grid/v1/*`, matching the reverse proxy.
