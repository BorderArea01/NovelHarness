import { randomBytes, createHmac, timingSafeEqual, createHash } from 'node:crypto';

export function visitorIdentity(secret, deployment) {
  const name = 'novelharness_' + deployment;
  const mac = (value) => createHmac('sha256', secret).update(value).digest('hex');
  return {
    name,
    issue: () => {
      const id = randomBytes(32).toString('hex');
      return id + '.' + mac(id);
    },
    read(header = '') {
      const matches = header
        .split(';')
        .map((v) => v.trim())
        .filter((v) => v.startsWith(name + '='));
      if (matches.length !== 1) return null;
      const value = matches[0].slice(name.length + 1);
      if (!/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(value)) return null;
      const [id, signature] = value.split('.');
      return timingSafeEqual(Buffer.from(signature), Buffer.from(mac(id))) ? id : null;
    },
    cookie: (value, secure) =>
      name +
      '=' +
      value +
      '; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000' +
      (secure ? '; Secure' : ''),
  };
}

export function checkOrigin(req, origin) {
  const expected = new URL(origin);
  return (
    req.headers.host === expected.host &&
    (!req.headers.origin || req.headers.origin === origin) &&
    req.headers['sec-fetch-site'] !== 'cross-site' &&
    typeof req.url === 'string' &&
    req.url.startsWith('/') &&
    !req.url.startsWith('//')
  );
}

// Cookies are host-scoped, not port-scoped. Give each private data directory
// its own cookie names so a LAN test service cannot log out the formal site.
export function sharedCookies(ownerKey, legacyNames, scope) {
  if (typeof scope !== 'string' || !scope) throw new Error('Private cookies require a data-directory scope.');
  if (
    legacyNames &&
    ![
      ['dsh_edge_owner', 'novel_pin'],
      ['novel_stage_owner', 'novel_stage_pin'],
    ].some((pair) => JSON.stringify(pair) === JSON.stringify(legacyNames))
  )
    throw new Error('Unrecognized legacy cookie namespace.');
  const suffix = createHash('sha256').update(ownerKey).update('\0').update(scope).digest('hex').slice(0, 16);
  const inner = ['dsh_edge_owner', 'novel_pin'];
  const names = ['novelharness_owner_' + suffix, 'novelharness_pin_' + suffix];
  const prefix = (secure) => (secure ? '__Host-' : '');
  function read(header, name) {
    const rows = header
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v.startsWith(name + '='));
    return { present: rows.length > 0, value: rows.length === 1 ? rows[0].slice(name.length + 1) : '' };
  }
  return {
    read(header = '', secure = false) {
      let values = names.map((n) => read(header, prefix(secure) + n));
      if (legacyNames && values.every((v) => !v.present))
        values = legacyNames.map((n) => read(header, prefix(secure) + n));
      return values.map((v, i) => inner[i] + '=' + v.value).join('; ');
    },
    write(value, secure = false) {
      const index = inner.findIndex((n) => value.startsWith(n + '='));
      if (index < 0) return []; // Never expose a native carrier cookie.
      let next = prefix(secure) + names[index] + value.slice(inner[index].length);
      if (secure && !/;\s*Secure(?:;|$)/i.test(next)) next += '; Secure';
      return [
        next,
        ...(legacyNames
          ? [
              prefix(secure) +
                legacyNames[index] +
                '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' +
                (secure ? '; Secure' : ''),
            ]
          : []),
      ];
    },
  };
}
