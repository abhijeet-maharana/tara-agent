import { BlockList, isIPv4, isIPv6 } from 'node:net';

/**
 * Who may use the HTTP server, as CIDR ranges ("127.0.0.0/8", "100.64.0.0/10", "fd7a:115c:a1e0::/48").
 * Returns a check for a socket's remote address.
 */
export function allowList(cidrs: string[]): (address: string | undefined) => boolean {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address = '', bits] = cidr.split('/');
    const family = isIPv6(address) ? 'ipv6' : 'ipv4';
    if (!isIPv4(address) && !isIPv6(address)) throw new Error(`Not an IP range: "${cidr}"`);
    if (bits === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(bits), family);
  }
  return (address) => {
    if (!address) return false;
    // IPv4 clients of a dual-stack socket show up as ::ffff:a.b.c.d.
    const ip = address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
    return list.check(ip, isIPv4(ip) ? 'ipv4' : 'ipv6');
  };
}
