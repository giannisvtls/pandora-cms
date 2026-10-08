# pandora-cms

Payload CMS 3 with Postgres, and media in MinIO through the S3 API. It holds the website's content
and serves the admin panel and the REST API; the static site renders every page.

Requires Node 24, npm and Docker (for the local Postgres + MinIO stack in `docker-compose.yml`).
