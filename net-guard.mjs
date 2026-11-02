/**
 * net-guard.mjs — the addresses this tool is allowed to fetch.
 *
 * The builder is given URLs by a person (or by a pasted list of them) and it
 * prints whatever comes back. A list that names this machine, a router on the
 * local network, or a cloud instance's credential endpoint would turn a
 * catalogue scraper into a way of reading the owner's own network. So the check
 * lives here, in one dependency-free module, and every fetch path uses it.
 */

/** True for hosts it is safe to request; false for loopback, private, link-local, metadata and template junk. */
export function isPublicHost(host) {
  // Local fixture sites are how this tool gets tested without visiting anyone
  // else's server, so the guard can be stood down on purpose — never by default.
  if (process.env.BUILDER_ALLOW_PRIVATE === '1') return true
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return false
  if (h.includes('$')) return false // '$sub.niadd.com' style template leftovers
  if (h === 'localhost' || /(\.local|\.localhost|\.internal|\.test)$/.test(h)) return false
  if (h.includes(':')) {
    if (h === '::' || h === '::1' || /^(f[cd]|fe80)[0-9a-f]*:/.test(h)) return false
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h) // IPv4 written as IPv6
    if (mapped) return isPublicHost(mapped[1])
    return true
  }
  if (!/^[a-z0-9.-]*[a-z][a-z0-9.-]*$/.test(h)) return false
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!v4) return true
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  if (v4.slice(1).some((n) => Number(n) > 255)) return false
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 169 && b === 254) return false // includes 169.254.169.254 (instance metadata)
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 100 && b >= 64 && b <= 127) return false // carrier-grade NAT
  return true
}

/** Same question asked about a whole URL; false when the URL is unparseable. */
export function isPublicUrl(url) {
  try {
    const u = new URL(String(url))
    return /^https?:$/.test(u.protocol) && isPublicHost(u.hostname)
  } catch {
    return false
  }
}
