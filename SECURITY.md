# Security

The default edition uses independent persistent storage and native runtime per anonymous browser identity. No PIN is required. Random 256-bit visitor IDs are HMAC-signed with a deployment-specific secret and stored in HttpOnly / SameSite=Strict cookies (Secure when PUBLIC_ORIGIN uses HTTPS).

Use HTTPS and the exact PUBLIC_ORIGIN. Preserve Host, WebSocket, SSE and Cookie headers; never cache user requests. Internal visitor listeners bind to loopback and require a separate gateway secret. The browser cannot select another storage directory or override the internal identity.

Cookie possession grants access to that workspace. Clearing it or losing the signing secret prevents automatic recovery. Back up the signing secret with the stopped-service data, including manuscripts, sessions, images, credentials and settings. Operators can access server files; this is not end-to-end encryption. Visitors configure their own model keys; no deployment-wide paid key is inherited.

Resident processes are bounded. This small-deployment design does not claim resistance to all anonymous resource abuse or long-term stability. Upstream Computer is a pinned preview dependency.

Legacy private/PIN deployment code is not activated by npm start. Never publish data/, databases, backups, environment files, PIN state, owner keys, cookies or credentials. Report vulnerabilities privately to the repository owner without including manuscripts or secrets.
