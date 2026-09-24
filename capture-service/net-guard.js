'use strict';

/**
 * Refuse to fetch things that live inside the network the service runs on.
 *
 * A capture service takes a URL from a stranger and fetches it with the
 * machine's own credentials and network position. Deployed, that is a
 * server-side request forgery primitive: cloud metadata at 169.254.169.254,
 * anything on a private subnet, the loopback interface. Page assets are just as
 * dangerous as the page URL, because the page chooses them.
 *
 * Run locally this is all switched off: it is the user's own machine, and
 * capturing http://localhost:3000 is the main reason to run it there.
 */

const dns = require('dns').promises;
const net = require('net');

const ENFORCE = !!process.env.VERCEL || process.env.BLOCK_PRIVATE_HOSTS === '1';

function isPrivateV4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(isNaN)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||          // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // carrier NAT
    a >= 224;                             // multicast / reserved
}

function isPrivateV6(ip) {
  const s = ip.toLowerCase();
  if (s === '::' || s === '::1') return true;
  if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true;
  // IPv4-mapped, e.g. ::ffff:169.254.169.254
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) return isPrivateV4(m[1]);
  return false;
}

function isPrivateAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return true; // unparseable: refuse
}

/** Throws if the URL is not safe to fetch from this host. */
async function assertFetchable(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (e) {
    throw new Error('That is not a valid URL.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http and https addresses can be captured.');
  }
  if (!ENFORCE) return u;

  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.localhost|.*\.internal|.*\.local)$/i.test(host)) {
    throw new Error('That address is on a private network, which this service will not reach.');
  }
  // Resolve, because a public name can point at a private address on purpose.
  let addrs;
  try {
    addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  } catch (e) {
    throw new Error('That domain could not be reached. Check the URL.');
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error('That address is on a private network, which this service will not reach.');
  }
  return u;
}

module.exports = { assertFetchable, isPrivateAddress, ENFORCE };
