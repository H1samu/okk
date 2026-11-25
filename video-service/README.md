# Hismar Check — private Google Drive video streaming

Cloud Run proxy for the Hismar Check training video. The MP4 remains private in Google Drive. The browser receives a short-lived signed playback ticket after the existing Hismar Apps Script `verify` endpoint accepts the employee's session token.

## Security model

- The Drive file ID is configured on the server; clients cannot choose arbitrary Drive files.
- The Cloud Run runtime service account has Viewer access to the one MP4 only.
- No service-account JSON key is used. Cloud Run Application Default Credentials are used at runtime.
- The Hismar token is sent only in the POST body to `/api/playback-ticket`, then verified server-to-server against the existing Apps Script `verify` action. It is never put in a URL or sent to Google Drive.
- The response contains a signed HMAC ticket with a 30-minute lifetime. The ticket grants access only to the configured video.
- `GET /stream` and `HEAD /stream` require a valid ticket.
- The proxy forwards one HTTP byte range to Drive and preserves `206`, `Content-Range`, and `Content-Length`. Google Drive supports partial downloads for binary/blob files using the `Range` header.
- CORS is restricted to the Hismar website origin. CORS is an additional browser restriction, not the authentication mechanism.
- The video response uses `Cache-Control: private, no-store`.

A signed playback URL is a short-lived bearer capability. Anyone who obtains it can use it until it expires, so keep the TTL short and do not log tickets in application logs. The Hismar session token itself is never included in the stream URL.

## Requirements

- A Google Cloud project with billing enabled.
- Google Drive API enabled.
- `gcloud` CLI authenticated with permission to deploy Cloud Run and create service accounts/secrets.
- The Drive video shared as **Viewer** with the Cloud Run runtime service-account email. Do not enable "Anyone with the link".
- The Cloud Run runtime service account needs Secret Manager Secret Accessor on the signing secret.

## Deploy

Run these commands from this directory in Cloud Shell or a terminal with `gcloud` configured. Replace `PROJECT_ID`, `REGION`, and `APP_ORIGIN` with the values for your deployment.

```bash
gcloud config set project PROJECT_ID

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  drive.googleapis.com \
  secretmanager.googleapis.com

gcloud iam service-accounts create hismar-video-reader \
  --display-name="Hismar private video reader"

export VIDEO_SA="hismar-video-reader@PROJECT_ID.iam.gserviceaccount.com"

# Create a strong signing secret and store it in Secret Manager.
openssl rand -base64 48 | tr -d '\n' | \
  gcloud secrets create hismar-video-signing-secret --data-file=-

gcloud secrets add-iam-policy-binding hismar-video-signing-secret \
  --member="serviceAccount:${VIDEO_SA}" \
  --role="roles/secretmanager.secretAccessor"
```

Now open the MP4 in Google Drive, choose **Share**, add the value of `VIDEO_SA`, and grant **Viewer**. Keep general access restricted.

Deploy the service from this directory:

```bash
gcloud run deploy hismar-video \
  --source . \
  --region REGION \
  --service-account "${VIDEO_SA}" \
  --allow-unauthenticated \
  --timeout 3600 \
  --memory 512Mi \
  --cpu 1 \
  --concurrency 10 \
  --max-instances 3 \
  --set-env-vars "VIDEO_FILE_ID=1SIvbM4V1IljuFx4m0h5Q-hRlcCR_-_Ad,HISMAR_APPS_SCRIPT_URL=https://script.google.com/macros/s/AKfycbw65iyi4m1X3Bu1KIrcJwiQCnqQ83odteQc2MtEYnkEjHCiVqQV6sIVwJoUYrCQFR2ALQ/exec,ALLOWED_ORIGINS=APP_ORIGIN" \
  --set-secrets "PLAYBACK_SIGNING_SECRET=hismar-video-signing-secret:latest"
```

Replace `APP_ORIGIN` with the exact origin of Hismar Check (scheme + hostname only, no path). For example, if the site address is `https://h1samu.github.io/okk/`, the origin is `https://h1samu.github.io`. If the app uses a custom domain, use that domain instead.

Cloud Run will print a service URL such as `https://hismar-video-xxxxx-ew.a.run.app`. Copy it; it is needed in the frontend configuration.

## Verify HTTP Range before connecting the frontend

First check health:

```bash
curl -i "https://YOUR_CLOUD_RUN_URL/healthz"
```

After the frontend is connected and an employee has opened the training page, inspect the Network panel. The browser should request `/stream?ticket=...` and receive:

- `206 Partial Content` for a request containing `Range: bytes=...`
- `Content-Range: bytes START-END/TOTAL`
- `Accept-Ranges: bytes`
- `Content-Type: video/mp4`

A HEAD request should return `200` with the complete `Content-Length`. A missing/expired ticket should return `401`. Never share a playback ticket or paste it into issue trackers.

## Frontend connection

After Cloud Run is deployed, set `serviceUrl` in the repository root file `video-config.js` to the Cloud Run URL. Until then it stays empty and test.html keeps its existing Google Drive iframe, so the current training flow is not broken.

## Troubleshooting

- `video_storage_unavailable` / `drive_metadata_failed`: check Drive API enabled and that the runtime service account is a Viewer on the exact MP4.
- `auth_service_unavailable`: check `HISMAR_APPS_SCRIPT_URL` and that its deployment is accessible to server-side requests.
- `origin_not_allowed`: set `ALLOWED_ORIGINS` to the exact browser origin.
- `ticket_expired_or_invalid`: reopen the training page to mint a fresh ticket.
- If Range requests do not return 206, check the Drive API response and preserve the upstream `Content-Range`; do not buffer the entire file in Cloud Run.

## Cost and operational notes

Cloud Run is billed for active compute/request use; Drive API usage and outbound network transfer also apply. The service does not persist video copies or buffer the complete MP4 in memory. Monitor Cloud Run request counts, instance count, and Drive API quota if many employees watch simultaneously.
