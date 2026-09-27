# Deployment — astryss-api.acethekawaii.com

## 1. Push and let CI publish to GHCR

Push the release to `main`. GitHub Actions publishes both:

```text
ghcr.io/acethekawaii/astryss-backend:latest
ghcr.io/acethekawaii/astryss-backend:sha-<12-character-commit>
```

Wait for **Actions → Publish container image** to pass. Production uses `latest`; the immutable
SHA tag remains available for rollback.

## 2. Cloudflare DNS

In the `acethekawaii.com` zone, add the backend record:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `astryss-api` | `187.77.156.189` | **DNS only** |

Do not change the frontend's records.

## 3. VPS files

In Termius:

```bash
cd ~/docker-apps/astryss-api
nano compose.yaml   # paste compose.yaml from this repo
nano .env           # paste .env from this repo
chmod 600 .env
```

Set `REDIS_URL` to the connection string from Redis Cloud → Databases → Astryss → **Connect**.
If the database has a source-IP allowlist under **Security**, add the VPS IP. `MONGO_URI` stays
the existing Atlas connection string. Leave Cloudinary blank only if that feature is disabled.

## 4. Log in to GHCR

For a private package, use a GitHub token with `read:packages`:

```bash
docker login ghcr.io
```

Use your GitHub username and the token as the password.

## 5. Start it

```bash
cd ~/docker-apps/astryss-api
docker compose pull
docker compose up -d
docker compose logs --tail=100 api
```

## 6. Caddy

Add an `astryss-api.acethekawaii.com` block to the VPS Caddyfile:

```caddyfile
astryss-api.acethekawaii.com {
    encode zstd gzip
    reverse_proxy astryss-api:8000
}
```

Reload Caddy and test:

```bash
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
curl -i https://astryss-api.acethekawaii.com/api/v2
```

An HTTP `200` response means the backend is live. Test the frontend against it, then disable the
Railway backend.
