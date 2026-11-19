# Clients poll for updates; the server doesn't push

Updates need to reach clients within hours, not seconds. Clients sit behind NATs,
firewalls and sleeping laptops. So clients poll a manifest URL, hourly by default with
±10% jitter, and back off exponentially when requests fail.

Polling keeps the server stateless. It only serves two kinds of static file, the manifest
and the artifacts, so in production it could be replaced by an S3 bucket behind a CDN with
no code changes. The jitter stops a fleet whose clocks are aligned, for example after a
mass reboot, from hitting the server at the same moment.

## Considered options

- **Server push over WebSockets or SSE**: faster delivery, but the server has to hold a
  connection per client, handle reconnects, and scale with the fleet. It still needs a
  polling fallback for clients that were offline when the push went out.
- **OS package managers or app stores**: these don't exist uniformly across the three
  target OSes, and they take control of the release cadence away from us.

## Consequences

- The delay before a client picks up a release is bounded by the poll interval. For the
  demo and tests, the interval is configurable down to seconds.
- An unreachable server is a normal condition. The program keeps running its current
  version and tries again later.
